import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { SqlClient } from "@effect/sql";
import {
  createContentTable,
  createBlockTable,
  migrateContentTable,
  dropTableSql,
  tableExists,
  getTableColumns,
} from "../src/schema-engine/sql-ddl.js";
import {
  insertRecord,
  selectAll,
  selectById,
  updateRecord,
  deleteRecord,
} from "../src/schema-engine/sql-records.js";

// In-memory SQLite layer for tests
const TestSqlLayer = SqliteClient.layer({ filename: ":memory:" });

/** Run an Effect with the test SQL layer */
function run<A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) {
  return Effect.runPromise(effect.pipe(Effect.provide(TestSqlLayer)));
}

describe("@effect/sql DDL operations", () => {
  it("creates a content table", async () => {
    await run(
      Effect.gen(function* () {
        yield* createContentTable("post", [
          { apiKey: "title", fieldType: "string" },
          { apiKey: "views", fieldType: "integer" },
          { apiKey: "published", fieldType: "boolean" },
        ]);

        const exists = yield* tableExists("content_post");
        expect(exists).toBe(true);

        const cols = yield* getTableColumns("content_post");
        const colNames = cols.map((c) => c.name);
        expect(colNames).toContain("id");
        expect(colNames).toContain("_status");
        expect(colNames).toContain("_created_at");
        expect(colNames).toContain("title");
        expect(colNames).toContain("views");
        expect(colNames).toContain("published");

        const sql = yield* SqlClient.SqlClient;
        const indexes = yield* sql.unsafe<{ name: string }>('PRAGMA index_list("content_post")');
        expect(indexes.some((i) => i.name === "idx_content_post_views")).toBe(true);
        expect(indexes.some((i) => i.name === "idx_content_post_title")).toBe(false);
      })
    );
  });

  it("creates composite indexes for link plus temporal fields", async () => {
    await run(
      Effect.gen(function* () {
        yield* createContentTable("entry", [
          { apiKey: "category", fieldType: "link" },
          { apiKey: "published_date", fieldType: "date" },
        ]);

        const sql = yield* SqlClient.SqlClient;
        const indexes = yield* sql.unsafe<{ name: string }>('PRAGMA index_list("content_entry")');
        expect(indexes.some((i) => i.name === "idx_content_entry_category_published_date")).toBe(true);
      })
    );
  });

  it("creates a block table", async () => {
    await run(
      Effect.gen(function* () {
        yield* createBlockTable("hero_section", [
          { apiKey: "headline", fieldType: "string" },
        ]);

        const cols = yield* getTableColumns("block_hero_section");
        const colNames = cols.map((c) => c.name);
        expect(colNames).toContain("id");
        expect(colNames).toContain("_root_record_id");
        expect(colNames).toContain("_root_field_api_key");
        expect(colNames).toContain("headline");
        expect(colNames).not.toContain("_status");

        const sql = yield* SqlClient.SqlClient;
        const indexes = yield* sql.unsafe<{ name: string }>('PRAGMA index_list("block_hero_section")');
        expect(indexes.some((i) => i.name === "idx_block_hero_section_lookup")).toBe(true);
      })
    );
  });

  it("adds the block lookup index for existing block tables during migration", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`
          CREATE TABLE "block_legacy_block" (
            "id" TEXT PRIMARY KEY,
            "_root_record_id" TEXT NOT NULL,
            "_root_field_api_key" TEXT NOT NULL,
            "_parent_container_model_api_key" TEXT NOT NULL,
            "_parent_block_id" TEXT,
            "_parent_field_api_key" TEXT NOT NULL,
            "_depth" INTEGER NOT NULL DEFAULT 0,
            "title" TEXT
          )
        `);

        yield* migrateContentTable("legacy_block", true, [
          { apiKey: "title", fieldType: "string" },
        ]);

        const indexes = yield* sql.unsafe<{ name: string }>('PRAGMA index_list("block_legacy_block")');
        expect(indexes.some((i) => i.name === "idx_block_legacy_block_lookup")).toBe(true);
      })
    );
  });

  it("migrates: creates table if missing", async () => {
    await run(
      Effect.gen(function* () {
        const result = yield* migrateContentTable("article", false, [
          { apiKey: "title", fieldType: "string" },
        ]);
        expect(result.created).toBe(true);
        expect(yield* tableExists("content_article")).toBe(true);
      })
    );
  });

  it("migrates: adds new columns", async () => {
    await run(
      Effect.gen(function* () {
        yield* migrateContentTable("article", false, [
          { apiKey: "title", fieldType: "string" },
        ]);

        const result = yield* migrateContentTable("article", false, [
          { apiKey: "title", fieldType: "string" },
          { apiKey: "body", fieldType: "text" },
        ]);

        expect(result.created).toBe(false);
        expect(result.columnsAdded).toEqual(["body"]);
      })
    );
  });

  it("migrates: drops removed columns", async () => {
    await run(
      Effect.gen(function* () {
        yield* migrateContentTable("article", false, [
          { apiKey: "title", fieldType: "string" },
          { apiKey: "temp", fieldType: "string" },
        ]);

        const result = yield* migrateContentTable("article", false, [
          { apiKey: "title", fieldType: "string" },
        ]);

        expect(result.columnsDropped).toEqual(["temp"]);
      })
    );
  });

  it("drops a table", async () => {
    await run(
      Effect.gen(function* () {
        yield* createContentTable("doomed", []);
        expect(yield* tableExists("content_doomed")).toBe(true);
        yield* dropTableSql("content_doomed");
        expect(yield* tableExists("content_doomed")).toBe(false);
      })
    );
  });
});

