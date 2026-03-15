import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import {
  generateSchema,
  migrateTable,
  dropTable,
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

function getTableColumns(db: ReturnType<typeof drizzle>, tableName: string) {
  return db.all(sql.raw(`PRAGMA table_info("${tableName}")`)) as {
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }[];
}

function tableExists(db: ReturnType<typeof drizzle>, tableName: string): boolean {
  const result = db.get(
    sql.raw(`SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}'`)
  );
  return result !== undefined;
}

describe("Schema Engine Migration", () => {
  let db: ReturnType<typeof drizzle>;

  beforeEach(() => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("journal_mode = WAL");
    db = drizzle(sqlite);
  });

  it("creates table when it does not exist", () => {
    const models = [makeModel({ apiKey: "post" })];
    const fields = [
      makeField({ modelId: "model_post", apiKey: "title", fieldType: "string" }),
    ];

    const schema = generateSchema(models, fields);
    const result = migrateTable(db, schema.tables.get("post")!);

    expect(result.created).toBe(true);
    expect(result.columnsAdded).toHaveLength(0);
    expect(result.columnsDropped).toHaveLength(0);
    expect(tableExists(db, "content_post")).toBe(true);
  });

  it("adds new columns when fields are added", () => {
    // Create initial table with one field
    const models = [makeModel({ apiKey: "post" })];
    const fieldsV1 = [
      makeField({ modelId: "model_post", apiKey: "title", fieldType: "string" }),
    ];

    const schemaV1 = generateSchema(models, fieldsV1);
    migrateTable(db, schemaV1.tables.get("post")!);

    // Add a new field
    const fieldsV2 = [
      ...fieldsV1,
      makeField({ modelId: "model_post", apiKey: "body", fieldType: "text", position: 1 }),
      makeField({ modelId: "model_post", apiKey: "views", fieldType: "integer", position: 2 }),
    ];

    const schemaV2 = generateSchema(models, fieldsV2);
    const result = migrateTable(db, schemaV2.tables.get("post")!);

    expect(result.created).toBe(false);
    expect(result.columnsAdded).toEqual(["body", "views"]);

    // Verify columns exist
    const cols = getTableColumns(db, "content_post");
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("title");
    expect(colNames).toContain("body");
    expect(colNames).toContain("views");
  });

  it("drops columns when fields are removed", () => {
    const models = [makeModel({ apiKey: "post" })];
    const fieldsV1 = [
      makeField({ modelId: "model_post", apiKey: "title", fieldType: "string" }),
      makeField({ modelId: "model_post", apiKey: "subtitle", fieldType: "string", position: 1 }),
      makeField({ modelId: "model_post", apiKey: "body", fieldType: "text", position: 2 }),
    ];

    const schemaV1 = generateSchema(models, fieldsV1);
    migrateTable(db, schemaV1.tables.get("post")!);

    // Remove subtitle
    const fieldsV2 = [
      makeField({ modelId: "model_post", apiKey: "title", fieldType: "string" }),
      makeField({ modelId: "model_post", apiKey: "body", fieldType: "text", position: 1 }),
    ];

    const schemaV2 = generateSchema(models, fieldsV2);
    const result = migrateTable(db, schemaV2.tables.get("post")!);

    expect(result.columnsDropped).toEqual(["subtitle"]);

    const cols = getTableColumns(db, "content_post");
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("title");
    expect(colNames).toContain("body");
    expect(colNames).not.toContain("subtitle");
  });

  it("preserves existing data when adding columns", () => {
    const models = [makeModel({ apiKey: "post" })];
    const fieldsV1 = [
      makeField({ modelId: "model_post", apiKey: "title", fieldType: "string" }),
    ];

    const schemaV1 = generateSchema(models, fieldsV1);
    migrateTable(db, schemaV1.tables.get("post")!);

    // Insert data
    const tableV1 = schemaV1.tables.get("post")!;
    const now = new Date().toISOString();
    const id = ulid();
    db.insert(tableV1).values({ id, _createdAt: now, _updatedAt: now, title: "My Post" }).run();

    // Add a field
    const fieldsV2 = [
      ...fieldsV1,
      makeField({ modelId: "model_post", apiKey: "body", fieldType: "text", position: 1 }),
    ];

    const schemaV2 = generateSchema(models, fieldsV2);
    migrateTable(db, schemaV2.tables.get("post")!);

    // Read back with new schema
    const tableV2 = schemaV2.tables.get("post")!;
    const result = db.select().from(tableV2).where(eq(tableV2.id, id)).get() as any;
    expect(result.title).toBe("My Post");
    expect(result.body).toBeNull(); // New column should be null
  });

  it("preserves existing data when dropping columns", () => {
    const models = [makeModel({ apiKey: "post" })];
    const fieldsV1 = [
      makeField({ modelId: "model_post", apiKey: "title", fieldType: "string" }),
      makeField({ modelId: "model_post", apiKey: "temp", fieldType: "string", position: 1 }),
    ];

    const schemaV1 = generateSchema(models, fieldsV1);
    migrateTable(db, schemaV1.tables.get("post")!);

    const tableV1 = schemaV1.tables.get("post")!;
    const now = new Date().toISOString();
    const id = ulid();
    db.insert(tableV1).values({ id, _createdAt: now, _updatedAt: now, title: "My Post", temp: "gone" }).run();

    // Remove temp field
    const fieldsV2 = [
      makeField({ modelId: "model_post", apiKey: "title", fieldType: "string" }),
    ];

    const schemaV2 = generateSchema(models, fieldsV2);
    migrateTable(db, schemaV2.tables.get("post")!);

    const tableV2 = schemaV2.tables.get("post")!;
    const result = db.select().from(tableV2).where(eq(tableV2.id, id)).get() as any;
    expect(result.title).toBe("My Post");
    expect(result).not.toHaveProperty("temp");
  });

  it("is idempotent — running migrate twice produces same result", () => {
    const models = [makeModel({ apiKey: "post" })];
    const fields = [
      makeField({ modelId: "model_post", apiKey: "title", fieldType: "string" }),
    ];

    const schema = generateSchema(models, fields);

    const result1 = migrateTable(db, schema.tables.get("post")!);
    expect(result1.created).toBe(true);

    const result2 = migrateTable(db, schema.tables.get("post")!);
    expect(result2.created).toBe(false);
    expect(result2.columnsAdded).toHaveLength(0);
    expect(result2.columnsDropped).toHaveLength(0);
  });

  it("drops a table", () => {
    const models = [makeModel({ apiKey: "post" })];
    const schema = generateSchema(models, []);
    migrateTable(db, schema.tables.get("post")!);

    expect(tableExists(db, "content_post")).toBe(true);
    dropTable(db, "content_post");
    expect(tableExists(db, "content_post")).toBe(false);
  });

  it("handles block table migration", () => {
    const models = [makeModel({ apiKey: "hero", isBlock: true })];
    const fieldsV1 = [
      makeField({ modelId: "model_hero", apiKey: "headline", fieldType: "string" }),
    ];

    const schemaV1 = generateSchema(models, fieldsV1);
    const result1 = migrateTable(db, schemaV1.tables.get("hero")!);
    expect(result1.created).toBe(true);

    // Add a field
    const fieldsV2 = [
      ...fieldsV1,
      makeField({ modelId: "model_hero", apiKey: "bg_image", fieldType: "media", position: 1 }),
    ];

    const schemaV2 = generateSchema(models, fieldsV2);
    const result2 = migrateTable(db, schemaV2.tables.get("hero")!);
    expect(result2.columnsAdded).toEqual(["bg_image"]);

    const cols = getTableColumns(db, "block_hero");
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("_root_record_id");
    expect(colNames).toContain("headline");
    expect(colNames).toContain("bg_image");
  });
});
