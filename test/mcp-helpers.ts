import { createWebHandler } from "../src/http/router.js";

/**
 * Minimal stateless MCP test client.
 *
 * The server speaks MCP 2026-07-28 (stateless core): plain JSON-RPC 2.0 over
 * HTTP POST with no sessions and no initialize handshake. The SDK `Client`
 * (which requires the removed initialize/session flow) is not used here;
 * this shim sends the raw wire requests and returns SDK-compatible shapes so
 * existing `callTool`/`parseToolResult` test code keeps working.
 */
export interface TestMcpClient {
  callTool(args: { name: string; arguments?: Record<string, unknown> }): Promise<{
    content: Array<{ type: "text"; text: string }>;
    structuredContent?: unknown;
    isError?: boolean;
  }>;
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  listResources(): Promise<{ resources: Array<{ uri: string }> }>;
  readResource(args: { uri: string }): Promise<{ contents: Array<{ uri: string }> }>;
  listPrompts(): Promise<{ prompts: Array<{ name: string }> }>;
}

export async function createTestMcpClient(
  sqlLayer: any,
  options?: {
    path?: "/mcp" | "/mcp/editor";
    token?: string;
    /** Override the web handler (e.g. to inject r2Bucket/images/siteUrl options). */
    handler?: (req: Request) => Promise<Response>;
  },
): Promise<{ client: TestMcpClient; transport: { close(): Promise<void> } }> {
  const handler = options?.handler ?? createWebHandler(sqlLayer, { writeKey: "write-key" }).fetch;
  const path = options?.path ?? "/mcp";
  const token = options?.token ?? "write-key";
  let nextId = 1;

  async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
    const res = await handler(new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method,
        params: {
          ...params,
          _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
        },
      }),
    }));
    const json: any = await res.json();
    if (json.error) {
      throw new Error(`MCP ${method} error ${json.error.code}: ${json.error.message}`);
    }
    return json.result;
  }

  const client: TestMcpClient = {
    async callTool({ name, arguments: args }) {
      const result = await rpc("tools/call", { name, arguments: args ?? {} });
      return {
        content: result.content,
        structuredContent: result.structuredContent,
        isError: result.isError,
      };
    },
    async listTools() {
      const result = await rpc("tools/list", {});
      return { tools: result.tools };
    },
    async listResources() {
      const result = await rpc("resources/list", {});
      return { resources: result.resources };
    },
    async readResource({ uri }) {
      const result = await rpc("resources/read", { uri });
      return { contents: result.contents };
    },
    async listPrompts() {
      const result = await rpc("prompts/list", {});
      return { prompts: result.prompts };
    },
  };

  return { client, transport: { close: async () => {} } };
}

export function parseToolResult(response: any): any {
  if (response.isError) {
    throw new Error(`MCP tool error: ${response.content[0]?.text}`);
  }
  const text = response.content[0]?.text;
  if (!text) return null;
  return JSON.parse(text);
}
