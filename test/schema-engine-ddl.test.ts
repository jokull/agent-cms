import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { ulid } from "ulidx";
import {
  generateSchema,
  createTableFromSchema,
  type ModelRow,
  type FieldRow,
} from "../src/schema-engine/index.js";

function makeModel(overrides: Partial<ModelRow> & { apiKey: string }): ModelRow {
  return {
    id: overrides.id ?? `model_${overrides.apiKey}`,
    name: overrides.name ?? overrides.apiKey,
    apiKey: overrides.apiKey,
    isBlock: overrides.isBlock ?? false,
    singleton: overrides.singleton ?? false,
    sortable: overrides.sortable ?? false,
    tree: overrides.tree ?? false,
    hasDraft: overrides.hasDraft ?? true,
  };
}

function makeField(
  overrides: Partial<FieldRow> & { modelId: string; apiKey: string; fieldType: string }
): FieldRow {
  return {
    id: overrides.id ?? `field_${overrides.apiKey}`,
    modelId: overrides.modelId,
    label: overrides.label ?? overrides.apiKey,
    apiKey: overrides.apiKey,
    fieldType: overrides.fieldType,
    position: overrides.position ?? 0,
    localized: overrides.localized ?? false,
    validators: overrides.validators ?? {},
  };
}

describe("Schema Engine DDL", () => {
  let db: ReturnType<typeof drizzle>;

  beforeEach(() => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    db = drizzle(sqlite);
  });

  it("creates a content table and inserts/reads records", () => {
    const models = [makeModel({ apiKey: "post" })];
    const fields = [
      makeField({ modelId: "model_post", apiKey: "title", fieldType: "string", position: 0 }),
      makeField({ modelId: "model_post", apiKey: "published", fieldType: "boolean", position: 1 }),
      makeField({ modelId: "model_post", apiKey: "views", fieldType: "integer", position: 2 }),
    ];

    const schema = generateSchema(models, fields);
    const table = schema.tables.get("post")!;
    createTableFromSchema(db, table);

    const now = new Date().toISOString();
    const id = ulid();
    db.insert(table).values({
      id,
      _status: "draft",
      _createdAt: now,
      _updatedAt: now,
      title: "Hello World",
      published: true,
      views: 42,
    }).run();

    const result = db.select().from(table).where(eq(table.id, id)).get() as any;
    expect(result.title).toBe("Hello World");
    expect(result.published).toBe(true);
    expect(result.views).toBe(42);
    expect(result._status).toBe("draft");
  });

  it("creates a block table and inserts/reads blocks", () => {
    const models = [makeModel({ apiKey: "hero_section", isBlock: true })];
    const fields = [
      makeField({ modelId: "model_hero_section", apiKey: "headline", fieldType: "string" }),
      makeField({ modelId: "model_hero_section", apiKey: "cta_url", fieldType: "string" }),
    ];

    const schema = generateSchema(models, fields);
    const table = schema.tables.get("hero_section")!;
    createTableFromSchema(db, table);

    const blockId = ulid();
    const rootId = ulid();
    db.insert(table).values({
      id: blockId,
      _rootRecordId: rootId,
      _rootFieldApiKey: "content",
      headline: "Welcome to our site",
      cta_url: "https://example.com",
    }).run();

    const result = db.select().from(table).where(eq(table.id, blockId)).get() as any;
    expect(result.headline).toBe("Welcome to our site");
    expect(result.cta_url).toBe("https://example.com");
    expect(result._rootRecordId).toBe(rootId);
    expect(result._rootFieldApiKey).toBe("content");
  });

  it("handles structured_text JSON field roundtrip", () => {
    const models = [makeModel({ apiKey: "page" })];
    const fields = [
      makeField({ modelId: "model_page", apiKey: "content", fieldType: "structured_text" }),
    ];

    const schema = generateSchema(models, fields);
    const table = schema.tables.get("page")!;
    createTableFromSchema(db, table);

    const now = new Date().toISOString();
    const id = ulid();
    const dast = {
      schema: "dast",
      document: {
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [{ type: "span", value: "Hello world" }],
          },
        ],
      },
    };

    db.insert(table).values({
      id,
      _createdAt: now,
      _updatedAt: now,
      content: dast,
    }).run();

    const result = db.select().from(table).where(eq(table.id, id)).get() as any;
    expect(result.content).toEqual(dast);
    expect(result.content.document.children[0].type).toBe("paragraph");
  });

  it("handles media_gallery JSON array field roundtrip", () => {
    const models = [makeModel({ apiKey: "recipe" })];
    const fields = [
      makeField({ modelId: "model_recipe", apiKey: "photos", fieldType: "media_gallery" }),
    ];

    const schema = generateSchema(models, fields);
    const table = schema.tables.get("recipe")!;
    createTableFromSchema(db, table);

    const now = new Date().toISOString();
    const id = ulid();
    const assetIds = [ulid(), ulid(), ulid()];

    db.insert(table).values({
      id,
      _createdAt: now,
      _updatedAt: now,
      photos: assetIds,
    }).run();

    const result = db.select().from(table).where(eq(table.id, id)).get() as any;
    expect(result.photos).toEqual(assetIds);
    expect(result.photos).toHaveLength(3);
  });

  it("creates multiple tables and they don't interfere", () => {
    const models = [
      makeModel({ apiKey: "post" }),
      makeModel({ apiKey: "author" }),
    ];
    const fields = [
      makeField({ modelId: "model_post", apiKey: "title", fieldType: "string" }),
      makeField({ modelId: "model_author", apiKey: "name", fieldType: "string" }),
    ];

    const schema = generateSchema(models, fields);
    for (const [, table] of schema.tables) {
      createTableFromSchema(db, table);
    }

    const now = new Date().toISOString();
    const postTable = schema.tables.get("post")!;
    const authorTable = schema.tables.get("author")!;

    db.insert(postTable).values({ id: ulid(), _createdAt: now, _updatedAt: now, title: "Post 1" }).run();
    db.insert(authorTable).values({ id: ulid(), _createdAt: now, _updatedAt: now, name: "Author 1" }).run();

    const posts = db.select().from(postTable).all() as any[];
    const authors = db.select().from(authorTable).all() as any[];

    expect(posts).toHaveLength(1);
    expect(posts[0].title).toBe("Post 1");
    expect(authors).toHaveLength(1);
    expect(authors[0].name).toBe("Author 1");
  });
});
