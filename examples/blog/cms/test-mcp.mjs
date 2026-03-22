import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2] ?? process.env.MCP_URL ?? "http://127.0.0.1:8787/mcp";
const token = process.env.CMS_WRITE_KEY;

function parseToolResult(result) {
  if (result.isError) {
    throw new Error(result.content?.[0]?.text ?? "Unknown MCP tool error");
  }
  const text = result.content?.find((item) => item.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

async function timed(label, fn) {
  const startedAt = performance.now();
  const result = await fn();
  const elapsedMs = Math.round((performance.now() - startedAt) * 100) / 100;
  return { label, elapsedMs, result };
}

async function main() {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: headers ? { headers } : undefined,
  });
  const client = new Client({ name: "blog-mcp-probe", version: "1.0.0" });

  const startedAt = performance.now();
  await client.connect(transport);
  const connectMs = Math.round((performance.now() - startedAt) * 100) / 100;

  const checks = [
    await timed("listTools", () => client.listTools()),
    await timed("listResources", () => client.listResources()),
    await timed("listPrompts", () => client.listPrompts()),
    await timed("readResource(schema)", () => client.readResource({ uri: "agent-cms://schema" })),
    await timed("readResource(guide)", () => client.readResource({ uri: "agent-cms://guide" })),
    await timed("getPrompt(setup-content-model)", () => client.getPrompt({ name: "setup-content-model", arguments: { description: "blog with posts and categories" } })),
    await timed("callTool(schema_info)", () => client.callTool({ name: "schema_info", arguments: {} })),
    await timed("callTool(schema_info:all)", () => client.callTool({ name: "schema_info", arguments: {} })),
    await timed("callTool(schema_info:post)", () => client.callTool({ name: "schema_info", arguments: { filterByName: "post" } })),
    await timed("callTool(query_records:post)", () => client.callTool({ name: "query_records", arguments: { modelApiKey: "post" } })),
    await timed("callTool(get_site_settings)", () => client.callTool({ name: "get_site_settings", arguments: {} })),
  ];

  const tools = checks[0].result.tools.map((tool) => tool.name);
  const resources = checks[1].result.resources.map((resource) => resource.uri);
  const prompts = checks[2].result.prompts.map((prompt) => prompt.name);
  const schema = JSON.parse(checks[3].result.contents[0].text);
  const guide = checks[4].result.contents[0].text;
  const prompt = checks[5].result.messages[0]?.content?.text ?? "";
  const schemaInfo = parseToolResult(checks[6].result);
  const schemaInfoAll = parseToolResult(checks[7].result);
  const models = schemaInfoAll.models;
  const schemaInfoPost = parseToolResult(checks[8].result);
  const postModel = schemaInfoPost.models[0];
  const posts = parseToolResult(checks[9].result);
  const siteSettings = parseToolResult(checks[10].result);

  const summary = {
    url,
    connectMs,
    counts: {
      tools: tools.length,
      resources: resources.length,
      prompts: prompts.length,
      schemaModels: schema.models.length,
      schemaLocales: schema.locales.length,
      listModels: models.length,
      postRecords: posts.length,
    },
    toolSample: tools.slice(0, 8),
    resourceUris: resources,
    promptNames: prompts,
    postFieldApiKeys: postModel.fields.map((field) => field.apiKey),
    siteSettingsConfigured: !siteSettings.message,
    guideHasAssetFlow: guide.includes("Asset upload flow"),
    setupPromptHasPlanStep: prompt.includes("Present your plan before executing"),
    timingsMs: Object.fromEntries(checks.map((check) => [check.label, check.elapsedMs])),
    schemaInfoMatchesSchemaResource: schemaInfo.models.length === schema.models.length,
  };

  console.log(JSON.stringify(summary, null, 2));

  await transport.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
