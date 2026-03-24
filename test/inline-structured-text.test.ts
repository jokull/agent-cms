import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest } from "./app-helpers.js";

describe("Inline structured_text shorthand", () => {
  let handler: (req: Request) => Promise<Response>;
  let sqlLayer: any;

  beforeEach(async () => {
    ({ handler, sqlLayer } = createTestApp());

    // Create a block type: callout
    const calloutRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Callout", apiKey: "callout", isBlock: true,
    });
    const callout = await calloutRes.json();

    await jsonRequest(handler, "POST", `/api/models/${callout.id}/fields`, {
      label: "Message", apiKey: "message", fieldType: "string",
    });

    // Create content model: article
    const articleRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Article", apiKey: "article",
    });
    const article = await articleRes.json();

    await jsonRequest(handler, "POST", `/api/models/${article.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${article.id}/fields`, {
      label: "Body", apiKey: "body", fieldType: "structured_text",
      validators: { structured_text_blocks: ["callout"] },
    });
  });

  it("create_record with markdown string as structured_text value", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: "Markdown Article",
        body: "# Hello World\n\nThis is a paragraph.",
      },
    });

    expect(res.status).toBe(201);
    const record = await res.json();
    expect(record.title).toBe("Markdown Article");
    // Verify DAST was produced
    const body = typeof record.body === "string" ? JSON.parse(record.body) : record.body;
    expect(body.schema).toBe("dast");
    expect(body.document.type).toBe("root");
    // Should have heading + paragraph
    const children = body.document.children;
    expect(children.length).toBe(2);
    expect(children[0].type).toBe("heading");
    expect(children[0].level).toBe(1);
    expect(children[1].type).toBe("paragraph");
  });

  it("create_record with typed nodes array as structured_text value", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: "Typed Nodes Article",
        body: [
          { type: "paragraph", text: "Hello world" },
          { type: "heading", level: 2, text: "Section" },
          { type: "code", code: "const x = 1;", language: "typescript" },
        ],
      },
    });

    expect(res.status).toBe(201);
    const record = await res.json();
    const body = typeof record.body === "string" ? JSON.parse(record.body) : record.body;
    expect(body.schema).toBe("dast");
    const children = body.document.children;
    expect(children.length).toBe(3);
    expect(children[0].type).toBe("paragraph");
    expect(children[1].type).toBe("heading");
    expect(children[1].level).toBe(2);
    expect(children[2].type).toBe("code");
    expect(children[2].code).toBe("const x = 1;");
    expect(children[2].language).toBe("typescript");
  });

  it("create_record with { markdown, blocks } wrapper", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: "Markdown with Blocks",
        body: {
          markdown: "Hello\n\n<!-- cms:block:c1 -->\n\nGoodbye",
          blocks: [
            { id: "c1", type: "callout", data: { message: "Important!" } },
          ],
        },
      },
    });

    expect(res.status).toBe(201);
    const record = await res.json();
    const body = typeof record.body === "string" ? JSON.parse(record.body) : record.body;
    expect(body.schema).toBe("dast");
    // Should have paragraph, block, paragraph
    const children = body.document.children;
    expect(children.length).toBe(3);
    expect(children[0].type).toBe("paragraph");
    expect(children[1].type).toBe("block");
    expect(children[2].type).toBe("paragraph");
  });

  it("create_record with { nodes, blocks } wrapper", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: "Nodes with Blocks",
        body: {
          nodes: [
            { type: "paragraph", text: "Before the block" },
            { type: "block", ref: "c1" },
            { type: "paragraph", text: "After the block" },
          ],
          blocks: [
            { id: "c1", type: "callout", data: { message: "Watch out!" } },
          ],
        },
      },
    });

    expect(res.status).toBe(201);
    const record = await res.json();
    const body = typeof record.body === "string" ? JSON.parse(record.body) : record.body;
    expect(body.schema).toBe("dast");
    const children = body.document.children;
    expect(children.length).toBe(3);
    expect(children[0].type).toBe("paragraph");
    expect(children[1].type).toBe("block");
    expect(children[2].type).toBe("paragraph");
  });

  it("create_record with current DAST envelope (backward compat)", async () => {
    const blockId = "01HTEST_BLOCK_001";
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: "Full DAST",
        body: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                {
                  type: "paragraph",
                  children: [{ type: "span", value: "Classic format" }],
                },
                { type: "block", item: blockId },
              ],
            },
          },
          blocks: {
            [blockId]: {
              _type: "callout",
              message: "Still works!",
            },
          },
        },
      },
    });

    expect(res.status).toBe(201);
    const record = await res.json();
    const body = typeof record.body === "string" ? JSON.parse(record.body) : record.body;
    expect(body.schema).toBe("dast");
    expect(body.document.children.length).toBe(2);
    expect(body.document.children[0].type).toBe("paragraph");
    expect(body.document.children[1].type).toBe("block");
  });

  it("inline markdown in typed node text fields (bold, links)", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: "Inline Markdown",
        body: [
          { type: "paragraph", text: "This is **bold** and has a [link](https://example.com)" },
        ],
      },
    });

    expect(res.status).toBe(201);
    const record = await res.json();
    const body = typeof record.body === "string" ? JSON.parse(record.body) : record.body;
    const para = body.document.children[0];
    expect(para.type).toBe("paragraph");
    // Should have inline children with marks
    const children = para.children;
    expect(children.length).toBeGreaterThan(1);
    // Find the bold span
    const boldSpan = children.find(
      (c: any) => c.type === "span" && c.marks && c.marks.includes("strong")
    );
    expect(boldSpan).toBeDefined();
    expect(boldSpan.value).toBe("bold");
    // Find the link
    const link = children.find((c: any) => c.type === "link");
    expect(link).toBeDefined();
    expect(link.url).toBe("https://example.com");
  });

  it("block sentinels in markdown mode", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: "Sentinel Blocks",
        body: {
          markdown: "Intro paragraph\n\n<!-- cms:block:b1 -->\n\nOutro paragraph",
          blocks: [
            { id: "b1", type: "callout", data: { message: "A sentinel block" } },
          ],
        },
      },
    });

    expect(res.status).toBe(201);
    const record = await res.json();
    const body = typeof record.body === "string" ? JSON.parse(record.body) : record.body;
    const children = body.document.children;
    expect(children[0].type).toBe("paragraph");
    expect(children[1].type).toBe("block");
    expect(children[2].type).toBe("paragraph");
  });

  it("update_record with simplified format", async () => {
    // First create with traditional format
    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: "Original",
        body: "Original content",
      },
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    // Update with markdown string via PATCH
    const updateRes = await jsonRequest(handler, "PATCH", `/api/records/${created.id}`, {
      modelApiKey: "article",
      data: {
        body: "# Updated\n\nNew content here.",
      },
    });
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    const body = typeof updated.body === "string" ? JSON.parse(updated.body) : updated.body;
    expect(body.schema).toBe("dast");
    expect(body.document.children[0].type).toBe("heading");
    expect(body.document.children[1].type).toBe("paragraph");
  });

  it("typed nodes with list, blockquote, and thematicBreak", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: "Full Nodes",
        body: [
          { type: "blockquote", text: "A wise quote" },
          { type: "list", style: "numbered", items: ["First", "Second", "Third"] },
          { type: "thematicBreak" },
          { type: "list", items: ["Bullet A", "Bullet B"] },
        ],
      },
    });

    expect(res.status).toBe(201);
    const record = await res.json();
    const body = typeof record.body === "string" ? JSON.parse(record.body) : record.body;
    const children = body.document.children;
    expect(children[0].type).toBe("blockquote");
    expect(children[1].type).toBe("list");
    expect(children[1].style).toBe("numbered");
    expect(children[1].children.length).toBe(3);
    expect(children[2].type).toBe("thematicBreak");
    expect(children[3].type).toBe("list");
    expect(children[3].style).toBe("bulleted");
  });
});
