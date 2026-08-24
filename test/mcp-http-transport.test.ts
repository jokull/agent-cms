import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "./migrate.ts";
import { createWebHandler } from "../src/http/router.ts";
import { createTestMcpClient } from "./mcp-helpers.ts";
import * as TokenService from "../src/services/token-service.js";

describe("MCP stateless HTTP transport (2026-07-28)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves discover, tools/list, resources/list and resources/read without any handshake", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-mcp-http-"));
    const dbPath = join(tmpDir, "test.db");
    const sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });

    Effect.runSync(runMigrations().pipe(Effect.provide(sqlLayer)));

    const handler = createWebHandler(sqlLayer, { writeKey: "write-key" }).fetch;
    const { client } = await createTestMcpClient(sqlLayer, { handler });

    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "schema_info")).toBe(true);

    const resources = await client.listResources();
    expect(resources.resources.some((resource) => resource.uri === "agent-cms://schema")).toBe(true);

    const schema = await client.readResource({ uri: "agent-cms://schema" });
    expect(schema.contents[0]?.uri).toBe("agent-cms://schema");
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

    const { client } = await createTestMcpClient(sqlLayer, {
      handler,
      path: "/mcp/editor",
      token: editorToken.token,
    });

    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "schema_info")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "set_publish_status")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "get_record")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "update_record")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "create_model")).toBe(false);
    expect(tools.tools.some((tool) => tool.name === "editor_tokens")).toBe(false);
    expect(tools.tools.some((tool) => tool.name === "reindex_search")).toBe(false);
    expect(tools.tools.some((tool) => tool.name === "create_asset_upload_url")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "import_asset_from_url")).toBe(true);
  });

  it("lets editor MCP create a presigned asset upload URL", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-mcp-editor-upload-url-"));
    const dbPath = join(tmpDir, "test.db");
    const sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });

    Effect.runSync(runMigrations().pipe(Effect.provide(sqlLayer)));

    const editorToken = await Effect.runPromise(
      TokenService.createEditorToken({ name: "editor" }).pipe(Effect.provide(sqlLayer))
    );
    const handler = createWebHandler(sqlLayer, {
      writeKey: "write-key",
      r2Credentials: {
        accessKeyId: "test-access-key",
        secretAccessKey: "test-secret-key",
        bucketName: "test-bucket",
        accountId: "test-account",
      },
    }).fetch;

    const { client } = await createTestMcpClient(sqlLayer, {
      handler,
      path: "/mcp/editor",
      token: editorToken.token,
    });

    const result = await client.callTool({
      name: "create_asset_upload_url",
      arguments: {
        filename: "photo.jpg",
        mimeType: "image/jpeg",
      },
    });
    const body = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;

    expect(body.assetId).toEqual(expect.any(String));
    expect(body.r2Key).toBe(`uploads/${body.assetId}/photo.jpg`);
    expect(body.uploadUrl).toEqual(expect.stringContaining("https://test-bucket.test-account.r2.cloudflarestorage.com/"));
    expect(body.uploadUrl).toEqual(expect.stringContaining("X-Amz-Signature="));
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

    const { client } = await createTestMcpClient(sqlLayer, {
      handler,
      path: "/mcp/editor",
      token: editorToken.token,
    });

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
  });

  it("rejects importing an asset from localhost-style URLs", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-mcp-editor-import-localhost-"));
    const dbPath = join(tmpDir, "test.db");
    const sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });

    Effect.runSync(runMigrations().pipe(Effect.provide(sqlLayer)));

    const editorToken = await Effect.runPromise(
      TokenService.createEditorToken({ name: "editor" }).pipe(Effect.provide(sqlLayer))
    );

    const fetchSpy = vi.fn(async () => new Response("should not fetch", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const fakeBucket = { put: vi.fn(async () => undefined) } as unknown as R2Bucket;
    const handler = createWebHandler(sqlLayer, { writeKey: "write-key", r2Bucket: fakeBucket }).fetch;

    const { client } = await createTestMcpClient(sqlLayer, {
      handler,
      path: "/mcp/editor",
      token: editorToken.token,
    });

    const result = await client.callTool({
      name: "import_asset_from_url",
      arguments: {
        url: "http://localhost/pigeon.png",
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ message: expect.stringMatching(/host is not allowed/i) });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("follows redirecting asset imports", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-mcp-editor-import-redirect-"));
    const dbPath = join(tmpDir, "test.db");
    const sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });

    Effect.runSync(runMigrations().pipe(Effect.provide(sqlLayer)));

    const editorToken = await Effect.runPromise(
      TokenService.createEditorToken({ name: "editor" }).pipe(Effect.provide(sqlLayer))
    );

    const put = vi.fn(async () => undefined);
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.com/redirect.png") {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://cdn.example.com/final.png" },
        });
      }
      expect(url).toBe("https://cdn.example.com/final.png");
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const fakeBucket = { put } as unknown as R2Bucket;
    const handler = createWebHandler(sqlLayer, { writeKey: "write-key", r2Bucket: fakeBucket }).fetch;

    const { client } = await createTestMcpClient(sqlLayer, {
      handler,
      path: "/mcp/editor",
      token: editorToken.token,
    });

    const result = await client.callTool({
      name: "import_asset_from_url",
      arguments: {
        url: "https://example.com/redirect.png",
      },
    });

    const asset = JSON.parse(result.content[0]?.text ?? "{}") as {
      filename: string;
      mimeType: string;
      size: number;
    };

    expect(result.isError).toBe(false);
    expect(asset).toMatchObject({
      filename: "final.png",
      mimeType: "image/png",
      size: 4,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized asset imports before storing them", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-mcp-editor-import-oversized-"));
    const dbPath = join(tmpDir, "test.db");
    const sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });

    Effect.runSync(runMigrations().pipe(Effect.provide(sqlLayer)));

    const editorToken = await Effect.runPromise(
      TokenService.createEditorToken({ name: "editor" }).pipe(Effect.provide(sqlLayer))
    );

    const put = vi.fn(async () => undefined);
    const fakeBucket = { put } as unknown as R2Bucket;
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(26 * 1024 * 1024),
        },
      })));

    const handler = createWebHandler(sqlLayer, { writeKey: "write-key", r2Bucket: fakeBucket }).fetch;

    const { client } = await createTestMcpClient(sqlLayer, {
      handler,
      path: "/mcp/editor",
      token: editorToken.token,
    });

    const result = await client.callTool({
      name: "import_asset_from_url",
      arguments: {
        url: "https://example.com/huge.png",
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ message: expect.stringMatching(/too large to import/i) });

    expect(put).not.toHaveBeenCalled();
  });

  it("threads editor attribution through MCP record mutations", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-mcp-editor-attribution-"));
    const dbPath = join(tmpDir, "test.db");
    const sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });

    Effect.runSync(runMigrations().pipe(Effect.provide(sqlLayer)));

    const editorToken = await Effect.runPromise(
      TokenService.createEditorToken({ name: "Editor MCP" }).pipe(Effect.provide(sqlLayer))
    );
    const handler = createWebHandler(sqlLayer, { writeKey: "write-key" }).fetch;

    const createdModelResponse = await handler(new Request("http://localhost/api/models", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer write-key",
      },
      body: JSON.stringify({ name: "Note", apiKey: "note", hasDraft: false }),
    }));
    const model = await createdModelResponse.json() as { id: string };

    await handler(new Request(`http://localhost/api/models/${model.id}/fields`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer write-key",
      },
      body: JSON.stringify({ label: "Title", apiKey: "title", fieldType: "string" }),
    }));

    const { client } = await createTestMcpClient(sqlLayer, {
      handler,
      path: "/mcp/editor",
      token: editorToken.token,
    });

    const created = await client.callTool({
      name: "create_record",
      arguments: { modelApiKey: "note", data: { title: "Initial MCP title" } },
    });
    const record = JSON.parse(created.content[0]?.text ?? "{}") as { id: string };

    await client.callTool({
      name: "update_record",
      arguments: { recordId: record.id, modelApiKey: "note", data: { title: "Updated MCP title" } },
    });

    const versions = await client.callTool({
      name: "record_versions",
      arguments: { action: "list", recordId: record.id, modelApiKey: "note" },
    });
    const parsedVersions = JSON.parse(versions.content[0]?.text ?? "[]") as Array<Record<string, unknown>>;

    expect(parsedVersions).toHaveLength(1);
    expect(parsedVersions[0]?.action).toBe("auto_republish");
    expect(parsedVersions[0]?.actor_type).toBe("editor");
    expect(parsedVersions[0]?.actor_label).toBe("Editor MCP");
    expect(parsedVersions[0]?.actor_token_id).toBe(editorToken.id);
  });

  it("threads editor attribution through MCP asset mutations", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-mcp-editor-asset-attribution-"));
    const dbPath = join(tmpDir, "test.db");
    const sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });

    Effect.runSync(runMigrations().pipe(Effect.provide(sqlLayer)));

    const editorToken = await Effect.runPromise(
      TokenService.createEditorToken({ name: "Asset MCP Editor" }).pipe(Effect.provide(sqlLayer))
    );
    const handler = createWebHandler(sqlLayer, { writeKey: "write-key" }).fetch;

    const { client } = await createTestMcpClient(sqlLayer, {
      handler,
      path: "/mcp/editor",
      token: editorToken.token,
    });

    const created = await client.callTool({
      name: "upload_asset",
      arguments: {
        filename: "pigeon.jpg",
        mimeType: "image/jpeg",
        size: 42,
      },
    });
    const asset = JSON.parse(created.content[0]?.text ?? "{}") as { id: string };

    await client.callTool({
      name: "replace_asset",
      arguments: {
        assetId: asset.id,
        filename: "pigeon-updated.jpg",
        mimeType: "image/jpeg",
        size: 84,
      },
    });

    const assetResponse = await handler(new Request(`http://localhost/api/assets/${asset.id}`, {
      headers: { Authorization: `Bearer ${editorToken.token}` },
    }));
    const stored = await assetResponse.json() as Record<string, unknown>;

    expect(stored.created_by).toBe("Asset MCP Editor");
    expect(stored.updated_by).toBe("Asset MCP Editor");
  });
});
