import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { createTestApp, jsonRequest } from "./app-helpers.js";

describe("StructuredText write orchestration", () => {
  let handler: (req: Request) => Promise<Response>;
  let sqlLayer: any;
  let pageModelId: string;
  let heroBlockId: string;

  beforeEach(async () => {
    ({ handler, sqlLayer } = createTestApp());

    // Create a block type: hero_section
    const heroRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Hero Section", apiKey: "hero_section", isBlock: true,
    });
    const hero = await heroRes.json();
    heroBlockId = hero.id;

    await jsonRequest(handler, "POST", `/api/models/${hero.id}/fields`, {
      label: "Headline", apiKey: "headline", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${hero.id}/fields`, {
      label: "CTA URL", apiKey: "cta_url", fieldType: "string",
    });

    // Create a content model: page
    const pageRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Page", apiKey: "page",
    });
    const page = await pageRes.json();
    pageModelId = page.id;

    await jsonRequest(handler, "POST", `/api/models/${page.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${page.id}/fields`, {
      label: "Content", apiKey: "content", fieldType: "structured_text",
      validators: { structured_text_blocks: ["hero_section"] },
    });
  });

  it("creates a record with StructuredText + blocks", async () => {
    const blockId = "01HTEST_BLOCK_001";
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Home Page",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                {
                  type: "paragraph",
                  children: [{ type: "span", value: "Welcome to our site" }],
                },
                { type: "block", item: blockId },
              ],
            },
          },
          blocks: {
            [blockId]: {
              _type: "hero_section",
              headline: "Build amazing things",
              cta_url: "https://example.com/start",
            },
          },
        },
      },
    });

    expect(res.status).toBe(201);
    const record = await res.json();
    expect(record.title).toBe("Home Page");

    // Verify DAST was stored
    const getRes = await handler(new Request(`http://localhost/api/records/${record.id}?modelApiKey=page`));
    const fromDb = await getRes.json();
    expect(fromDb.content).toBeDefined();
    expect(fromDb.content.schema).toBe("dast");
    expect(fromDb.content.document.children).toHaveLength(2);

    // Verify block was written to the block table
    const blocks = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe<Record<string, any>>(
          'SELECT * FROM "block_hero_section" WHERE _root_record_id = ?',
          [record.id]
        );
      }).pipe(Effect.provide(sqlLayer))
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0].id).toBe(blockId);
    expect(blocks[0].headline).toBe("Build amazing things");
    expect(blocks[0].cta_url).toBe("https://example.com/start");
    expect(blocks[0]._root_field_api_key).toBe("content");
  });

  it("validates DAST structure", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Bad Page",
        content: {
          value: { schema: "wrong", document: {} },
          blocks: {},
        },
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("DAST");
  });

  it("rejects blocks not in whitelist", async () => {
    // Create another block type not in the whitelist
    const ctaRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "CTA Banner", apiKey: "cta_banner", isBlock: true,
    });
    const cta = await ctaRes.json();
    await jsonRequest(handler, "POST", `/api/models/${cta.id}/fields`, {
      label: "Text", apiKey: "text", fieldType: "string",
    });

    const blockId = "01HTEST_BLOCK_BAD";
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Bad Page",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [{ type: "block", item: blockId }],
            },
          },
          blocks: {
            [blockId]: { _type: "cta_banner", text: "Click me" },
          },
        },
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("not allowed");
  });

  it("rejects DAST with block reference but no block data", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Missing Block Data",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [{ type: "block", item: "nonexistent_block" }],
            },
          },
          blocks: {},
        },
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("no block data provided");
  });

  it("creates multiple blocks in one record", async () => {
    const block1 = "01HTEST_HERO_001";
    const block2 = "01HTEST_HERO_002";

    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Multi-block Page",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                { type: "block", item: block1 },
                { type: "paragraph", children: [{ type: "span", value: "Between blocks" }] },
                { type: "block", item: block2 },
              ],
            },
          },
          blocks: {
            [block1]: { _type: "hero_section", headline: "First Hero" },
            [block2]: { _type: "hero_section", headline: "Second Hero" },
          },
        },
      },
    });

    expect(res.status).toBe(201);
    const record = await res.json();

    // Verify both blocks written
    const blocks = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe<Record<string, any>>(
          'SELECT * FROM "block_hero_section" WHERE _root_record_id = ?',
          [record.id]
        );
      }).pipe(Effect.provide(sqlLayer))
    );

    expect(blocks).toHaveLength(2);
    const headlines = blocks.map((b: any) => b.headline).sort();
    expect(headlines).toEqual(["First Hero", "Second Hero"]);
  });
});
