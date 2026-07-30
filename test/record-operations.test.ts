import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest } from "./app-helpers.js";

type Handler = (req: Request) => Promise<Response>;

async function createModel(handler: Handler, body: Record<string, unknown>) {
  const res = await jsonRequest(handler, "POST", "/api/models", body);
  expect(res.status).toBe(201);
  return res.json();
}

async function addField(handler: Handler, modelId: string, body: Record<string, unknown>) {
  const res = await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, body);
  expect(res.status).toBe(201);
  return res.json();
}

async function createRecord(handler: Handler, modelApiKey: string, data: Record<string, unknown>) {
  const res = await jsonRequest(handler, "POST", "/api/records", { modelApiKey, data });
  expect(res.status).toBe(201);
  return res.json();
}

// ===========================================================================
// 1. Queryable list — POST /api/records/query
// ===========================================================================
describe("POST /api/records/query (queryable list)", () => {
  let handler: Handler;

  beforeEach(async () => {
    ({ handler } = createTestApp());
    const model = await createModel(handler, { name: "Post", apiKey: "post" });
    await addField(handler, model.id, { label: "Title", apiKey: "title", fieldType: "string" });
    await addField(handler, model.id, { label: "Views", apiKey: "views", fieldType: "integer" });
    await addField(handler, model.id, { label: "Published", apiKey: "published", fieldType: "boolean" });

    await createRecord(handler, "post", { title: "Alpha", views: 10, published: false });
    await createRecord(handler, "post", { title: "Beta", views: 20, published: true });
    await createRecord(handler, "post", { title: "Gamma", views: 30, published: false });
  });

  it("filters by string eq", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records/query", {
      modelApiKey: "post",
      filter: { title: { eq: "Beta" } },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.records).toHaveLength(1);
    expect(body.records[0].title).toBe("Beta");
  });

  it("filters by integer lt", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records/query", {
      modelApiKey: "post",
      filter: { views: { lt: 25 } },
    });
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.records.map((r: { title: string }) => r.title).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("filters by string in", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records/query", {
      modelApiKey: "post",
      filter: { title: { in: ["Alpha", "Gamma"] } },
    });
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.records.map((r: { title: string }) => r.title).sort()).toEqual(["Alpha", "Gamma"]);
  });

  it("orders by integer DESC", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records/query", {
      modelApiKey: "post",
      orderBy: ["views_DESC"],
    });
    const body = await res.json();
    expect(body.records.map((r: { views: number }) => r.views)).toEqual([30, 20, 10]);
  });

  it("paginates and reports total independent of page size", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records/query", {
      modelApiKey: "post",
      orderBy: ["views_ASC"],
      page: { limit: 2, offset: 0 },
    });
    const body = await res.json();
    expect(body.total).toBe(3);
    expect(body.records).toHaveLength(2);
    expect(body.records.map((r: { views: number }) => r.views)).toEqual([10, 20]);

    const res2 = await jsonRequest(handler, "POST", "/api/records/query", {
      modelApiKey: "post",
      orderBy: ["views_ASC"],
      page: { limit: 2, offset: 2 },
    });
    const body2 = await res2.json();
    expect(body2.total).toBe(3);
    expect(body2.records).toHaveLength(1);
    expect(body2.records[0].views).toBe(30);
  });

  it("filters by _status", async () => {
    // Publish one record, then filter to published only
    const list = await (await jsonRequest(handler, "POST", "/api/records/query", { modelApiKey: "post" })).json();
    const alpha = list.records.find((r: { title: string }) => r.title === "Alpha");
    const pub = await jsonRequest(handler, "POST", `/api/records/${alpha.id}/publish?modelApiKey=post`);
    expect(pub.status).toBe(200);

    const res = await jsonRequest(handler, "POST", "/api/records/query", {
      modelApiKey: "post",
      status: "published",
    });
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.records[0].title).toBe("Alpha");

    const drafts = await (await jsonRequest(handler, "POST", "/api/records/query", {
      modelApiKey: "post",
      status: "draft",
    })).json();
    expect(drafts.total).toBe(2);
  });

  it("rejects unknown filter field", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records/query", {
      modelApiKey: "post",
      filter: { nope: { eq: 1 } },
    });
    expect(res.status).toBe(400);
  });

  it("rejects unknown orderBy field", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records/query", {
      modelApiKey: "post",
      orderBy: ["nope_ASC"],
    });
    expect(res.status).toBe(400);
  });

  it("404s for unknown model", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records/query", { modelApiKey: "ghost" });
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// 2. Picker search — GET /api/records/picker-search
// ===========================================================================
describe("GET /api/records/picker-search", () => {
  let handler: Handler;

  beforeEach(() => {
    ({ handler } = createTestApp());
  });

  it("searches by the conventional title field without presentation hints", async () => {
    const model = await createModel(handler, { name: "Fruit", apiKey: "fruit" });
    await addField(handler, model.id, { label: "Title", apiKey: "title", fieldType: "string" });
    await createRecord(handler, "fruit", { title: "Apple" });
    await createRecord(handler, "fruit", { title: "Banana" });

    const res = await handler(new Request("http://localhost/api/records/picker-search?modelApiKey=fruit&q=app"));
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Apple");
    expect(rows[0].image).toBeNull();
    expect(rows[0].status).toBe("draft");
    expect(rows[0].updatedAt).toBeTruthy();
  });

  it("uses presentation hints (title_field + image_preview_field)", async () => {
    const assetRes = await jsonRequest(handler, "POST", "/api/assets", {
      filename: "pic.jpg",
      mimeType: "image/jpeg",
    });
    expect(assetRes.status).toBe(201);
    const asset = await assetRes.json();

    const model = await createModel(handler, { name: "Product", apiKey: "product" });
    await addField(handler, model.id, { label: "Headline", apiKey: "headline", fieldType: "string" });
    await addField(handler, model.id, { label: "Cover", apiKey: "cover", fieldType: "media" });
    // Set hints (requires fields to exist first)
    const patch = await jsonRequest(handler, "PATCH", `/api/models/${model.id}`, {
      titleField: "headline",
      imagePreviewField: "cover",
    });
    expect(patch.status).toBe(200);

    await createRecord(handler, "product", { headline: "Widget", cover: asset.id });
    await createRecord(handler, "product", { headline: "Gadget", cover: asset.id });

    const res = await handler(new Request("http://localhost/api/records/picker-search?modelApiKey=product&q=widg"));
    const rows = await res.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Widget");
    expect(rows[0].image).toBe(asset.id);
  });

  it("returns all rows (capped) when q is empty", async () => {
    const model = await createModel(handler, { name: "Note", apiKey: "note" });
    await addField(handler, model.id, { label: "Title", apiKey: "title", fieldType: "string" });
    await createRecord(handler, "note", { title: "One" });
    await createRecord(handler, "note", { title: "Two" });

    const res = await handler(new Request("http://localhost/api/records/picker-search?modelApiKey=note&q="));
    const rows = await res.json();
    expect(rows).toHaveLength(2);
  });

  it("treats % and _ in q as literal characters, not LIKE wildcards", async () => {
    const model = await createModel(handler, { name: "Doc", apiKey: "doc" });
    await addField(handler, model.id, { label: "Title", apiKey: "title", fieldType: "string" });
    await createRecord(handler, "doc", { title: "report_2026" });
    await createRecord(handler, "doc", { title: "report-2026" });
    await createRecord(handler, "doc", { title: "reportX2026" });
    await createRecord(handler, "doc", { title: "50% off sale" });

    // A literal underscore in q must not act as a single-char wildcard.
    const underscoreRes = await handler(
      new Request("http://localhost/api/records/picker-search?modelApiKey=doc&q=report_2026")
    );
    const underscoreRows = await underscoreRes.json();
    expect(underscoreRows).toHaveLength(1);
    expect(underscoreRows[0].title).toBe("report_2026");

    // A literal percent sign in q must not act as a wildcard matching everything.
    const percentRes = await handler(
      new Request(`http://localhost/api/records/picker-search?modelApiKey=doc&q=${encodeURIComponent("50%")}`)
    );
    const percentRows = await percentRes.json();
    expect(percentRows).toHaveLength(1);
    expect(percentRows[0].title).toBe("50% off sale");
  });
});

// ===========================================================================
// 3. Duplicate — POST /api/records/:id/duplicate
// ===========================================================================
describe("POST /api/records/:id/duplicate", () => {
  let handler: Handler;

  beforeEach(async () => {
    ({ handler } = createTestApp());
    const hero = await createModel(handler, { name: "Hero", apiKey: "hero", isBlock: true });
    await addField(handler, hero.id, { label: "Headline", apiKey: "headline", fieldType: "string" });

    const page = await createModel(handler, { name: "Page", apiKey: "page" });
    await addField(handler, page.id, { label: "Title", apiKey: "title", fieldType: "string" });
    await addField(handler, page.id, { label: "Slug", apiKey: "slug", fieldType: "slug", validators: { unique: true } });
    await addField(handler, page.id, {
      label: "Sections", apiKey: "sections", fieldType: "structured_text",
      validators: { structured_text_blocks: ["hero"] },
    });
  });

  it("deep-copies block subtrees with fresh ids, leaving the source intact and the envelope valid, and uniquifies the slug", async () => {
    const blockId = "01HORIGINALBLOCK";
    const source = await createRecord(handler, "page", {
      title: "My Page",
      slug: "my-page",
      sections: {
        value: {
          schema: "dast",
          document: { type: "root", children: [{ type: "block", item: blockId }] },
        },
        blocks: { [blockId]: { _type: "hero", headline: "Welcome" } },
      },
    });

    // Read source's materialized structured text to capture its (rewritten) block id
    const sourceGet = await (await handler(new Request(`http://localhost/api/records/${source.id}?modelApiKey=page`))).json();
    const sourceBlockId = sourceGet.sections.value.document.children[0].item;
    expect(sourceGet.sections.blocks[sourceBlockId]._type).toBe("hero");

    const dupRes = await jsonRequest(handler, "POST", `/api/records/${source.id}/duplicate`, { modelApiKey: "page" });
    expect(dupRes.status).toBe(201);
    const dup = await dupRes.json();

    // New record, draft, distinct id
    expect(dup.id).not.toBe(source.id);
    expect(dup._status).toBe("draft");

    // Slug uniquified
    expect(dup.slug).toBe("my-page-2");

    // Envelope intact, block content copied
    const dupBlockId = dup.sections.value.document.children[0].item;
    expect(dup.sections.blocks[dupBlockId]._type).toBe("hero");
    expect(dup.sections.blocks[dupBlockId].headline).toBe("Welcome");

    // Fresh block id — must differ from the source's block id
    expect(dupBlockId).not.toBe(sourceBlockId);
    expect(dup.sections.blocks[sourceBlockId]).toBeUndefined();

    // Source untouched
    const sourceAfter = await (await handler(new Request(`http://localhost/api/records/${source.id}?modelApiKey=page`))).json();
    expect(sourceAfter.slug).toBe("my-page");
    expect(sourceAfter.sections.value.document.children[0].item).toBe(sourceBlockId);
    expect(sourceAfter.sections.blocks[sourceBlockId].headline).toBe("Welcome");
  });

  it("404s for a missing record", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records/nope/duplicate", { modelApiKey: "page" });
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// 4. Bulk status ops — per-id best-effort results
// ===========================================================================
describe("Bulk status operations", () => {
  let handler: Handler;
  let r1: string;
  let r2: string;

  beforeEach(async () => {
    ({ handler } = createTestApp());
    const model = await createModel(handler, { name: "Post", apiKey: "post" });
    await addField(handler, model.id, { label: "Title", apiKey: "title", fieldType: "string" });
    r1 = (await createRecord(handler, "post", { title: "One" })).id;
    r2 = (await createRecord(handler, "post", { title: "Two" })).id;
  });

  it("bulk-publish returns per-id results for a mix of valid/invalid ids", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records/bulk-publish", {
      modelApiKey: "post",
      ids: [r1, r2, "missing"],
    });
    expect(res.status).toBe(200);
    const results = await res.json();
    expect(results).toHaveLength(3);
    const byId = Object.fromEntries(results.map((r: { id: string }) => [r.id, r]));
    expect(byId[r1].ok).toBe(true);
    expect(byId[r2].ok).toBe(true);
    expect(byId.missing.ok).toBe(false);
    expect(typeof byId.missing.error).toBe("string");

    // Effect really happened
    const g1 = await (await handler(new Request(`http://localhost/api/records/${r1}?modelApiKey=post`))).json();
    expect(g1._status).toBe("published");
  });

  it("bulk-unpublish returns per-id results", async () => {
    await jsonRequest(handler, "POST", "/api/records/bulk-publish", { modelApiKey: "post", ids: [r1, r2] });
    const res = await jsonRequest(handler, "POST", "/api/records/bulk-unpublish", {
      modelApiKey: "post",
      ids: [r1, "missing"],
    });
    const results = await res.json();
    const byId = Object.fromEntries(results.map((r: { id: string }) => [r.id, r]));
    expect(byId[r1].ok).toBe(true);
    expect(byId.missing.ok).toBe(false);
  });

  it("bulk-delete returns per-id results and removes valid records", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records/bulk-delete", {
      modelApiKey: "post",
      ids: [r1, "missing", r2],
    });
    const results = await res.json();
    const byId = Object.fromEntries(results.map((r: { id: string }) => [r.id, r]));
    expect(byId[r1].ok).toBe(true);
    expect(byId[r2].ok).toBe(true);
    expect(byId.missing.ok).toBe(false);

    const g1 = await handler(new Request(`http://localhost/api/records/${r1}?modelApiKey=post`));
    expect(g1.status).toBe(404);
  });

  it("rejects an empty id list", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records/bulk-delete", { modelApiKey: "post", ids: [] });
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// 5. Backlinks — GET /api/records/:id/links
// ===========================================================================
describe("GET /api/records/:id/links (backlinks)", () => {
  let handler: Handler;

  beforeEach(() => {
    ({ handler } = createTestApp());
  });

  it("reports inbound references from both link and links fields", async () => {
    const author = await createModel(handler, { name: "Author", apiKey: "author" });
    await addField(handler, author.id, { label: "Name", apiKey: "name", fieldType: "string" });

    const post = await createModel(handler, { name: "Post", apiKey: "post" });
    await addField(handler, post.id, { label: "Title", apiKey: "title", fieldType: "string" });
    await addField(handler, post.id, {
      label: "Author", apiKey: "primary_author", fieldType: "link",
      validators: { item_item_type: ["author"] },
    });
    await addField(handler, post.id, {
      label: "Editors", apiKey: "editors", fieldType: "links",
      validators: { items_item_type: ["author"] },
    });

    const a1 = await createRecord(handler, "author", { name: "Ada" });
    const a2 = await createRecord(handler, "author", { name: "Grace" });
    const p1 = await createRecord(handler, "post", { title: "Hello", primary_author: a1.id, editors: [a1.id] });

    const res = await handler(new Request(`http://localhost/api/records/${a1.id}/links?modelApiKey=author`));
    expect(res.status).toBe(200);
    const links: Array<{ modelApiKey: string; recordId: string; fieldApiKey: string }> = await res.json();

    const fieldKeys = links.filter((l) => l.recordId === p1.id).map((l) => l.fieldApiKey).sort();
    expect(fieldKeys).toEqual(["editors", "primary_author"]);
    for (const l of links) {
      expect(l.modelApiKey).toBe("post");
    }

    // Unreferenced author has no backlinks
    const res2 = await handler(new Request(`http://localhost/api/records/${a2.id}/links?modelApiKey=author`));
    const links2 = await res2.json();
    expect(links2).toHaveLength(0);
  });

  it("404s for a missing record", async () => {
    const author = await createModel(handler, { name: "Author", apiKey: "author" });
    await addField(handler, author.id, { label: "Name", apiKey: "name", fieldType: "string" });
    const res = await handler(new Request(`http://localhost/api/records/nope/links?modelApiKey=author`));
    expect(res.status).toBe(404);
  });
});
