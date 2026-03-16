import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest } from "./app-helpers.js";
import { extractDastText, extractDastSections, extractRecordText } from "../src/search/extract-text.js";
import type { ParsedFieldRow } from "../src/db/row-types.js";

// --- Unit tests for text extraction ---

describe("extractDastText", () => {
  it("extracts text from paragraphs", () => {
    const dast = {
      schema: "dast",
      document: {
        type: "root",
        children: [
          { type: "paragraph", children: [{ type: "span", value: "Hello world" }] },
          { type: "paragraph", children: [{ type: "span", value: "Second paragraph" }] },
        ],
      },
    };
    expect(extractDastText(dast)).toBe("Hello world Second paragraph");
  });

  it("extracts text from headings", () => {
    const dast = {
      schema: "dast",
      document: {
        type: "root",
        children: [
          { type: "heading", level: 2, children: [{ type: "span", value: "My Heading" }] },
          { type: "paragraph", children: [{ type: "span", value: "Body text" }] },
        ],
      },
    };
    expect(extractDastText(dast)).toBe("My Heading Body text");
  });

  it("extracts text from lists", () => {
    const dast = {
      schema: "dast",
      document: {
        type: "root",
        children: [
          {
            type: "list", style: "bulleted",
            children: [
              { type: "listItem", children: [{ type: "paragraph", children: [{ type: "span", value: "Item one" }] }] },
              { type: "listItem", children: [{ type: "paragraph", children: [{ type: "span", value: "Item two" }] }] },
            ],
          },
        ],
      },
    };
    expect(extractDastText(dast)).toBe("Item one Item two");
  });

  it("extracts text from blockquotes", () => {
    const dast = {
      schema: "dast",
      document: {
        type: "root",
        children: [
          {
            type: "blockquote",
            children: [{ type: "paragraph", children: [{ type: "span", value: "A famous quote" }] }],
          },
        ],
      },
    };
    expect(extractDastText(dast)).toBe("A famous quote");
  });

  it("extracts code from code blocks", () => {
    const dast = {
      schema: "dast",
      document: {
        type: "root",
        children: [
          { type: "code", code: "const x = 1;" },
        ],
      },
    };
    expect(extractDastText(dast)).toBe("const x = 1;");
  });

  it("handles marked spans", () => {
    const dast = {
      schema: "dast",
      document: {
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [
              { type: "span", value: "Hello " },
              { type: "span", value: "bold", marks: ["strong"] },
              { type: "span", value: " world" },
            ],
          },
        ],
      },
    };
    expect(extractDastText(dast)).toBe("Hello bold world");
  });

  it("extracts text from link children", () => {
    const dast = {
      schema: "dast",
      document: {
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [
              { type: "span", value: "Click " },
              { type: "link", url: "https://example.com", children: [{ type: "span", value: "here" }] },
            ],
          },
        ],
      },
    };
    expect(extractDastText(dast)).toBe("Click here");
  });

  it("returns empty string for null/undefined", () => {
    expect(extractDastText(null)).toBe("");
    expect(extractDastText(undefined)).toBe("");
    expect(extractDastText({})).toBe("");
  });
});

describe("extractDastSections", () => {
  it("splits on heading boundaries", () => {
    const dast = {
      schema: "dast",
      document: {
        type: "root",
        children: [
          { type: "paragraph", children: [{ type: "span", value: "Intro text" }] },
          { type: "heading", level: 2, children: [{ type: "span", value: "Section One" }] },
          { type: "paragraph", children: [{ type: "span", value: "Section one body" }] },
          { type: "heading", level: 2, children: [{ type: "span", value: "Section Two" }] },
          { type: "paragraph", children: [{ type: "span", value: "Section two body" }] },
        ],
      },
    };
    const sections = extractDastSections(dast);
    expect(sections).toHaveLength(3);
    expect(sections[0]).toEqual({ heading: undefined, text: "Intro text" });
    expect(sections[1]).toEqual({ heading: "Section One", text: "Section one body" });
    expect(sections[2]).toEqual({ heading: "Section Two", text: "Section two body" });
  });
});

