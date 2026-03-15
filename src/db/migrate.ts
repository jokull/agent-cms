import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * Run system table migrations via @effect/sql.
 * Reads migration SQL files from the drizzle/ directory and executes them.
 */
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
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
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
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

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
