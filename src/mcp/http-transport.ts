import { createStatelessMcpHandler, type CreateMcpLayerOptions } from "./server.js";

/**
 * Create a Web Standard handler for the stateless MCP server (2026-07-28).
 *
 * The stateless protocol is plain JSON-RPC 2.0 over HTTP POST — no sessions,
 * no initialize handshake — so the handler is a direct `Request -> Response`
 * function wired through the same Effect layer graph as the rest of the CMS.
 */
export function createMcpHttpHandler(
  sqlLayer: Parameters<typeof createStatelessMcpHandler>[0],
  options?: CreateMcpLayerOptions,
): (request: Request) => Promise<Response> {
  return createStatelessMcpHandler(sqlLayer, options);
}
