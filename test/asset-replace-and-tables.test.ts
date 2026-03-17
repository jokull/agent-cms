/**
 * Tests for:
 * - P8.3: Asset URL stability on replace
 * - P8.4: HTML tables in StructuredText
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
// P8.3: Asset URL stability on replace
// ---------------------------------------------------------------------------
describe("Asset replace (URL stability)", () => {
  let assetId: string;

  beforeEach(async () => {
    ({ handler } = createTestApp());

    // Create initial asset
    const res = await jsonRequest(handler, "POST", "/api/assets", {
      filename: "hero.jpg", mimeType: "image/jpeg", size: 100000,
      width: 1920, height: 1080, alt: "Hero image", title: "Homepage hero",
      r2Key: "uploads/hero.jpg",
    });
    assetId = (await res.json()).id;

    // Create a model + record referencing the asset
    const m = await createModel("Page", "page");
    await addField(m.id, "Title", "title", "string");
    await addField(m.id, "Cover", "cover", "media");
    await createRecord("page", { title: "Home", cover: assetId });
  });

  it("replaces file metadata while keeping the same asset ID", async () => {
    const res = await jsonRequest(handler, "PUT", `/api/assets/${assetId}`, {
      filename: "hero-v2.webp", mimeType: "image/webp", size: 50000,
      width: 2400, height: 1350, r2Key: "uploads/hero-v2.webp",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(assetId); // Same ID!
    expect(body.filename).toBe("hero-v2.webp");
    expect(body.mimeType).toBe("image/webp");
    expect(body.replaced).toBe(true);
  });

  it("preserves alt/title from original if not provided in replace", async () => {
    await jsonRequest(handler, "PUT", `/api/assets/${assetId}`, {
      filename: "hero-v2.webp", mimeType: "image/webp", size: 50000,
      r2Key: "uploads/hero-v2.webp",
    });

    const asset = await (await handler(new Request(`http://localhost/api/assets/${assetId}`))).json();
    expect(asset.alt).toBe("Hero image");
    expect(asset.title).toBe("Homepage hero");
  });

  it("content references resolve to the updated asset after replace", async () => {
    // Replace the asset
    await jsonRequest(handler, "PUT", `/api/assets/${assetId}`, {
      filename: "hero-v2.webp", mimeType: "image/webp", size: 50000,
      width: 2400, height: 1350, r2Key: "uploads/hero-v2.webp",
    });

    // Query via GraphQL — same cover field, new asset metadata
    const r = await gql(`{ allPages { title cover { id filename mimeType width height } } }`);
    expect(r.errors).toBeUndefined();
    const cover = r.data.allPages[0].cover;
    expect(cover.id).toBe(assetId);
    expect(cover.filename).toBe("hero-v2.webp");
    expect(cover.mimeType).toBe("image/webp");
    expect(cover.width).toBe(2400);
  });

  it("responsiveImage works with replaced asset dimensions", async () => {
    await jsonRequest(handler, "PUT", `/api/assets/${assetId}`, {
      filename: "hero-v2.webp", mimeType: "image/webp", size: 50000,
      width: 2400, height: 1350, r2Key: "uploads/hero-v2.webp",
    });

    const r = await gql(`{
      allPages { cover { responsiveImage { width height aspectRatio } } }
    }`);
    expect(r.data.allPages[0].cover.responsiveImage.width).toBe(2400);
    expect(r.data.allPages[0].cover.responsiveImage.height).toBe(1350);
  });

  it("returns 404 for replacing non-existent asset", async () => {
    const res = await jsonRequest(handler, "PUT", "/api/assets/nonexistent", {
      filename: "x.jpg", mimeType: "image/jpeg", size: 1,
    });
    expect(res.status).toBe(404);
  });

  it("MCP replace_asset tool works", async () => {
    const { createTestMcpClient } = await import("./mcp-helpers.js");

    const { sqlLayer } = createTestApp();
    const { client } = await createTestMcpClient(sqlLayer);

    // Create an asset via MCP
    const createResult = await client.callTool({
      name: "upload_asset",
      arguments: { filename: "old.jpg", mimeType: "image/jpeg", r2Key: "uploads/old.jpg", size: 1000 },
    });
    const asset = JSON.parse(createResult.content[0].text as string);

    // Replace via MCP
    const replaceResult = await client.callTool({
      name: "replace_asset",
      arguments: { assetId: asset.id, filename: "new.png", mimeType: "image/png", r2Key: "uploads/new.png", size: 2000 },
    });
    const replaced = JSON.parse(replaceResult.content[0].text as string);
    expect(replaced.id).toBe(asset.id);
    expect(replaced.filename).toBe("new.png");
    expect(replaced.replaced).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P8.4: HTML tables in StructuredText
// ---------------------------------------------------------------------------
describe("Tables in StructuredText", () => {
  beforeEach(async () => {
    ({ handler } = createTestApp());
    const m = await createModel("Article", "article");
    await addField(m.id, "Title", "title", "string");
    await addField(m.id, "Content", "content", "structured_text");
  });

  it("accepts a valid table in DAST", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: "Pricing Table",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                {
                  type: "table",
                  children: [
                    {
                      type: "tableRow",
                      children: [
                        { type: "tableCell", children: [{ type: "paragraph", children: [{ type: "span", value: "Plan" }] }] },
                        { type: "tableCell", children: [{ type: "paragraph", children: [{ type: "span", value: "Price" }] }] },
                      ],
                    },
                    {
                      type: "tableRow",
                      children: [
                        { type: "tableCell", children: [{ type: "paragraph", children: [{ type: "span", value: "Basic" }] }] },
                        { type: "tableCell", children: [{ type: "paragraph", children: [{ type: "span", value: "$9/mo" }] }] },
                      ],
                    },
                  ],
                },
              ],
            },
          },
          blocks: {},
        },
      },
    });
    expect(res.status).toBe(201);
  });

  it("resolves tables in GraphQL StructuredText response", async () => {
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: "Features",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                { type: "paragraph", children: [{ type: "span", value: "Compare our plans:" }] },
                {
                  type: "table",
                  children: [
                    {
                      type: "tableRow",
                      children: [
                        { type: "tableCell", children: [{ type: "paragraph", children: [{ type: "span", value: "Feature" }] }] },
                        { type: "tableCell", children: [{ type: "paragraph", children: [{ type: "span", value: "Free" }] }] },
                        { type: "tableCell", children: [{ type: "paragraph", children: [{ type: "span", value: "Pro" }] }] },
                      ],
                    },
                    {
                      type: "tableRow",
                      children: [
                        { type: "tableCell", children: [{ type: "paragraph", children: [{ type: "span", value: "Storage" }] }] },
                        { type: "tableCell", children: [{ type: "paragraph", children: [{ type: "span", value: "1 GB" }] }] },
                        { type: "tableCell", children: [{ type: "paragraph", children: [{ type: "span", value: "100 GB" }] }] },
                      ],
                    },
                  ],
                },
              ],
            },
          },
          blocks: {},
        },
      },
    });

    const r = await gql(`{ allArticles { content { value } } }`);
    expect(r.errors).toBeUndefined();
    const dast = r.data.allArticles[0].content.value;
    expect(dast.document.children).toHaveLength(2);
    expect(dast.document.children[1].type).toBe("table");
    expect(dast.document.children[1].children).toHaveLength(2);
    expect(dast.document.children[1].children[0].type).toBe("tableRow");
    expect(dast.document.children[1].children[0].children[0].type).toBe("tableCell");
  });

  it("tables can contain rich inline content (bold, links)", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: "Rich Table",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                {
                  type: "table",
                  children: [
                    {
                      type: "tableRow",
                      children: [
                        {
                          type: "tableCell",
                          children: [
                            {
                              type: "paragraph",
                              children: [
                                { type: "span", value: "Bold text", marks: ["strong"] },
                              ],
                            },
                          ],
                        },
                        {
                          type: "tableCell",
                          children: [
                            {
                              type: "paragraph",
                              children: [
                                { type: "link", url: "https://example.com", children: [{ type: "span", value: "Link" }] },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
          blocks: {},
        },
      },
    });
    expect(res.status).toBe(201);
  });

  it("rejects table with no rows", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: "Bad Table",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [{ type: "table", children: [] }],
            },
          },
          blocks: {},
        },
      },
    });
    // DAST validation should catch empty table
    expect(res.status).toBe(400);
  });

  it("rejects table with invalid children (not tableRow)", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: "Bad Table",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                {
                  type: "table",
                  children: [
                    { type: "paragraph", children: [{ type: "span", value: "not a row" }] },
                  ],
                },
              ],
            },
          },
          blocks: {},
        },
      },
    });
    expect(res.status).toBe(400);
  });

  it("tables alongside other DAST nodes (paragraph, heading, table)", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: "Mixed Content",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                { type: "heading", level: 2, children: [{ type: "span", value: "Data" }] },
                { type: "paragraph", children: [{ type: "span", value: "See the table below:" }] },
                {
                  type: "table",
                  children: [
                    {
                      type: "tableRow",
                      children: [
                        { type: "tableCell", children: [{ type: "paragraph", children: [{ type: "span", value: "A" }] }] },
                        { type: "tableCell", children: [{ type: "paragraph", children: [{ type: "span", value: "B" }] }] },
                      ],
                    },
                  ],
                },
                { type: "paragraph", children: [{ type: "span", value: "End of article." }] },
              ],
            },
          },
          blocks: {},
        },
      },
    });
    expect(res.status).toBe(201);

    const r = await gql(`{ allArticles { content { value } } }`);
    const children = r.data.allArticles[0].content.value.document.children;
    expect(children).toHaveLength(4);
    expect(children.map((c: any) => c.type)).toEqual(["heading", "paragraph", "table", "paragraph"]);
  });
});
