/**
 * Test-only migration runner. Reads Drizzle migration SQL files from the
 * filesystem and executes them against an in-memory SQLite database.
 *
 * Production uses `wrangler d1 migrations apply` instead — the Worker
 * bundle never touches the filesystem.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

export function runMigrations(migrationsDir: string = "./drizzle") {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Create migrations tracking table
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS __drizzle_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    // Find migration directories (sorted by timestamp)
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((d: import("fs").Dirent) => d.isDirectory())
      .map((d: import("fs").Dirent) => d.name)
      .sort();

    for (const dir of dirs) {
      // Check if already applied
      const applied = yield* sql.unsafe<{ hash: string }>(
        "SELECT hash FROM __drizzle_migrations WHERE hash = ?",
        [dir]
      );
      if (applied.length > 0) continue;

      // Read and execute migration
      const migrationPath = join(migrationsDir, dir, "migration.sql");
      const migrationSql = readFileSync(migrationPath, "utf-8");

      // Split on statement breakpoints
      const statements = migrationSql
        .split("--> statement-breakpoint")
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0);

      for (const statement of statements) {
        yield* sql.unsafe(statement);
      }

      // Mark as applied
      yield* sql.unsafe(
        "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
        [dir, Date.now()]
      );
    }
  });
}