describe("extractRecordText", () => {
  const makeField = (overrides: Partial<ParsedFieldRow>): ParsedFieldRow => ({
    id: "f1",
    model_id: "m1",
    label: "Field",
    api_key: "field",
    field_type: "string",
    position: 0,
    localized: 0,
    validators: {},
    default_value: null,
    appearance: null,
    hint: null,
    fieldset_id: null,
    created_at: "",
    updated_at: "",
    ...overrides,
  });

  it("uses 'title' field for title column", () => {
    const fields = [
      makeField({ api_key: "title", field_type: "string" }),
      makeField({ api_key: "body", field_type: "text", position: 1 }),
    ];
    const record = { title: "My Title", body: "My body text" };
    const result = extractRecordText(record, fields);
    expect(result.title).toBe("My Title");
    expect(result.body).toBe("My body text");
  });

  it("extracts SEO title and description", () => {
    const fields = [
      makeField({ api_key: "seo", field_type: "seo" }),
    ];
    const record = { seo: { title: "SEO Title", description: "SEO description" } };
    const result = extractRecordText(record, fields);
    expect(result.body).toContain("SEO Title");
    expect(result.body).toContain("SEO description");
  });

  it("extracts text from localized string fields", () => {
    const fields = [
      makeField({ api_key: "name", field_type: "string", localized: 1 }),
    ];
    const record = { name: { en: "English name", is: "Íslenskt nafn" } };
    const result = extractRecordText(record, fields);
    expect(result.title).toContain("English name");
    expect(result.title).toContain("Íslenskt nafn");
  });

  it("skips non-text fields", () => {
    const fields = [
      makeField({ api_key: "title", field_type: "string" }),
      makeField({ api_key: "views", field_type: "integer", position: 1 }),
      makeField({ api_key: "active", field_type: "boolean", position: 2 }),
    ];
    const record = { title: "Post", views: 42, active: true };
    const result = extractRecordText(record, fields);
    expect(result.title).toBe("Post");
    expect(result.body).toBe("");
  });
});

// --- Integration tests ---

