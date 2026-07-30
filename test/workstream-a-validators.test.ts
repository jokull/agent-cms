import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest } from "./app-helpers.js";

// Workstream A — validator vocabulary parity (DatoCMS wrapped encodings +
// structured_text_links / structured_text_inline_blocks).

async function createModel(handler: (req: Request) => Promise<Response>, body: unknown) {
  const res = await jsonRequest(handler, "POST", "/api/models", body);
  return res.json();
}

async function createField(
  handler: (req: Request) => Promise<Response>,
  modelId: string,
  body: unknown,
) {
  return jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, body);
}

async function listFields(handler: (req: Request) => Promise<Response>, modelId: string) {
  const res = await jsonRequest(handler, "GET", `/api/models/${modelId}/fields`);
  return res.json() as Promise<Array<{ api_key: string; validators: Record<string, unknown> }>>;
}

describe("A1 — Dato wrapped validator encodings (field create)", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(() => {
    ({ handler } = createTestApp());
  });

  it("unwraps enum { values: [...] } to a canonical bare array", async () => {
    const model = await createModel(handler, { name: "Post", apiKey: "post" });
    const res = await createField(handler, model.id, {
      label: "Status", apiKey: "status", fieldType: "string",
      validators: { enum: { values: ["draft", "published"] } },
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.validators.enum).toEqual(["draft", "published"]);
  });

  it("unwraps item_item_type { item_types: [modelId] } and resolves ID → api_key", async () => {
    const author = await createModel(handler, { name: "Author", apiKey: "author" });
    const model = await createModel(handler, { name: "Post", apiKey: "post" });
    const res = await createField(handler, model.id, {
      label: "Author", apiKey: "author", fieldType: "link",
      validators: { item_item_type: { item_types: [author.id] } },
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.validators.item_item_type).toEqual(["author"]);
  });

  it("unwraps structured_text_blocks { item_types: [modelId] } and resolves ID → api_key", async () => {
    const callout = await createModel(handler, { name: "Callout", apiKey: "callout", isBlock: true });
    await createField(handler, callout.id, { label: "Message", apiKey: "message", fieldType: "string" });
    const model = await createModel(handler, { name: "Article", apiKey: "article" });
    const res = await createField(handler, model.id, {
      label: "Body", apiKey: "body", fieldType: "structured_text",
      validators: { structured_text_blocks: { item_types: [callout.id] } },
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.validators.structured_text_blocks).toEqual(["callout"]);
  });
});

describe("A1 — Dato wrapped validators through schema import", () => {
  it("importSchema accepts wrapped encodings and stores canonical bare arrays", async () => {
    const { handler } = createTestApp();

    const schema = {
      version: 1 as const,
      locales: [],
      models: [
        {
          name: "Author", apiKey: "author", isBlock: false, singleton: false,
          sortable: false, tree: false, hasDraft: false,
          fields: [
            { label: "Name", apiKey: "name", fieldType: "string", position: 0, localized: false, validators: {}, hint: null },
          ],
        },
        {
          name: "Callout", apiKey: "callout", isBlock: true, singleton: false,
          sortable: false, tree: false, hasDraft: false,
          fields: [
            { label: "Text", apiKey: "text", fieldType: "string", position: 0, localized: false, validators: {}, hint: null },
          ],
        },
        {
          name: "Post", apiKey: "post", isBlock: false, singleton: false,
          sortable: false, tree: false, hasDraft: false,
          fields: [
            // Dato-shaped wrapped encodings, referencing item types by api_key.
            { label: "Status", apiKey: "status", fieldType: "string", position: 0, localized: false,
              validators: { enum: { values: ["draft", "published"] } }, hint: null },
            { label: "Author", apiKey: "author", fieldType: "link", position: 1, localized: false,
              validators: { item_item_type: { item_types: ["author"] } }, hint: null },
            { label: "Body", apiKey: "body", fieldType: "structured_text", position: 2, localized: false,
              validators: {
                structured_text_blocks: { item_types: ["callout"] },
                structured_text_links: { item_types: ["author"] },
                structured_text_inline_blocks: { item_types: ["callout"] },
              }, hint: null },
          ],
        },
      ],
    };

    const importRes = await jsonRequest(handler, "POST", "/api/schema", schema);
    expect(importRes.status).toBe(201);

    // Read back the stored, canonical schema.
    const exportRes = await jsonRequest(handler, "GET", "/api/schema");
    const exported = await exportRes.json();
    const post = exported.models.find((m: { apiKey: string }) => m.apiKey === "post");
    const byKey = (k: string) => post.fields.find((f: { apiKey: string }) => f.apiKey === k).validators;

    expect(byKey("status").enum).toEqual(["draft", "published"]);
    expect(byKey("author").item_item_type).toEqual(["author"]);
    expect(byKey("body").structured_text_blocks).toEqual(["callout"]);
    expect(byKey("body").structured_text_links).toEqual(["author"]);
    expect(byKey("body").structured_text_inline_blocks).toEqual(["callout"]);
  });
});

describe("A1/A2 — new validator keys reject bad shapes / wrong field type", () => {
  let handler: (req: Request) => Promise<Response>;
  let articleId: string;

  beforeEach(async () => {
    ({ handler } = createTestApp());
    const article = await createModel(handler, { name: "Article", apiKey: "article" });
    articleId = article.id;
  });

  it("rejects structured_text_links on a non-structured_text field", async () => {
    const res = await createField(handler, articleId, {
      label: "Title", apiKey: "title", fieldType: "string",
      validators: { structured_text_links: ["author"] },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("structured_text_links");
  });

  it("rejects structured_text_inline_blocks when not an array of strings", async () => {
    const res = await createField(handler, articleId, {
      label: "Body", apiKey: "body", fieldType: "structured_text",
      validators: { structured_text_inline_blocks: [123] },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("structured_text_inline_blocks");
  });
});

function paragraphDast(children: unknown[]) {
  return {
    schema: "dast",
    document: { type: "root", children: [{ type: "paragraph", children }] },
  };
}

describe("A2 — structured_text_links enforcement", () => {
  let handler: (req: Request) => Promise<Response>;
  let authorId: string;
  let tagId: string;

  beforeEach(async () => {
    ({ handler } = createTestApp());

    const author = await createModel(handler, { name: "Author", apiKey: "author" });
    await createField(handler, author.id, { label: "Name", apiKey: "name", fieldType: "string" });
    const tag = await createModel(handler, { name: "Tag", apiKey: "tag" });
    await createField(handler, tag.id, { label: "Label", apiKey: "label", fieldType: "string" });

    authorId = (await (await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "author", data: { name: "Alice" },
    })).json()).id;
    tagId = (await (await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "tag", data: { label: "GraphQL" },
    })).json()).id;

    const article = await createModel(handler, { name: "Article", apiKey: "article" });
    await createField(handler, article.id, { label: "Title", apiKey: "title", fieldType: "string" });
    await createField(handler, article.id, {
      label: "Content", apiKey: "content", fieldType: "structured_text",
      validators: { structured_text_links: ["author"] },
    });
  });

  it("allows an itemLink to a permitted model", async () => {
    const dast = paragraphDast([
      { type: "itemLink", item: authorId, children: [{ type: "span", value: "Alice" }] },
    ]);
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "Ok", content: { value: dast } },
    });
    expect(res.status).toBe(201);
  });

  it("rejects an itemLink to a disallowed model", async () => {
    const dast = paragraphDast([
      { type: "itemLink", item: tagId, children: [{ type: "span", value: "GraphQL" }] },
    ]);
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "Bad", content: { value: dast } },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("structured_text_links");
    expect(body.issues[0].field).toBe("content");
  });

  it("rejects an inlineItem to a disallowed model", async () => {
    const dast = paragraphDast([
      { type: "span", value: "Tagged " },
      { type: "inlineItem", item: tagId },
    ]);
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "Bad", content: { value: dast } },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("structured_text_links");
  });

  it("allows any model when structured_text_links is absent (back-compat)", async () => {
    const openArticle = await createModel(handler, { name: "OpenArticle", apiKey: "open_article" });
    await createField(handler, openArticle.id, {
      label: "Content", apiKey: "content", fieldType: "structured_text",
    });
    const dast = paragraphDast([
      { type: "inlineItem", item: tagId },
    ]);
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "open_article", data: { content: { value: dast } },
    });
    expect(res.status).toBe(201);
  });
});

