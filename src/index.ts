import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "./types.js";
import * as schema from "./db/schema.js";
import { modelsApi } from "./api/models.js";
import { fieldsApi } from "./api/fields.js";

const app = new Hono<{ Bindings: Env; Variables: { db: any } }>();

// Health check (no DB needed)
app.get("/health", (c) => c.json({ status: "ok" }));

// DB middleware for API routes only
app.use("/api/*", async (c, next) => {
  const db = drizzle(c.env.DB, { schema });
  c.set("db", db);
  await next();
});

// REST Management API
app.route("/api/models", modelsApi);
app.route("/api/models/:modelId/fields", fieldsApi);

export default app;
