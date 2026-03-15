import { Hono } from "hono";
import { Effect, Layer } from "effect";
import { SqlClient } from "@effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { modelsApi } from "../src/api/models.js";
import { fieldsApi } from "../src/api/fields.js";
import { recordsApi } from "../src/api/records.js";
import { createGraphQLHandler } from "../src/graphql/handler.js";
import { runMigrations } from "../src/db/migrate.js";

/**
 * Create a test app with an in-memory SQLite database via @effect/sql.
 * Returns the Hono app and the SQL layer for direct inspection.
 */
export function createTestApp() {
  const sqlLayer = SqliteClient.layer({ filename: ":memory:" });

  // Run migrations synchronously at setup time
  Effect.runSync(
    runMigrations("./drizzle").pipe(Effect.provide(sqlLayer))
  );

  const app = new Hono();

  // Inject SQL layer into Hono context
  app.use("*", async (c, next) => {
    c.set("sqlLayer", sqlLayer);
    await next();
  });

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.route("/api/models", modelsApi);
  app.route("/api/models/:modelId/fields", fieldsApi);
  app.route("/api/records", recordsApi);

  // GraphQL endpoint (uses @effect/sql via the layer)
  app.all("/graphql", async (c) => {
    // Build the handler with the sql layer for resolvers
    const handler = createGraphQLHandler(sqlLayer);
    const response = await handler(c.req.raw);
    return response;
  });

  return { app, sqlLayer };
}

/** Helper to execute a GraphQL query */
export async function gqlQuery(
  app: Hono,
  query: string,
  variables?: Record<string, any>
) {
  const res = await app.request("/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return res.json() as Promise<{ data?: any; errors?: any[] }>;
}

/** Helper to make JSON requests against the test app */
export async function jsonRequest(
  app: Hono,
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
  return app.request(path, init);
}
