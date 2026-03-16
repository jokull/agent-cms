/**
 * Tests for:
 * - P8.1: Bulk insert/upsert
 * - P8.2: Dangling link safety (block orphan cleanup, graceful null resolution)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

let handler: (req: Request) => Promise<Response>;

async function createModel(name: string, apiKey: string, opts: Record<string, unknown> = {}) {
  return (await jsonRequest(handler, "POST", "/api/models", { name, apiKey, ...opts })).json();
}

async function addField(modelId: string, label: string, apiKey: string, fieldType: string, extra: Record<string, unknown> = {}) {
  await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, { label, apiKey, fieldType, ...extra });
}

async function createRecord(modelApiKey: string, data: Record<string, unknown>) {
  return (await jsonRequest(handler, "POST", "/api/records", { modelApiKey, data })).json();
}

async function gql(query: string, opts: { includeDrafts?: boolean } = { includeDrafts: true }) {
  return gqlQuery(handler, query, undefined, opts);
}

// ---------------------------------------------------------------------------
// P8.1: Bulk insert
// ---------------------------------------------------------------------------
describe("Bulk insert", () => {
  beforeEach(async () => {
    ({ handler } = createTestApp());
    const m = await createModel("Article", "article", { sortable: true });
    await addField(m.id, "Title", "title", "string");
    await addField(m.id, "Slug", "slug", "slug", { validators: { slug_source: "title" } });
    await addField(m.id, "Views", "views", "integer");
  });

  it("creates multiple records in one call", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records/bulk", {
      modelApiKey: "article",
      records: [
        { title: "First Post", views: 10 },
        { title: "Second Post", views: 20 },
        { title: "Third Post", views: 30 },
      ],
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.created).toBe(3);
    expect(body.records).toHaveLength(3);

    // Verify all exist in GraphQL
    const r = await gql(`{ allArticles { title views } }`);
    expect(r.data.allArticles).toHaveLength(3);
  });

  it("auto-generates unique slugs across bulk records", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records/bulk", {
      modelApiKey: "article",
      records: [
        { title: "Duplicate Title" },
        { title: "Duplicate Title" },
        { title: "Duplicate Title" },
      ],
    });
    expect(res.status).toBe(201);

    const r = await gql(`{ allArticles { slug } }`);
    const slugs = r.data.allArticles.map((a: any) => a.slug);
    // All slugs should be unique
    expect(new Set(slugs).size).toBe(3);
    expect(slugs).toContain("duplicate-title");
    expect(slugs).toContain("duplicate-title-2");
    expect(slugs).toContain("duplicate-title-3");
  });

  it("auto-assigns positions for sortable models", async () => {
    await jsonRequest(handler, "POST", "/api/records/bulk", {
      modelApiKey: "article",
      records: [{ title: "A" }, { title: "B" }, { title: "C" }],
    });

    const r = await gql(`{ allArticles(orderBy: [_position_ASC]) { title } }`);
    expect(r.data.allArticles.map((a: any) => a.title)).toEqual(["A", "B", "C"]);
  });

  it("positions continue from existing records", async () => {
    // Create one record first
    await createRecord("article", { title: "Existing" });

    // Bulk create more
    await jsonRequest(handler, "POST", "/api/records/bulk", {
      modelApiKey: "article",
      records: [{ title: "New 1" }, { title: "New 2" }],
    });

    const r = await gql(`{ allArticles(orderBy: [_position_ASC]) { title } }`);
    expect(r.data.allArticles.map((a: any) => a.title)).toEqual(["Existing", "New 1", "New 2"]);
  });

  it("rejects empty records array", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records/bulk", {
      modelApiKey: "article",
      records: [],
    });
    expect(res.status).toBe(400);
  });

  it("rejects more than 1000 records", async () => {
    const records = Array.from({ length: 1001 }, (_, i) => ({ title: `Post ${i}` }));
    const res = await jsonRequest(handler, "POST", "/api/records/bulk", {
      modelApiKey: "article",
      records,
    });
    expect(res.status).toBe(400);
  });

  it("rejects bulk on singleton models", async () => {
    const m = await createModel("Settings", "settings", { singleton: true });
    await addField(m.id, "Site Name", "site_name", "string");

    const res = await jsonRequest(handler, "POST", "/api/records/bulk", {
      modelApiKey: "settings",
      records: [{ site_name: "A" }, { site_name: "B" }],
    });
    expect(res.status).toBe(400);
  });

  it("rejects bulk on block types", async () => {
    const m = await createModel("Hero", "hero", { isBlock: true });
    await addField(m.id, "Headline", "headline", "string");

    const res = await jsonRequest(handler, "POST", "/api/records/bulk", {
      modelApiKey: "hero",
      records: [{ headline: "Hi" }],
    });
    expect(res.status).toBe(400);
  });

  it("MCP bulk_create_records tool works", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createMcpServer } = await import("../src/mcp/server.js");

    const { sqlLayer } = createTestApp();
    const mcp = createMcpServer(sqlLayer);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0" });
    await Promise.all([client.connect(ct), mcp.connect(st)]);

    // Create model + field
    const model = JSON.parse((await client.callTool({ name: "create_model", arguments: { name: "Tag", apiKey: "tag" } })).content[0].text as string);
    await client.callTool({ name: "create_field", arguments: { modelId: model.id, label: "Name", apiKey: "name", fieldType: "string" } });

    // Bulk create
    const result = await client.callTool({
      name: "bulk_create_records",
      arguments: {
        modelApiKey: "tag",
        records: [{ name: "JavaScript" }, { name: "TypeScript" }, { name: "Rust" }],
      },
    });
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.created).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// P8.2: Dangling link safety
// ---------------------------------------------------------------------------
describe("Dangling link safety", () => {
  let catId: string;
  let tagIds: string[];
  let assetId: string;
  let postId: string;

  beforeEach(async () => {
    ({ handler } = createTestApp());

    // Category model
    const cat = await createModel("Category", "category");
    await addField(cat.id, "Name", "name", "string");

    // Tag model
    const tag = await createModel("Tag", "tag");
    await addField(tag.id, "Label", "label", "string");

    // Block type for structured text
    const cta = await createModel("CTA", "cta", { isBlock: true });
    await addField(cta.id, "Text", "text", "string");

    // Post model with all reference types
    const post = await createModel("Post", "post");
    await addField(post.id, "Title", "title", "string");
    await addField(post.id, "Category", "category", "link", { validators: { item_item_type: ["category"] } });
    await addField(post.id, "Tags", "tags", "links", { validators: { items_item_type: ["tag"] } });
    await addField(post.id, "Cover", "cover", "media");
    await addField(post.id, "Gallery", "gallery", "media_gallery");
    await addField(post.id, "Body", "body", "structured_text", { validators: { structured_text_blocks: ["cta"] } });

    // Create linked records
    const catRec = await createRecord("category", { name: "Tech" });
    catId = catRec.id;

    const tag1 = await createRecord("tag", { label: "JS" });
    const tag2 = await createRecord("tag", { label: "TS" });
    tagIds = [tag1.id, tag2.id];

    const assetRes = await jsonRequest(handler, "POST", "/api/assets", {
      filename: "photo.jpg", mimeType: "image/jpeg", size: 5000, width: 800, height: 600,
    });
    assetId = (await assetRes.json()).id;

    // Create post referencing everything
    const postRec = await createRecord("post", {
      title: "My Post",
      category: catId,
      tags: tagIds,
      cover: assetId,
      gallery: [assetId],
      body: {
        value: {
          schema: "dast",
          document: {
            type: "root",
            children: [
              { type: "paragraph", children: [{ type: "span", value: "Hello" }] },
            ],
          },
        },
        blocks: {},
      },
    });
    postId = postRec.id;
  });

  describe("single link field — deleted linked record", () => {
    it("returns null for deleted linked record", async () => {
      // Delete the category
      await jsonRequest(handler, "DELETE", `/api/records/${catId}?modelApiKey=category`);

      // Query post — category should be null, not error
      const r = await gql(`{ allPosts { title category { name } } }`);
      expect(r.errors).toBeUndefined();
      expect(r.data.allPosts[0].category).toBeNull();
    });
  });

  describe("multi-link field — deleted linked records", () => {
    it("filters out deleted records from links array", async () => {
      // Delete one tag
      await jsonRequest(handler, "DELETE", `/api/records/${tagIds[0]}?modelApiKey=tag`);

      const r = await gql(`{ allPosts { title tags { label } } }`);
      expect(r.errors).toBeUndefined();
      expect(r.data.allPosts[0].tags).toHaveLength(1);
      expect(r.data.allPosts[0].tags[0].label).toBe("TS");
    });

    it("returns empty array when all linked records deleted", async () => {
      await jsonRequest(handler, "DELETE", `/api/records/${tagIds[0]}?modelApiKey=tag`);
      await jsonRequest(handler, "DELETE", `/api/records/${tagIds[1]}?modelApiKey=tag`);

      const r = await gql(`{ allPosts { tags { label } } }`);
      expect(r.errors).toBeUndefined();
      expect(r.data.allPosts[0].tags).toHaveLength(0);
    });
  });

  describe("media field — deleted asset", () => {
    it("returns null for deleted cover asset", async () => {
      await jsonRequest(handler, "DELETE", `/api/assets/${assetId}`);

      const r = await gql(`{ allPosts { title cover { filename } } }`);
      expect(r.errors).toBeUndefined();
      expect(r.data.allPosts[0].cover).toBeNull();
    });
  });

  describe("media gallery — deleted assets", () => {
    it("filters out deleted assets from gallery", async () => {
      await jsonRequest(handler, "DELETE", `/api/assets/${assetId}`);

      const r = await gql(`{ allPosts { gallery { filename } } }`);
      expect(r.errors).toBeUndefined();
      expect(r.data.allPosts[0].gallery).toHaveLength(0);
    });
  });

  describe("block orphan cleanup on record deletion", () => {
    it("deletes blocks when parent record is deleted", async () => {
      // Create a post with a CTA block
      const blockId = "01BLOCK_CTA_001";
      const postWithBlock = await createRecord("post", {
        title: "Post With Block",
        body: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [{ type: "block", item: blockId }],
            },
          },
          blocks: { [blockId]: { _type: "cta", text: "Click me" } },
        },
      });

      // Verify block exists via GraphQL
      const before = await gql(`{ allPosts(filter: { title: { eq: "Post With Block" } }) { body { blocks { __typename ... on CtaRecord { text } } } } }`);
      expect(before.data.allPosts[0].body.blocks).toHaveLength(1);

      // Delete the post
      await jsonRequest(handler, "DELETE", `/api/records/${postWithBlock.id}?modelApiKey=post`);

      // Create another post to verify the block table is clean
      // (no orphan blocks from the deleted post)
      const newPost = await createRecord("post", {
        title: "Fresh Post",
        body: {
          value: { schema: "dast", document: { type: "root", children: [] } },
          blocks: {},
        },
      });

      const after = await gql(`{ allPosts(filter: { title: { eq: "Fresh Post" } }) { body { blocks { __typename } } } }`);
      expect(after.data.allPosts[0].body.blocks).toHaveLength(0);
    });
  });

  describe("cross-reference edge cases", () => {
    it("deleting a record does not affect other records linking to different targets", async () => {
      // Create a second category
      const cat2 = await createRecord("category", { name: "Food" });

      // Create a second post pointing to cat2
      await createRecord("post", { title: "Other Post", category: cat2.id });

      // Delete the first category
      await jsonRequest(handler, "DELETE", `/api/records/${catId}?modelApiKey=category`);

      // First post's category is null, second post's category is fine
      const r = await gql(`{ allPosts(orderBy: [_createdAt_ASC]) { title category { name } } }`);
      expect(r.data.allPosts[0].title).toBe("My Post");
      expect(r.data.allPosts[0].category).toBeNull();
      expect(r.data.allPosts[1].title).toBe("Other Post");
      expect(r.data.allPosts[1].category.name).toBe("Food");
    });

    it("multiple posts sharing the same tag — deleting tag affects all", async () => {
      await createRecord("post", { title: "Post 2", tags: [tagIds[0]] });

      // Delete the shared tag
      await jsonRequest(handler, "DELETE", `/api/records/${tagIds[0]}?modelApiKey=tag`);

      const r = await gql(`{ allPosts(orderBy: [_createdAt_ASC]) { title tags { label } } }`);
      // Post 1 had [JS, TS] → now [TS]
      const post1Tags = r.data.allPosts[0].tags.map((t: any) => t.label);
      expect(post1Tags).toEqual(["TS"]);
      // Post 2 had [JS] → now []
      expect(r.data.allPosts[1].tags).toHaveLength(0);
    });
  });
});
