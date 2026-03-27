/**
 * Code Mode MCP endpoint.
 *
 * Wraps the agent-cms MCP tools with Cloudflare's Code Mode — the LLM
 * generates JS that chains tool calls in a V8 sandbox instead of making
 * individual MCP tool calls.
 *
 * Architecture:
 * - Tool metadata is read directly from the Effect toolkit (no MCP protocol needed)
 * - Tool calls are proxied through the existing MCP HTTP handler with proper
 *   session management (initialize → tools/call within a single SSE session)
 * - The SDK McpServer is wrapped with codeMcpServer() for V8 sandbox execution
 */
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { codeMcpServer } from "@cloudflare/codemode/mcp";
import { getToolMeta } from "./server.js";

export interface CreateCodeModeHandlerOptions {
  /** WorkerLoader binding from wrangler worker_loaders config */
  readonly loader: unknown;
  /** The MCP HTTP handler function (request: Request) => Promise<Response> */
  readonly mcpHandler: (request: Request) => Promise<Response>;
  /** "admin" or "editor" mode */
  readonly mode?: "admin" | "editor";
  /** The path the MCP handler serves at (default: "/mcp") */
  readonly mcpPath?: string;
}

/**
 * Create a Code Mode MCP server.
 *
 * Reads tool metadata directly from the Effect toolkit and builds a
 * standard SDK McpServer that proxies tool calls through the existing
 * MCP HTTP handler. Wraps with codeMcpServer() for Code Mode execution.
 */
export async function createCodeModeMcpServer(
  options: CreateCodeModeHandlerOptions,
): Promise<SdkMcpServer> {
  const mode = options.mode ?? "admin";
  const tools = getToolMeta(mode);

  // Build SDK McpServer with tool metadata from Effect toolkit
  const sdkServer = new SdkMcpServer({
    name: mode === "editor" ? "agent-cms-editor-codemode" : "agent-cms-codemode",
    version: "0.1.0",
  });

  // Register a dummy tool to declare tools capability, then override handlers
  sdkServer.tool("_init", "placeholder", async () => ({
    content: [{ type: "text" as const, text: "" }],
  }));

  // Override tools/list to return our toolkit's tools directly
  sdkServer.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // Override tools/call to proxy through the MCP HTTP handler.
  // Each call does a fresh initialize → tools/call within one SSE session.
  const mcpPath = options.mcpPath ?? "/mcp";
  sdkServer.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await callToolViaMcp(
      options.mcpHandler,
      mcpPath,
      request.params.name,
      (request.params.arguments ?? {}) as Record<string, unknown>,
    );
    return result;
  });

  // Wrap with Code Mode
  const executor = new DynamicWorkerExecutor({
    loader: options.loader as never,
  });

  return codeMcpServer({ server: sdkServer, executor });
}

/**
 * Call a tool via the MCP HTTP handler.
 * The Effect MCP handler is stateless — no init needed, just call directly.
 */
async function callToolViaMcp(
  mcpHandler: (request: Request) => Promise<Response>,
  mcpPath: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const url = `http://localhost${mcpPath}`;
  const callRequest = new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });

  const callResponse = await mcpHandler(callRequest);
  const text = await callResponse.text();

  return parseToolCallResponse(1, text, callResponse.headers.get("content-type"));
}

function parseToolCallResponse(
  requestId: number,
  text: string,
  contentType: string | null,
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  // Helper to extract result from a parsed JSON-RPC response or array of responses
  function extractResult(parsed: unknown): { content: Array<{ type: "text"; text: string }>; isError?: boolean } | null {
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const r = extractResult(item);
        if (r) return r;
      }
      return null;
    }
    if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      if (obj.id === requestId && obj.result !== undefined) {
        return obj.result as { content: Array<{ type: "text"; text: string }>; isError?: boolean };
      }
      if (obj.id === requestId && obj.error) {
        return {
          content: [{ type: "text", text: JSON.stringify(obj.error) }],
          isError: true,
        };
      }
    }
    return null;
  }

  if (contentType?.includes("text/event-stream")) {
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.startsWith("data: ")) {
        try {
          const parsed = JSON.parse(line.slice(6));
          const result = extractResult(parsed);
          if (result) return result;
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }
  }

  // Try plain JSON
  try {
    const parsed = JSON.parse(text);
    const result = extractResult(parsed);
    if (result) return result;
  } catch {
    // Fall through
  }

  return {
    content: [{ type: "text", text: `Failed to parse MCP response: ${text.slice(0, 200)}` }],
    isError: true,
  };
}