describe("A3 — structured_text_inline_blocks enforcement + fallback", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    ({ handler } = createTestApp());
    const callout = await createModel(handler, { name: "Callout", apiKey: "callout", isBlock: true });
    await createField(handler, callout.id, { label: "Message", apiKey: "message", fieldType: "string" });
    const highlight = await createModel(handler, { name: "Highlight", apiKey: "highlight", isBlock: true });
    await createField(handler, highlight.id, { label: "Text", apiKey: "text", fieldType: "string" });
  });

  async function makeArticle(validators: Record<string, unknown>) {
    const apiKey = `article_${Math.random().toString(36).slice(2)}`;
    const article = await createModel(handler, { name: apiKey, apiKey });
    await createField(handler, article.id, {
      label: "Content", apiKey: "content", fieldType: "structured_text", validators,
    });
    return apiKey;
  }

  function blockDast() {
    return {
      schema: "dast",
      document: { type: "root", children: [{ type: "block", item: "b1" }] },
    };
  }

  function inlineBlockDast() {
    return {
      schema: "dast",
      document: {
        type: "root",
        children: [{ type: "paragraph", children: [
          { type: "span", value: "x" },
          { type: "inlineBlock", item: "b1" },
        ] }],
      },
    };
  }

  it("checks inline blocks against structured_text_inline_blocks and block-position against structured_text_blocks", async () => {
    const apiKey = await makeArticle({
      structured_text_blocks: ["callout"],
      structured_text_inline_blocks: ["highlight"],
    });

    // block-position callout → allowed
    const okBlock = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: apiKey,
      data: { content: { value: blockDast(), blocks: { b1: { _type: "callout", message: "hi" } } } },
    });
    expect(okBlock.status).toBe(201);

    // inlineBlock highlight → allowed
    const okInline = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: apiKey,
      data: { content: { value: inlineBlockDast(), blocks: { b1: { _type: "highlight", text: "hi" } } } },
    });
    expect(okInline.status).toBe(201);

    // inlineBlock callout → rejected (not in inline whitelist)
    const badInline = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: apiKey,
      data: { content: { value: inlineBlockDast(), blocks: { b1: { _type: "callout", message: "hi" } } } },
    });
    expect(badInline.status).toBe(400);
    expect((await badInline.json()).error).toContain("Inline block");

    // block-position highlight → rejected (not in block whitelist)
    const badBlock = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: apiKey,
      data: { content: { value: blockDast(), blocks: { b1: { _type: "highlight", text: "hi" } } } },
    });
    expect(badBlock.status).toBe(400);
  });

  it("falls back to structured_text_blocks for inline blocks when inline validator is absent", async () => {
    const apiKey = await makeArticle({ structured_text_blocks: ["callout"] });

    // inlineBlock callout allowed via fallback
    const okInline = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: apiKey,
      data: { content: { value: inlineBlockDast(), blocks: { b1: { _type: "callout", message: "hi" } } } },
    });
    expect(okInline.status).toBe(201);

    // inlineBlock highlight rejected via fallback (not in block whitelist)
    const badInline = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: apiKey,
      data: { content: { value: inlineBlockDast(), blocks: { b1: { _type: "highlight", text: "hi" } } } },
    });
    expect(badInline.status).toBe(400);
  });
});
