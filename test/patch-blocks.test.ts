import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { createTestApp, jsonRequest } from "./app-helpers.js";

describe("patch_blocks — partial block updates", () => {
  let handler: (req: Request) => Promise<Response>;
  let sqlLayer: any;

  beforeEach(async () => {
    ({ handler, sqlLayer } = createTestApp());

    // Block type: venue
    const venueRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Venue", apiKey: "venue", isBlock: true,
    });
    const venue = await venueRes.json();
    await jsonRequest(handler, "POST", `/api/models/${venue.id}/fields`, {
      label: "Name", apiKey: "name", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${venue.id}/fields`, {
      label: "Description", apiKey: "description", fieldType: "text",
    });

    // Content model: guide
    const guideRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Guide", apiKey: "guide", hasDraft: false,
    });
    const guide = await guideRes.json();
    await jsonRequest(handler, "POST", `/api/models/${guide.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${guide.id}/fields`, {
      label: "Content", apiKey: "content", fieldType: "structured_text",
      validators: { structured_text_blocks: ["venue"] },
    });
  });

  function getBlocks(recordId: string) {
    return Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe<Record<string, unknown>>(
          'SELECT * FROM "block_venue" WHERE _root_record_id = ? ORDER BY id',
          [recordId]
        );
      }).pipe(Effect.provide(sqlLayer))
    );
  }

  async function createGuideWithVenues() {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "guide",
      data: {
        title: "Food Guide",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                { type: "block", item: "v1" },
                { type: "block", item: "v2" },
                { type: "block", item: "v3" },
              ],
            },
          },
          blocks: {
            v1: { _type: "venue", name: "Grillid", description: "Fine dining" },
            v2: { _type: "venue", name: "Baejarins Beztu", description: "Hot dogs" },
            v3: { _type: "venue", name: "Dill", description: "Nordic cuisine" },
          },
        },
      },
    });
    expect(res.status).toBe(201);
    return res.json();
  }

  it("updates one block's field without touching others", async () => {
    const record = await createGuideWithVenues();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}/blocks`, {
      modelApiKey: "guide",
      fieldApiKey: "content",
      blocks: {
        v2: { description: "Famous hot dogs since 1937" },
      },
    });
    expect(patchRes.status).toBe(200);

    const blocks = await getBlocks(record.id);
    expect(blocks).toHaveLength(3);

    const v1 = blocks.find((b) => b.id === "v1");
    const v2 = blocks.find((b) => b.id === "v2");
    const v3 = blocks.find((b) => b.id === "v3");

    // v1 and v3 unchanged
    expect(v1?.name).toBe("Grillid");
    expect(v1?.description).toBe("Fine dining");
    expect(v3?.name).toBe("Dill");
    expect(v3?.description).toBe("Nordic cuisine");

    // v2 description updated, name preserved
    expect(v2?.name).toBe("Baejarins Beztu");
    expect(v2?.description).toBe("Famous hot dogs since 1937");
  });

  it("deletes a block with null and prunes DAST", async () => {
    const record = await createGuideWithVenues();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}/blocks`, {
      modelApiKey: "guide",
      fieldApiKey: "content",
      blocks: {
        v2: null,
      },
    });
    expect(patchRes.status).toBe(200);

    const blocks = await getBlocks(record.id);
    expect(blocks).toHaveLength(2);
    expect(blocks.find((b) => b.id === "v2")).toBeUndefined();

    // DAST should be pruned — only 2 block nodes remaining
    const updated = await patchRes.json();
    const content = typeof updated.content === "string" ? JSON.parse(updated.content) : updated.content;
    expect(content.value.document.children).toHaveLength(2);
    const blockItems = content.value.document.children.map((c: any) => c.item);
    expect(blockItems).toContain("v1");
    expect(blockItems).toContain("v3");
    expect(blockItems).not.toContain("v2");
  });

  it("rejects string passthrough with a clear error message", async () => {
    const record = await createGuideWithVenues();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}/blocks`, {
      modelApiKey: "guide",
      fieldApiKey: "content",
      blocks: {
        v1: "v1",
        v3: { name: "Dill Restaurant" },
      },
    });
    expect(patchRes.status).toBe(400);
    const body = await patchRes.json();
    expect(body.error).toContain("Invalid patch value for block 'v1'");
    expect(body.error).toContain("use an object to update fields, null to delete, or omit the key to keep unchanged");
  });

  it("allows combined update + delete in one call", async () => {
    const record = await createGuideWithVenues();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}/blocks`, {
      modelApiKey: "guide",
      fieldApiKey: "content",
      blocks: {
        v1: { description: "Updated fine dining" },
        v3: null,
      },
    });
    expect(patchRes.status).toBe(200);

    const blocks = await getBlocks(record.id);
    expect(blocks).toHaveLength(2);
    expect(blocks.find((b) => b.id === "v1")?.description).toBe("Updated fine dining");
    expect(blocks.find((b) => b.id === "v3")).toBeUndefined();
  });

  it("rejects patch for non-existent block ID", async () => {
    const record = await createGuideWithVenues();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}/blocks`, {
      modelApiKey: "guide",
      fieldApiKey: "content",
      blocks: {
        nonexistent: { description: "Nope" },
      },
    });
    expect(patchRes.status).toBe(400);
    const body = await patchRes.json();
    expect(body.error).toContain("does not exist in field 'content'");
  });

  it("rejects patch for non-structured_text field", async () => {
    const record = await createGuideWithVenues();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}/blocks`, {
      modelApiKey: "guide",
      fieldApiKey: "title",
      blocks: {},
    });
    expect(patchRes.status).toBe(400);
    const body = await patchRes.json();
    expect(body.error).toContain("not a structured_text field");
  });

  it("works via MCP tool input shape", async () => {
    const record = await createGuideWithVenues();

    // Same payload shape as MCP tool would use — omit v1 to keep unchanged
    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}/blocks`, {
      modelApiKey: "guide",
      fieldApiKey: "content",
      blocks: {
        v2: { name: "BBB", description: "Best hot dogs" },
        v3: null,
      },
    });
    expect(patchRes.status).toBe(200);

    const blocks = await getBlocks(record.id);
    expect(blocks).toHaveLength(2);
    expect(blocks.find((b) => b.id === "v1")?.name).toBe("Grillid");
    expect(blocks.find((b) => b.id === "v2")?.name).toBe("BBB");
    expect(blocks.find((b) => b.id === "v2")?.description).toBe("Best hot dogs");
  });

  it("accepts a new DAST value to reorder blocks", async () => {
    const record = await createGuideWithVenues();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}/blocks`, {
      modelApiKey: "guide",
      fieldApiKey: "content",
      value: {
        schema: "dast",
        document: {
          type: "root",
          children: [
            { type: "block", item: "v3" },
            { type: "paragraph", children: [{ type: "span", value: "Interlude" }] },
            { type: "block", item: "v1" },
          ],
        },
      },
      blocks: {
        v2: null,
      },
    });
    expect(patchRes.status).toBe(200);

    const blocks = await getBlocks(record.id);
    expect(blocks).toHaveLength(2);

    const updated = await patchRes.json();
    const content = typeof updated.content === "string" ? JSON.parse(updated.content) : updated.content;
    expect(content.value.document.children).toHaveLength(3);
    expect(content.value.document.children[0].item).toBe("v3");
    expect(content.value.document.children[1].type).toBe("paragraph");
    expect(content.value.document.children[2].item).toBe("v1");
  });

  // ── append tests ──

  it("appends a single new block to existing structured_text", async () => {
    const record = await createGuideWithVenues();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}/blocks`, {
      modelApiKey: "guide",
      fieldApiKey: "content",
      blocks: {},
      append: [{ _type: "venue", name: "Messinn", description: "Fish stew" }],
    });
    expect(patchRes.status).toBe(200);

    const result = await patchRes.json();
    expect(result._appendedIds).toHaveLength(1);
    const newId = result._appendedIds[0];

    // Block exists in DB
    const blocks = await getBlocks(record.id);
    expect(blocks).toHaveLength(4);
    const newBlock = blocks.find((b) => b.id === newId);
    expect(newBlock?.name).toBe("Messinn");
    expect(newBlock?.description).toBe("Fish stew");

    // DAST has 4 block nodes, new one at end
    const content = typeof result.content === "string" ? JSON.parse(result.content) : result.content;
    expect(content.value.document.children).toHaveLength(4);
    expect(content.value.document.children[3].type).toBe("block");
    expect(content.value.document.children[3].item).toBe(newId);
  });

  it("appends multiple new blocks", async () => {
    const record = await createGuideWithVenues();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}/blocks`, {
      modelApiKey: "guide",
      fieldApiKey: "content",
      blocks: {},
      append: [
        { _type: "venue", name: "Messinn", description: "Fish stew" },
        { _type: "venue", name: "Snaps", description: "Nordic bistro" },
      ],
    });
    expect(patchRes.status).toBe(200);

    const result = await patchRes.json();
    expect(result._appendedIds).toHaveLength(2);

    const blocks = await getBlocks(record.id);
    expect(blocks).toHaveLength(5);

    const content = typeof result.content === "string" ? JSON.parse(result.content) : result.content;
    expect(content.value.document.children).toHaveLength(5);
    expect(content.value.document.children[3].item).toBe(result._appendedIds[0]);
    expect(content.value.document.children[4].item).toBe(result._appendedIds[1]);
  });

  it("appends + patches existing blocks in the same call", async () => {
    const record = await createGuideWithVenues();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}/blocks`, {
      modelApiKey: "guide",
      fieldApiKey: "content",
      blocks: {
        v1: { description: "Updated fine dining" },
      },
      append: [{ _type: "venue", name: "Messinn", description: "Fish stew" }],
    });
    expect(patchRes.status).toBe(200);

    const result = await patchRes.json();
    expect(result._appendedIds).toHaveLength(1);

    const blocks = await getBlocks(record.id);
    expect(blocks).toHaveLength(4);
    expect(blocks.find((b) => b.id === "v1")?.description).toBe("Updated fine dining");
    expect(blocks.find((b) => b.id === result._appendedIds[0])?.name).toBe("Messinn");
  });

  it("appends + deletes existing blocks in the same call", async () => {
    const record = await createGuideWithVenues();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}/blocks`, {
      modelApiKey: "guide",
      fieldApiKey: "content",
      blocks: {
        v2: null,
      },
      append: [{ _type: "venue", name: "Messinn", description: "Fish stew" }],
    });
    expect(patchRes.status).toBe(200);

    const result = await patchRes.json();
    expect(result._appendedIds).toHaveLength(1);

    const blocks = await getBlocks(record.id);
    expect(blocks).toHaveLength(3); // 3 original - 1 deleted + 1 appended
    expect(blocks.find((b) => b.id === "v2")).toBeUndefined();
    expect(blocks.find((b) => b.id === result._appendedIds[0])?.name).toBe("Messinn");

    // DAST: v2 pruned, new block appended
    const content = typeof result.content === "string" ? JSON.parse(result.content) : result.content;
    const items = content.value.document.children.map((c: Record<string, unknown>) => c.item).filter(Boolean);
    expect(items).toContain("v1");
    expect(items).not.toContain("v2");
    expect(items).toContain("v3");
    expect(items).toContain(result._appendedIds[0]);
  });

  it("rejects append + value together", async () => {
    const record = await createGuideWithVenues();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}/blocks`, {
      modelApiKey: "guide",
      fieldApiKey: "content",
      blocks: {},
      value: {
        schema: "dast",
        document: { type: "root", children: [{ type: "block", item: "v1" }] },
      },
      append: [{ _type: "venue", name: "Messinn", description: "Fish stew" }],
    });
    expect(patchRes.status).toBe(400);
    const body = await patchRes.json();
    expect(body.error).toContain("Cannot use both 'value' and 'append'");
  });

  it("rejects append with block missing _type via downstream validation", async () => {
    const record = await createGuideWithVenues();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}/blocks`, {
      modelApiKey: "guide",
      fieldApiKey: "content",
      blocks: {},
      append: [{ name: "No Type Block" }],
    });
    expect(patchRes.status).toBe(400);
  });

  it("verify appended blocks appear in DB with correct data", async () => {
    const record = await createGuideWithVenues();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}/blocks`, {
      modelApiKey: "guide",
      fieldApiKey: "content",
      blocks: {},
      append: [{ _type: "venue", name: "Kopar", description: "Harbour restaurant" }],
    });
    expect(patchRes.status).toBe(200);

    const result = await patchRes.json();
    const newId = result._appendedIds[0];

    const blocks = await getBlocks(record.id);
    const newBlock = blocks.find((b) => b.id === newId);
    expect(newBlock).toBeDefined();
    expect(newBlock?.name).toBe("Kopar");
    expect(newBlock?.description).toBe("Harbour restaurant");
    expect(newBlock?._root_record_id).toBe(record.id);
  });

  it("response does not include _appendedIds when no append is used", async () => {
    const record = await createGuideWithVenues();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}/blocks`, {
      modelApiKey: "guide",
      fieldApiKey: "content",
      blocks: {
        v1: { description: "Updated" },
      },
    });
    expect(patchRes.status).toBe(200);
    const result = await patchRes.json();
    expect(result._appendedIds).toBeUndefined();
  });
});
