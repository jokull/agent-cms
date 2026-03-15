import { Hono } from "hono";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../src/db/schema.js";
import { modelsApi } from "../src/api/models.js";
import { fieldsApi } from "../src/api/fields.js";
import { recordsApi } from "../src/api/records.js";

/**
 * Create a test app with an in-memory SQLite database.
 * Returns the Hono app and the Drizzle DB instance for direct inspection.
 */
export function createTestApp() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./drizzle" });

  const app = new Hono();

  // Inject DB into context (same pattern as production but with better-sqlite3)
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.route("/api/models", modelsApi);
  app.route("/api/models/:modelId/fields", fieldsApi);
  app.route("/api/records", recordsApi);

  return { app, db };
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
