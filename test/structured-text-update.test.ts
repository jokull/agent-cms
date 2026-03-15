import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { createTestApp, jsonRequest } from "./app-helpers.js";

describe("StructuredText update + orphan cleanup", () => {
  let handler: (req: Request) => Promise<Response>;
  let sqlLayer: any;
  let pageModelId: string;

  beforeEach(async () => {
    ({ handler, sqlLayer } = createTestApp());

    // Block type
    const heroRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Hero Section", apiKey: "hero_section", isBlock: true,
    });
    const hero = await heroRes.json();
    await jsonRequest(handler, "POST", `/api/models/${hero.id}/fields`, {
      label: "Headline", apiKey: "headline", fieldType: "string",
    });

    // Content model
    const pageRes = await jsonRequest(handler, "POST", "/api/models", { name: "Page", apiKey: "page" });
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

  function countBlocks(recordId: string) {
    return Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql.unsafe<{ id: string }>(
          'SELECT id FROM "block_hero_section" WHERE _root_record_id = ?',
          [recordId]
        );
        return rows.length;
      }).pipe(Effect.provide(sqlLayer))
    );
  }

  it("creates record with 3 blocks, updates to 2, orphan deleted", async () => {
    const b1 = "01HORPHAN_BLOCK_1";
    const b2 = "01HORPHAN_BLOCK_2";
    const b3 = "01HORPHAN_BLOCK_3";

    // Create with 3 blocks
    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Test Page",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                { type: "block", item: b1 },
                { type: "block", item: b2 },
                { type: "block", item: b3 },
              ],
            },
          },
          blocks: {
            [b1]: { _type: "hero_section", headline: "First" },
            [b2]: { _type: "hero_section", headline: "Second" },
            [b3]: { _type: "hero_section", headline: "Third" },
          },
        },
      },
    });
    const record = await createRes.json();
    expect(await countBlocks(record.id)).toBe(3);

    // Update to 2 blocks (remove b3, keep b1/b2 with new IDs)
    const nb1 = "01HORPHAN_NEW_B1";
    const nb2 = "01HORPHAN_NEW_B2";

    const updateRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}`, {
      modelApiKey: "page",
      data: {
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                { type: "block", item: nb1 },
                { type: "block", item: nb2 },
              ],
            },
          },
          blocks: {
            [nb1]: { _type: "hero_section", headline: "Updated First" },
            [nb2]: { _type: "hero_section", headline: "Updated Second" },
          },
        },
      },
    });
    expect(updateRes.status).toBe(200);

    // Old blocks should be deleted, new ones created
    expect(await countBlocks(record.id)).toBe(2);

    // Verify the new blocks have correct content
    const blocks = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe<Record<string, any>>(
          'SELECT * FROM "block_hero_section" WHERE _root_record_id = ?',
          [record.id]
        );
      }).pipe(Effect.provide(sqlLayer))
    );
    const headlines = blocks.map((b: any) => b.headline).sort();
    expect(headlines).toEqual(["Updated First", "Updated Second"]);
  });

  it("clears all blocks when ST field is set to null", async () => {
    const b1 = "01HCLEAR_BLOCK_1";

    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Test",
        content: {
          value: { schema: "dast", document: { type: "root", children: [{ type: "block", item: b1 }] } },
          blocks: { [b1]: { _type: "hero_section", headline: "Gone soon" } },
        },
      },
    });
    const record = await createRes.json();
    expect(await countBlocks(record.id)).toBe(1);

    // Update: clear the structured text field
    await jsonRequest(handler, "PATCH", `/api/records/${record.id}`, {
      modelApiKey: "page",
      data: { content: null },
    });

    expect(await countBlocks(record.id)).toBe(0);
  });

  it("updates non-ST fields without affecting blocks", async () => {
    const b1 = "01HKEEP_BLOCK_1";

    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Original",
        content: {
          value: { schema: "dast", document: { type: "root", children: [{ type: "block", item: b1 }] } },
          blocks: { [b1]: { _type: "hero_section", headline: "Stays" } },
        },
      },
    });
    const record = await createRes.json();

    // Update only the title, not the content
    await jsonRequest(handler, "PATCH", `/api/records/${record.id}`, {
      modelApiKey: "page",
      data: { title: "Updated Title" },
    });

    // Blocks should still be there
    expect(await countBlocks(record.id)).toBe(1);
  });
});
