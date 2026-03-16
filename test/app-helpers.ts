import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "@effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { ensureSchema } from "../src/migrations.js";
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

  // Run embedded migrations (same as production auto-migration)
  Effect.runSync(ensureSchema().pipe(Effect.provide(sqlLayer)));

  const handler = createWebHandler(sqlLayer);

  return { handler, sqlLayer };
}

/**
 * Execute a GraphQL query.
 * By default, includes drafts (X-Include-Drafts: true) for test convenience.
 * Set includeDrafts: false to test published-only behavior.
 */
export async function gqlQuery(
  handler: (req: Request) => Promise<Response>,
  query: string,
  variables?: Record<string, any>,
  options?: { includeDrafts?: boolean }
) {
  const includeDrafts = options?.includeDrafts ?? true; // Default to true for tests
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (includeDrafts) {
    headers["X-Include-Drafts"] = "true";
  }
  const res = await handler(
    new Request("http://localhost/graphql", {
      method: "POST",
      headers,
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
