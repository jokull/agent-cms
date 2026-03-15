import { Hono } from "hono";
import { D1Client } from "@effect/sql-d1";
import type { Env } from "./types.js";
import { modelsApi } from "./api/models.js";
import { fieldsApi } from "./api/fields.js";
import { recordsApi } from "./api/records.js";
import { createGraphQLHandler } from "./graphql/handler.js";

const app = new Hono<{ Bindings: Env; Variables: { sqlLayer: any } }>();

// Health check (no DB needed)
app.get("/health", (c) => c.json({ status: "ok" }));

// DB middleware: create @effect/sql-d1 layer from D1 binding
app.use("/api/*", async (c, next) => {
  const sqlLayer = D1Client.layer({ db: c.env.DB });
  c.set("sqlLayer", sqlLayer);
  await next();
});

// REST Management API
app.route("/api/models", modelsApi);
app.route("/api/models/:modelId/fields", fieldsApi);
app.route("/api/records", recordsApi);

// GraphQL Content Delivery API
app.all("/graphql", async (c) => {
  const sqlLayer = D1Client.layer({ db: c.env.DB });
  const handler = createGraphQLHandler(sqlLayer);
  return handler(c.req.raw);
});

export default app;
