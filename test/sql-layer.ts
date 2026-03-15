/**
 * Test helper: create an @effect/sql SqlClient layer from a better-sqlite3
 * Database instance. This allows sharing the same in-memory database between
 * Drizzle (system tables) and @effect/sql (dynamic tables).
 */
import Database from "better-sqlite3";
import { Effect, Layer } from "effect";
import { SqlClient } from "@effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";

/**
 * Create a SqlClient layer backed by a temp file, plus a Drizzle DB
 * for system tables. Both point to the same database.
 *
 * Returns the Layer and a close function.
 */
export function createSharedSqlLayer(dbPath: string) {
  return SqliteClient.layer({
    filename: dbPath,
    disableWAL: true, // Avoid WAL lock conflicts with Drizzle connection
  });
}
