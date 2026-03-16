/**
 * Test-only migration runner. Reads .sql files from the migrations
 * directory and executes them against an in-memory SQLite database.
 *
 * Production uses `wrangler d1 migrations apply` instead — the Worker
 * bundle never touches the filesystem.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

export function runMigrations(migrationsDir: string = "./migrations") {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Find .sql files sorted by name
    const files = readdirSync(migrationsDir)
      .filter((f: string) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const migrationSql = readFileSync(join(migrationsDir, file), "utf-8");

      // Split on semicolons to handle multiple statements
      const statements = migrationSql
        .split(";")
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0);

      for (const statement of statements) {
        yield* sql.unsafe(statement);
      }
    }
  });
}
