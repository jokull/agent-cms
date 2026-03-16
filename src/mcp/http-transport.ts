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
export function createMcpHttpHandler(server: McpServer) {
  return async (request: Request): Promise<Response> => {
    // Create a stateless transport for each request
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode
      enableJsonResponse: true, // Simpler for request/response tool calls
    });

    // Connect the MCP server to the transport
    await server.connect(transport);

    // Handle the request
    const response = await transport.handleRequest(request);

    return response;
  };
}
