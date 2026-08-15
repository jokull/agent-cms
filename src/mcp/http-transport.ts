import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { createMcpLayer, type CreateMcpLayerOptions } from "./server.js";
import { VectorizeContext } from "../search/vectorize-context.js";
import { HooksContext } from "../hooks.js";

/**
 * Create a cached Web Standard handler for the Effect-native MCP server.
 */
export function createMcpHttpHandler(
  sqlLayer: Layer.Layer<SqlClient.SqlClient | VectorizeContext | HooksContext>,
  options?: CreateMcpLayerOptions,
) {
  // Effect AI's MCP layer composes correctly at runtime, but current Layer inference
  // widens the remaining router requirement to `unknown` at this boundary.
  // Keep the cast here instead of weakening the typed MCP handlers and tool payloads.
  const mcpLayer = createMcpLayer(sqlLayer, options) as Layer.Layer<unknown, never, HttpRouter.HttpRouter>;
  const { handler } = HttpRouter.toWebHandler(mcpLayer, {
    disableLogger: true,
  });
  return handler;
}
