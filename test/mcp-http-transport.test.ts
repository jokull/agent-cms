import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { runMigrations } from "./migrate.ts";
import { createWebHandler } from "../src/http/router.ts";
import * as TokenService from "../src/services/token-service.js";

describe("MCP HTTP transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it("supports editor MCP transport with the reduced editorial toolset", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-mcp-editor-http-"));
    const dbPath = join(tmpDir, "test.db");
    const sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });

    Effect.runSync(runMigrations().pipe(Effect.provide(sqlLayer)));

    const editorToken = await Effect.runPromise(
      TokenService.createEditorToken({ name: "editor" }).pipe(Effect.provide(sqlLayer))
    );
    const handler = createWebHandler(sqlLayer, { writeKey: "write-key" }).fetch;

    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp/editor"), {
      requestInit: { headers: { Authorization: `Bearer ${editorToken.token}` } },
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
    const client = new Client({ name: "test-editor-client", version: "1.0.0" });

    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "schema_info")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "publish_record")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "create_model")).toBe(false);
    expect(tools.tools.some((tool) => tool.name === "create_editor_token")).toBe(false);
    expect(tools.tools.some((tool) => tool.name === "reindex_search")).toBe(false);
    expect(tools.tools.some((tool) => tool.name === "import_asset_from_url")).toBe(true);

    await transport.close();
  });

  it("lets editor MCP import an asset directly from a public URL", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-mcp-editor-import-"));
    const dbPath = join(tmpDir, "test.db");
    const sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });

    Effect.runSync(runMigrations().pipe(Effect.provide(sqlLayer)));

    const editorToken = await Effect.runPromise(
      TokenService.createEditorToken({ name: "editor" }).pipe(Effect.provide(sqlLayer))
    );

    const put = vi.fn(async () => undefined);
    const fakeBucket = { put } as unknown as R2Bucket;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url === "https://example.com/pigeon.png") {
        return new Response(Uint8Array.from([137, 80, 78, 71]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }
      return new Response("not found", { status: 404 });
    }));

    const handler = createWebHandler(sqlLayer, { writeKey: "write-key", r2Bucket: fakeBucket }).fetch;

    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp/editor"), {
      requestInit: { headers: { Authorization: `Bearer ${editorToken.token}` } },
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
    const client = new Client({ name: "test-editor-import-client", version: "1.0.0" });

    await client.connect(transport);

    const imported = await client.callTool({
      name: "import_asset_from_url",
      arguments: {
        url: "https://example.com/pigeon.png",
        alt: "Pigeon evidence photo",
        title: "Pigeon",
      },
    });

    const asset = JSON.parse(imported.content[0]?.text ?? "{}") as {
      id: string;
      filename: string;
      mimeType: string;
      size: number;
      r2Key: string;
      alt: string;
      title: string;
    };

    expect(asset.filename).toBe("pigeon.png");
    expect(asset.mimeType).toBe("image/png");
    expect(asset.size).toBe(4);
    expect(asset.alt).toBe("Pigeon evidence photo");
    expect(asset.title).toBe("Pigeon");
    expect(asset.r2Key).toContain(asset.id);
    expect(put).toHaveBeenCalledTimes(1);

    await transport.close();
  });
});
