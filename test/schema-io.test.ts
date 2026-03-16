/**
 * Schema import/export tests.
 *
 * Tests the full round-trip: build a schema, export it, import to a fresh CMS,
 * verify the result matches. Also tests edge cases like locales with fallbacks,
 * block types, and link references.
 */
import { describe, it, expect } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";
import type { SchemaExport } from "../src/services/schema-io.js";

async function createModel(handler: any, name: string, apiKey: string, opts: Record<string, unknown> = {}) {
  return (await jsonRequest(handler, "POST", "/api/models", { name, apiKey, ...opts })).json();
}

async function addField(handler: any, modelId: string, label: string, apiKey: string, fieldType: string, extra: Record<string, unknown> = {}) {
  await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, { label, apiKey, fieldType, ...extra });
}

describe("Schema import/export", () => {
  it("round-trips a complete schema with locales, blocks, links, and all field types", async () => {
    // --- Build a rich schema ---
    const { handler: h1 } = createTestApp();

    // Locales with fallback chain
    const en = await (await jsonRequest(h1, "POST", "/api/locales", { code: "en", position: 0 })).json();
    await jsonRequest(h1, "POST", "/api/locales", { code: "is", position: 1, fallbackLocaleId: en.id });

    // Block type
    const cta = await createModel(h1, "CTA Block", "cta_block", { isBlock: true });
    await addField(h1, cta.id, "Text", "text", "string");
    await addField(h1, cta.id, "URL", "url", "string");

    // Content models with various field types
    const cat = await createModel(h1, "Category", "category");
    await addField(h1, cat.id, "Name", "name", "string", { localized: true });
    await addField(h1, cat.id, "Slug", "slug", "slug", { validators: { slug_source: "name" } });

    const post = await createModel(h1, "Blog Post", "blog_post", { sortable: true });
    await addField(h1, post.id, "Title", "title", "string", { localized: true });
    await addField(h1, post.id, "Body", "body", "structured_text", {
      validators: { structured_text_blocks: ["cta_block"] },
    });
    await addField(h1, post.id, "Published", "published", "boolean");
    await addField(h1, post.id, "Category", "category", "link", {
      validators: { item_item_type: ["category"] },
    });
    await addField(h1, post.id, "Cover", "cover", "media");
    await addField(h1, post.id, "Location", "location", "lat_lon");
    await addField(h1, post.id, "Accent", "accent", "color");

    // --- Export ---
    const exportRes = await h1(new Request("http://localhost/api/schema"));
    expect(exportRes.status).toBe(200);
    const exported: SchemaExport = await exportRes.json();

    // Verify export shape
    expect(exported.version).toBe(1);
    expect(exported.locales).toHaveLength(2);
    expect(exported.locales[0].code).toBe("en");
    expect(exported.locales[1].code).toBe("is");
    expect(exported.locales[1].fallbackLocale).toBe("en");
    expect(exported.models).toHaveLength(3); // cta_block, category, blog_post
    expect(exported.models.find((m) => m.apiKey === "cta_block")?.isBlock).toBe(true);
    expect(exported.models.find((m) => m.apiKey === "blog_post")?.fields).toHaveLength(7);

    // No IDs in export
    const json = JSON.stringify(exported);
    // IDs are ULIDs (26 chars, uppercase). The export should not contain any.
    // (field api_keys and model api_keys are short snake_case, not ULIDs)
    expect(exported.models.every((m) => !("id" in m))).toBe(true);

    // --- Import into a fresh CMS ---
    const { handler: h2 } = createTestApp();

    const importRes = await jsonRequest(h2, "POST", "/api/schema", exported);
    expect(importRes.status).toBe(201);
    const stats = await importRes.json();
    expect(stats.locales).toBe(2);
    expect(stats.models).toBe(3);
    // cta_block: text, url = 2. category: name, slug = 2. blog_post: title, body, published, category, cover, location, accent = 7. Total = 11.
    expect(stats.fields).toBe(11);

    // --- Verify the imported schema matches ---
    const verifyRes = await h2(new Request("http://localhost/api/schema"));
    const imported: SchemaExport = await verifyRes.json();

    expect(imported.locales).toHaveLength(2);
    expect(imported.locales[0].code).toBe("en");
    expect(imported.locales[1].fallbackLocale).toBe("en");
    expect(imported.models).toHaveLength(3);

    // Verify field-level details match
    const exportedPost = exported.models.find((m) => m.apiKey === "blog_post")!;
    const importedPost = imported.models.find((m) => m.apiKey === "blog_post")!;
    expect(importedPost.fields).toHaveLength(exportedPost.fields.length);
    expect(importedPost.sortable).toBe(true);

    // Verify link validators preserved
    const catField = importedPost.fields.find((f) => f.apiKey === "category")!;
    expect(catField.validators).toEqual({ item_item_type: ["category"] });

    // Verify structured_text validators preserved
    const bodyField = importedPost.fields.find((f) => f.apiKey === "body")!;
    expect(bodyField.validators).toEqual({ structured_text_blocks: ["cta_block"] });
  });

  it("imported schema produces a working GraphQL API", async () => {
    // Build and export a simple schema
    const { handler: h1 } = createTestApp();
    const m = await createModel(h1, "Post", "post");
    await addField(h1, m.id, "Title", "title", "string");
    await addField(h1, m.id, "Views", "views", "integer");

    const exported = await (await h1(new Request("http://localhost/api/schema"))).json();

    // Import into fresh CMS
    const { handler: h2 } = createTestApp();
    await jsonRequest(h2, "POST", "/api/schema", exported);

    // Create content and query via GraphQL
    await jsonRequest(h2, "POST", "/api/records", {
      modelApiKey: "post", data: { title: "Hello World", views: 42 },
    });

    const result = await gqlQuery(h2, `{
      allPosts { title views }
    }`, undefined, { includeDrafts: true });

    expect(result.errors).toBeUndefined();
    expect(result.data.allPosts).toHaveLength(1);
    expect(result.data.allPosts[0].title).toBe("Hello World");
    expect(result.data.allPosts[0].views).toBe(42);
  });

  it("export on empty CMS returns empty schema", async () => {
    const { handler } = createTestApp();
    const res = await handler(new Request("http://localhost/api/schema"));
    const exported: SchemaExport = await res.json();

    expect(exported.version).toBe(1);
    expect(exported.locales).toHaveLength(0);
    expect(exported.models).toHaveLength(0);
  });

  it("import rejects invalid schema", async () => {
    const { handler } = createTestApp();

    const res1 = await jsonRequest(handler, "POST", "/api/schema", { bad: true });
    expect(res1.status).toBe(400);

    const res2 = await jsonRequest(handler, "POST", "/api/schema", { version: 99, models: [] });
    expect(res2.status).toBe(400);
  });

  it("import is idempotent-safe: errors on duplicate", async () => {
    const { handler } = createTestApp();

    const schema: SchemaExport = {
      version: 1,
      locales: [],
      models: [{ name: "Post", apiKey: "post", isBlock: false, singleton: false, sortable: false, tree: false, hasDraft: true, fields: [] }],
    };

    const res1 = await jsonRequest(handler, "POST", "/api/schema", schema);
    expect(res1.status).toBe(201);

    // Second import should fail (model already exists)
    const res2 = await jsonRequest(handler, "POST", "/api/schema", schema);
    expect(res2.status).toBe(409); // DuplicateError
  });

  it("MCP export_schema and import_schema tools work", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createMcpServer } = await import("../src/mcp/server.js");

    // Build schema via MCP on CMS 1
    const { sqlLayer: sqlLayer1 } = createTestApp();
    const mcpServer1 = createMcpServer(sqlLayer1);
    const [ct1, st1] = InMemoryTransport.createLinkedPair();
    const client1 = new Client({ name: "test", version: "1.0" });
    await Promise.all([client1.connect(ct1), mcpServer1.connect(st1)]);

    await client1.callTool({ name: "create_model", arguments: { name: "Item", apiKey: "item" } });
    const models = JSON.parse((await client1.callTool({ name: "list_models", arguments: {} })).content[0].text as string);
    await client1.callTool({ name: "create_field", arguments: { modelId: models[0].id, label: "Name", apiKey: "name", fieldType: "string" } });

    // Export via MCP
    const exportResult = await client1.callTool({ name: "export_schema", arguments: {} });
    const exported = JSON.parse(exportResult.content[0].text as string);
    expect(exported.version).toBe(1);
    expect(exported.models).toHaveLength(1);

    // Import into fresh CMS via MCP
    const { sqlLayer: sqlLayer2 } = createTestApp();
    const mcpServer2 = createMcpServer(sqlLayer2);
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    const client2 = new Client({ name: "test", version: "1.0" });
    await Promise.all([client2.connect(ct2), mcpServer2.connect(st2)]);

    const importResult = await client2.callTool({ name: "import_schema", arguments: { schema: exported } });
    const stats = JSON.parse(importResult.content[0].text as string);
    expect(stats.models).toBe(1);
    expect(stats.fields).toBe(1);
  });
});
