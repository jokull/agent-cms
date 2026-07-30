/**
 * A mutation result must be shaped like a read (FRICTION #15), and `null` in a
 * patch must clear a field for every field type (FRICTION #5).
 *
 * Before: `PATCH /api/records/:id` returned structured_text as the raw DAST
 * document (`{schema, document}`) while `GET` returned the materialized
 * envelope (`{value, blocks}`) — the generated codec declares the envelope, so
 * anything refreshing its form from the mutation response blew up on
 * `result.content.blocks`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest } from "./app-helpers.js";

describe("mutation results are shaped like reads", () => {
  let handler: (req: Request) => Promise<Response>;

  const dast = (text: string, blockId: string) => ({
    value: {
      schema: "dast",
      document: {
        type: "root",
        children: [
          { type: "paragraph", children: [{ type: "span", value: text }] },
          { type: "block", item: blockId },
        ],
      },
    },
    blocks: { [blockId]: { _type: "hero_section", headline: "Hi" } },
  });

  beforeEach(async () => {
    ({ handler } = createTestApp());

    const blockRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Hero Section", apiKey: "hero_section", isBlock: true,
    });
    const block = await blockRes.json();
    await jsonRequest(handler, "POST", `/api/models/${block.id}/fields`, {
      label: "Headline", apiKey: "headline", fieldType: "string",
    });

    const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
    const model = await modelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Content", apiKey: "content", fieldType: "structured_text",
      validators: { structured_text_blocks: ["hero_section"] },
    });
  });

  it("PATCH returns the structured_text envelope, not raw DAST", async () => {
    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: { title: "First", content: dast("first", "b1") },
    });
    const created = await createRes.json();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${created.id}`, {
      modelApiKey: "post",
      data: { content: dast("second", "b2") },
    });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json();

    expect(Object.keys(patched.content).sort()).toEqual(["blocks", "value"]);
    expect(patched.content.value.schema).toBe("dast");
    expect(patched.content).not.toHaveProperty("schema");
    const blocks = Object.values(patched.content.blocks);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ _type: "hero_section", headline: "Hi" });

    // …and it is byte-identical to what the read path returns.
    const getRes = await handler(new Request(`http://localhost/api/records/${created.id}?modelApiKey=post`));
    const read = await getRes.json();
    expect(patched.content).toEqual(read.content);
  });

  it("POST (create) returns the structured_text envelope too", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: { title: "First", content: dast("first", "b1") },
    });
    const created = await res.json();
    expect(Object.keys(created.content).sort()).toEqual(["blocks", "value"]);

    const getRes = await handler(new Request(`http://localhost/api/records/${created.id}?modelApiKey=post`));
    const read = await getRes.json();
    expect(created.content).toEqual(read.content);
  });
});

describe("null in a patch clears a field", () => {
  let handler: (req: Request) => Promise<Response>;
  let recordId: string;

  const filled = {
    title: "Title",
    body: "Body",
    views: 42,
    published: true,
    rating: 4.5,
    when: "2026-01-02",
    at: "2026-01-02T03:04:05.000Z",
    tint: { red: 1, green: 2, blue: 3 },
    where: { latitude: 64.1, longitude: -21.9 },
    payload: { a: 1 },
    meta: { title: "seo" },
    content: {
      value: { schema: "dast", document: { type: "root", children: [{ type: "paragraph", children: [{ type: "span", value: "x" }] }] } },
    },
  };

  beforeEach(async () => {
    ({ handler } = createTestApp());
    const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
    const model = await modelRes.json();
    const field = (label: string, apiKey: string, fieldType: string) =>
      jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, { label, apiKey, fieldType });
    await field("Title", "title", "string");
    await field("Body", "body", "text");
    await field("Views", "views", "integer");
    await field("Published", "published", "boolean");
    await field("Rating", "rating", "float");
    await field("When", "when", "date");
    await field("At", "at", "date_time");
    await field("Tint", "tint", "color");
    await field("Where", "where", "lat_lon");
    await field("Payload", "payload", "json");
    await field("Meta", "meta", "seo");
    await field("Content", "content", "structured_text");

    const res = await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: filled });
    expect(res.status).toBe(201);
    recordId = (await res.json()).id;
  });

  it("sets, clears with null, and reads back null — for every field type", async () => {
    const before = await (await handler(new Request(`http://localhost/api/records/${recordId}?modelApiKey=post`))).json();
    for (const key of Object.keys(filled)) {
      expect(before[key], `${key} should be set before clearing`).not.toBeNull();
    }

    const cleared = Object.fromEntries(Object.keys(filled).map((key) => [key, null]));
    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${recordId}`, {
      modelApiKey: "post",
      data: cleared,
    });
    expect(patchRes.status).toBe(200);

    const after = await (await handler(new Request(`http://localhost/api/records/${recordId}?modelApiKey=post`))).json();
    for (const key of Object.keys(filled)) {
      expect(after[key], `${key} should be null after clearing`).toBeNull();
    }
  });

  it("an absent key leaves the field unchanged (undefined ≠ null)", async () => {
    await jsonRequest(handler, "PATCH", `/api/records/${recordId}`, {
      modelApiKey: "post",
      data: { title: null },
    });
    const after = await (await handler(new Request(`http://localhost/api/records/${recordId}?modelApiKey=post`))).json();
    expect(after.title).toBeNull();
    expect(after.body).toBe("Body");
    expect(after.views).toBe(42);
  });

  it("clearing a structured_text field deletes its blocks", async () => {
    const blockRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Note", apiKey: "note", isBlock: true,
    });
    const block = await blockRes.json();
    await jsonRequest(handler, "POST", `/api/models/${block.id}/fields`, {
      label: "Text", apiKey: "text", fieldType: "string",
    });

    await jsonRequest(handler, "PATCH", `/api/records/${recordId}`, {
      modelApiKey: "post",
      data: {
        content: {
          value: {
            schema: "dast",
            document: { type: "root", children: [{ type: "block", item: "n1" }] },
          },
          blocks: { n1: { _type: "note", text: "hello" } },
        },
      },
    });
    const withBlock = await (await handler(new Request(`http://localhost/api/records/${recordId}?modelApiKey=post`))).json();
    expect(Object.keys(withBlock.content.blocks)).toHaveLength(1);

    await jsonRequest(handler, "PATCH", `/api/records/${recordId}`, {
      modelApiKey: "post",
      data: { content: null },
    });
    const afterClear = await (await handler(new Request(`http://localhost/api/records/${recordId}?modelApiKey=post`))).json();
    expect(afterClear.content).toBeNull();
  });
});
