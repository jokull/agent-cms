import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createWebHandler } from "../src/http/router.js";

export async function createTestMcpClient(sqlLayer: any) {
  const handler = createWebHandler(sqlLayer, { writeKey: "write-key" }).fetch;
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    requestInit: { headers: { Authorization: "Bearer write-key" } },
    fetch: (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      return handler(new Request(url, init));
    },
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

export function parseToolResult(response: any): any {
  if (response.isError) {
    throw new Error(`MCP tool error: ${response.content[0]?.text}`);
  }
  const text = response.content[0]?.text;
  if (!text) return null;
  return JSON.parse(text);
}
