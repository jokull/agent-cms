import * as HttpLayerRouter from "@effect/platform/HttpLayerRouter";
import * as Layer from "effect/Layer";
import * as SqlClient from "@effect/sql/SqlClient";
import { createMcpLayer } from "./server.js";
import { VectorizeContext } from "../search/vectorize-context.js";
import { HooksContext } from "../hooks.js";

/**
 * Create a cached Web Standard handler for the Effect-native MCP server.
 */
export function createMcpHttpHandler(
  sqlLayer: Layer.Layer<SqlClient.SqlClient | VectorizeContext | HooksContext>,
) {
  const { handler } = HttpLayerRouter.toWebHandler(createMcpLayer(sqlLayer), {
    disableLogger: true,
  });
  return handler;
}
