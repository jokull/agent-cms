import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "@effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { runMigrations } from "../src/db/migrate.js";
import { createWebHandler } from "../src/http/router.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Create a test app with a unique SQLite database.
 * Uses ManagedRuntime to ensure the same database connection is shared
 * across all Effect.provide calls.
 */
export function createTestApp() {
  const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-test-"));
  const dbPath = join(tmpDir, "test.db");

  // Create a shared layer — use the same filename so connections share the database
  const sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });

  // Run migrations
  Effect.runSync(runMigrations("./drizzle").pipe(Effect.provide(sqlLayer)));

  const handler = createWebHandler(sqlLayer);

  return { handler, sqlLayer };
}

/** Execute a GraphQL query */
export async function gqlQuery(
  handler: (req: Request) => Promise<Response>,
  query: string,
  variables?: Record<string, any>
) {
  const res = await handler(
    new Request("http://localhost/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    })
  );
  return res.json() as Promise<{ data?: any; errors?: any[] }>;
}

/** Make JSON requests */
export async function jsonRequest(
  handler: (req: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: any
) {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return handler(new Request(`http://localhost${path}`, init));
}