describe("@effect/sql record operations", () => {
  it("inserts and reads records", async () => {
    await run(
      Effect.gen(function* () {
        yield* createContentTable("post", [
          { apiKey: "title", fieldType: "string" },
          { apiKey: "views", fieldType: "integer" },
        ]);

        yield* insertRecord("content_post", {
          id: "rec_1",
          _status: "draft",
          _created_at: "2024-01-01",
          _updated_at: "2024-01-01",
          title: "Hello World",
          views: 42,
        });

        const all = yield* selectAll("content_post");
        expect(all).toHaveLength(1);
        expect(all[0].title).toBe("Hello World");
        expect(all[0].views).toBe(42);

        const one = yield* selectById("content_post", "rec_1");
        expect(one).not.toBeNull();
        expect(one!.title).toBe("Hello World");
      })
    );
  });

  it("updates records", async () => {
    await run(
      Effect.gen(function* () {
        yield* createContentTable("post", [
          { apiKey: "title", fieldType: "string" },
        ]);

        yield* insertRecord("content_post", {
          id: "rec_1",
          _status: "draft",
          _created_at: "2024-01-01",
          _updated_at: "2024-01-01",
          title: "Original",
        });

        yield* updateRecord("content_post", "rec_1", { title: "Updated" });

        const result = yield* selectById("content_post", "rec_1");
        expect(result!.title).toBe("Updated");
      })
    );
  });

  it("deletes records", async () => {
    await run(
      Effect.gen(function* () {
        yield* createContentTable("post", [
          { apiKey: "title", fieldType: "string" },
        ]);

        yield* insertRecord("content_post", {
          id: "rec_1",
          _status: "draft",
          _created_at: "2024-01-01",
          _updated_at: "2024-01-01",
          title: "Doomed",
        });

        yield* deleteRecord("content_post", "rec_1");

        const result = yield* selectById("content_post", "rec_1");
        expect(result).toBeNull();
      })
    );
  });

  it("handles JSON field roundtrip", async () => {
    await run(
      Effect.gen(function* () {
        yield* createContentTable("page", [
          { apiKey: "content", fieldType: "structured_text" },
          { apiKey: "photos", fieldType: "media_gallery" },
        ]);

        const dast = {
          schema: "dast",
          document: { type: "root", children: [{ type: "paragraph", children: [{ type: "span", value: "hello" }] }] },
        };
        const photos = ["asset_1", "asset_2"];

        yield* insertRecord("content_page", {
          id: "rec_1",
          _status: "draft",
          _created_at: "2024-01-01",
          _updated_at: "2024-01-01",
          content: dast,
          photos,
        });

        const result = yield* selectById("content_page", "rec_1");
        expect(result!.content).toEqual(dast);
        expect(result!.photos).toEqual(photos);
      })
    );
  });

  it("handles boolean field roundtrip", async () => {
    await run(
      Effect.gen(function* () {
        yield* createContentTable("post", [
          { apiKey: "published", fieldType: "boolean" },
        ]);

        yield* insertRecord("content_post", {
          id: "rec_1",
          _status: "draft",
          _created_at: "2024-01-01",
          _updated_at: "2024-01-01",
          published: true,
        });

        const result = yield* selectById("content_post", "rec_1");
        // SQLite stores boolean as 1/0 — we get it back as number
        expect(result!.published).toBe(1);
      })
    );
  });
});
