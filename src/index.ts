import { Hono } from "hono";
import type { Env } from "./types.js";

const app = new Hono<{ Bindings: Env }>();

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// REST Management API (TODO: P0.5+)
// app.route("/api", managementApi);

// GraphQL Content Delivery API (TODO: P0.10+)
// app.route("/graphql", graphqlHandler);

export default app;
