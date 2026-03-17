import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { runMigrations } from "./migrate.ts";
import { createWebHandler } from "../src/http/router.ts";

describe("MCP HTTP transport", () => {
  it("supports real Streamable HTTP client initialization and follow-up requests", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-mcp-http-"));
    const dbPath = join(tmpDir, "test.db");
    const sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });

    Effect.runSync(runMigrations().pipe(Effect.provide(sqlLayer)));

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

    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "schema_info")).toBe(true);

    const resources = await client.listResources();
    expect(resources.resources.some((resource) => resource.uri === "agent-cms://schema")).toBe(true);

    const schema = await client.readResource({ uri: "agent-cms://schema" });
    expect(schema.contents[0]?.uri).toBe("agent-cms://schema");

    await transport.close();
  });
});
