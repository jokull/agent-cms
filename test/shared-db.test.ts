import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { runMigrations } from "../src/db/migrate.js";

// Pure @effect/sql test layer — no Drizzle needed
const TestSqlLayer = SqliteClient.layer({ filename: ":memory:" });

function run<A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) {
  return Effect.runPromise(effect.pipe(Effect.provide(TestSqlLayer)));
}

describe("@effect/sql with system table migrations", () => {
  it("runs migrations and creates system tables", async () => {
    await run(
      Effect.gen(function* () {
        yield* runMigrations("./drizzle");

        const tables = yield* SqlClient.SqlClient.pipe(
          Effect.flatMap((sql) =>
            sql.unsafe<{ name: string }>(
              "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            )
          )
        );

        const tableNames = tables.map((t) => t.name);
        expect(tableNames).toContain("models");
        expect(tableNames).toContain("fields");
        expect(tableNames).toContain("fieldsets");
        expect(tableNames).toContain("locales");
        expect(tableNames).toContain("assets");
      })
    );
  });

  it("system table CRUD + dynamic table creation in same DB", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations("./drizzle");

        // Insert a model via @effect/sql
        const now = new Date().toISOString();
        yield* sql.unsafe(
          `INSERT INTO models (id, name, api_key, is_block, singleton, sortable, tree, has_draft, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ["m1", "Post", "post", 0, 0, 0, 0, 1, now, now]
        );

        // Read it back
        const models = yield* sql.unsafe<{ id: string; api_key: string }>(
          "SELECT * FROM models"
        );
        expect(models).toHaveLength(1);
        expect(models[0].api_key).toBe("post");

        // Create a dynamic content table
        yield* sql.unsafe(`
          CREATE TABLE content_post (
            id TEXT PRIMARY KEY,
            _status TEXT NOT NULL DEFAULT 'draft',
            _created_at TEXT NOT NULL,
            _updated_at TEXT NOT NULL,
            title TEXT,
            views INTEGER
          )
        `);

        // Insert and read a record
        yield* sql.unsafe(
          "INSERT INTO content_post (id, _status, _created_at, _updated_at, title, views) VALUES (?, ?, ?, ?, ?, ?)",
          ["r1", "draft", now, now, "Hello World", 42]
        );

        const records = yield* sql.unsafe<{ title: string; views: number }>(
          "SELECT * FROM content_post"
        );
        expect(records).toHaveLength(1);
        expect(records[0].title).toBe("Hello World");
        expect(records[0].views).toBe(42);
      })
    );
  });
});
