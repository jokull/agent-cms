/**
 * MCP HTTP transport handler for Cloudflare Workers.
 * Uses the Web Standard Streamable HTTP transport from @modelcontextprotocol/sdk.
 *
 * Serves the MCP server at a given path (e.g. /mcp) using stateless mode —
 * each request is independent, no session management needed for Workers.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Create an HTTP handler for the MCP server.
 * Returns a function that handles Web Standard Request → Response.
 */
export function createMcpHttpHandler(createServer: () => McpServer) {
  return async (request: Request): Promise<Response> => {
    // Create a stateless transport for each request
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode
      enableJsonResponse: true, // Simpler for request/response tool calls
    });

    // Stateless Streamable HTTP requires a fresh server/transport pair per request.
    // Reusing a connected McpServer across requests breaks the initialize → initialized flow.
    const server = createServer();

    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } finally {
      await transport.close();
      await server.close();
    }
  };
}