describe("FTS5 Search Integration", () => {
  let handler: (req: Request) => Promise<Response>;
  let modelId: string;

  beforeEach(async () => {
    ({ handler } = createTestApp());
    const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
    const model = await modelRes.json();
    modelId = model.id;

    await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, { label: "Title", apiKey: "title", fieldType: "string" });
    await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, { label: "Body", apiKey: "body", fieldType: "text" });
  });

  it("creates FTS5 table automatically with model", async () => {
    // Search should work even with no records
    const res = await jsonRequest(handler, "POST", "/api/search", { query: "hello", modelApiKey: "post" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.results).toEqual([]);
  });

  it("indexes records on create and finds them", async () => {
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: { title: "Hello World", body: "This is my first blog post about TypeScript" },
    });

    const res = await jsonRequest(handler, "POST", "/api/search", { query: "TypeScript", modelApiKey: "post" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.results).toHaveLength(1);
    expect(data.results[0].modelApiKey).toBe("post");
  });

  it("updates search index on record update", async () => {
    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: { title: "Original Title", body: "Original content" },
    });
    const record = await createRes.json();

    // Update the record
    await jsonRequest(handler, "PATCH", `/api/records/${record.id}`, {
      modelApiKey: "post",
      data: { title: "Updated Title", body: "Completely new content about Rust" },
    });

    // Old text should not be found
    const oldRes = await jsonRequest(handler, "POST", "/api/search", { query: "Original", modelApiKey: "post" });
    const oldData = await oldRes.json();
    expect(oldData.results).toHaveLength(0);

    // New text should be found
    const newRes = await jsonRequest(handler, "POST", "/api/search", { query: "Rust", modelApiKey: "post" });
    const newData = await newRes.json();
    expect(newData.results).toHaveLength(1);
  });

  it("removes from index on record delete", async () => {
    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: { title: "To Be Deleted", body: "Ephemeral content" },
    });
    const record = await createRes.json();

    // Delete
    await jsonRequest(handler, "DELETE", `/api/records/${record.id}?modelApiKey=post`);

    // Should no longer be found
    const res = await jsonRequest(handler, "POST", "/api/search", { query: "Ephemeral", modelApiKey: "post" });
    const data = await res.json();
    expect(data.results).toHaveLength(0);
  });

  it("supports FTS5 phrase search", async () => {
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: { title: "Phrase Test", body: "The quick brown fox jumps over the lazy dog" },
    });

    // Phrase match
    const phraseRes = await jsonRequest(handler, "POST", "/api/search", { query: '"quick brown fox"', modelApiKey: "post" });
    const phraseData = await phraseRes.json();
    expect(phraseData.results).toHaveLength(1);

    // Non-matching phrase
    const noRes = await jsonRequest(handler, "POST", "/api/search", { query: '"quick lazy fox"', modelApiKey: "post" });
    const noData = await noRes.json();
    expect(noData.results).toHaveLength(0);
  });

  it("searches across multiple models", async () => {
    // Create a second model
    const model2Res = await jsonRequest(handler, "POST", "/api/models", { name: "Page", apiKey: "page" });
    const model2 = await model2Res.json();
    await jsonRequest(handler, "POST", `/api/models/${model2.id}/fields`, { label: "Title", apiKey: "title", fieldType: "string" });
    await jsonRequest(handler, "POST", `/api/models/${model2.id}/fields`, { label: "Content", apiKey: "content", fieldType: "text" });

    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: { title: "Post about Cloudflare", body: "Workers are great" },
    });
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: { title: "About Cloudflare", content: "We use Cloudflare for everything" },
    });

    // Cross-model search (no modelApiKey)
    const res = await jsonRequest(handler, "POST", "/api/search", { query: "Cloudflare" });
    const data = await res.json();
    expect(data.results).toHaveLength(2);
    const models = data.results.map((r: any) => r.modelApiKey).sort();
    expect(models).toEqual(["page", "post"]);
  });

  it("rejects empty query", async () => {
    const res = await jsonRequest(handler, "POST", "/api/search", { query: "" });
    expect(res.status).toBe(400);
  });

  it("does not create FTS table for block models", async () => {
    const blockRes = await jsonRequest(handler, "POST", "/api/models", { name: "CTA", apiKey: "cta", isBlock: true });
    expect(blockRes.status).toBe(201);

    // Searching the block model should fail gracefully or return empty
    // (no fts_cta table exists)
  });

  it("handles structured_text field search", async () => {
    // Create a model with structured_text
    const stModelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Article", apiKey: "article" });
    const stModel = await stModelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${stModel.id}/fields`, { label: "Title", apiKey: "title", fieldType: "string" });
    await jsonRequest(handler, "POST", `/api/models/${stModel.id}/fields`, { label: "Content", apiKey: "content", fieldType: "structured_text" });

    // Create record with DAST content
    const dast = {
      value: {
        schema: "dast",
        document: {
          type: "root",
          children: [
            { type: "paragraph", children: [{ type: "span", value: "This article discusses serverless computing" }] },
            { type: "heading", level: 2, children: [{ type: "span", value: "Benefits of Edge Functions" }] },
            { type: "paragraph", children: [{ type: "span", value: "Edge functions run close to your users" }] },
          ],
        },
      },
    };

    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: { title: "Edge Computing", content: dast },
    });

    // Search for text from the DAST content
    const res = await jsonRequest(handler, "POST", "/api/search", { query: "serverless", modelApiKey: "article" });
    const data = await res.json();
    expect(data.results).toHaveLength(1);
  });

  it("handles SEO field search", async () => {
    const seoModelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Landing", apiKey: "landing" });
    const seoModel = await seoModelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${seoModel.id}/fields`, { label: "Title", apiKey: "title", fieldType: "string" });
    await jsonRequest(handler, "POST", `/api/models/${seoModel.id}/fields`, { label: "SEO", apiKey: "seo", fieldType: "seo" });

    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "landing",
      data: {
        title: "Our Product",
        seo: { title: "Best Product Ever", description: "Revolutionary widget for productivity" },
      },
    });

    const res = await jsonRequest(handler, "POST", "/api/search", { query: "productivity", modelApiKey: "landing" });
    const data = await res.json();
    expect(data.results).toHaveLength(1);
  });

  it("supports pagination with first and skip", async () => {
    // Create multiple records
    for (let i = 0; i < 5; i++) {
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post",
        data: { title: `Searchable Post ${i}`, body: "Common keyword here" },
      });
    }

    const page1 = await jsonRequest(handler, "POST", "/api/search", { query: "keyword", modelApiKey: "post", first: 2 });
    const page1Data = await page1.json();
    expect(page1Data.results).toHaveLength(2);

    const page2 = await jsonRequest(handler, "POST", "/api/search", { query: "keyword", modelApiKey: "post", first: 2, skip: 2 });
    const page2Data = await page2.json();
    expect(page2Data.results).toHaveLength(2);
  });
});
