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

  it("create_record with Agent Text string as structured_text value", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: "Agent Text Article",
        body: "# Hello World\n\nThis is a paragraph.",
      },
    });

    expect(res.status).toBe(201);
    const record = await res.json();
    expect(record.title).toBe("Agent Text Article");
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

  it("create_record with canonical { text, blocks } wrapper", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: "Agent Text with Blocks",
        body: {
          text: "Hello\n\n[[block:c1]]\n\nGoodbye",
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

  it("create_record with canonical handles for block and inline block placement", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: "Agent Text with Blocks",
        body: {
          text: [
            "Hello from Agent Text",
            "",
            "[[block:c1]]",
            "",
            "Goodbye with an [[inline_block:c2]].",
          ].join("\n"),
          blocks: [
            { id: "c1", type: "callout", data: { message: "Primary block" } },
            { id: "c2", type: "callout", data: { message: "Inline block" } },
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
    expect(children[1]).toEqual({ type: "block", item: "c1" });
    expect(children[2].children[1]).toEqual({ type: "inlineBlock", item: "c2" });
  });

  it("create_record with explicit { agentText, blocks } wrapper alias", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: "Agent Text Alias",
        body: {
          agentText: "Hello\n\n[[block:c1]]",
          blocks: [
            { id: "c1", type: "callout", data: { message: "Alias works" } },
          ],
        },
      },
    });

    expect(res.status).toBe(201);
    const record = await res.json();
    const body = typeof record.body === "string" ? JSON.parse(record.body) : record.body;
    expect(body.document.children[1]).toEqual({ type: "block", item: "c1" });
  });

  it("create_record with Agent Text record links", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: "Agent Text Links",
        body: {
          text: "Read [[record:rec_123|the related record]].",
        },
      },
    });

    expect(res.status).toBe(201);
    const record = await res.json();
    const body = typeof record.body === "string" ? JSON.parse(record.body) : record.body;
    expect(body.schema).toBe("dast");
    expect(body.document.children[0].children[1]).toEqual({
      type: "itemLink",
      item: "rec_123",
      children: [{ type: "span", value: "the related record" }],
    });
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

  it("keeps normal Markdown formatting inside Agent Text", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: "Inline Markdown",
        body: "This is **bold** and has a [link](https://example.com)",
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

  it("block handles in Agent Text mode", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: "Handle Blocks",
        body: {
          text: "Intro paragraph\n\n[[block:b1]]\n\nOutro paragraph",
          blocks: [
            { id: "b1", type: "callout", data: { message: "A handle block" } },
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
    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: "Original",
        body: "Original content",
      },
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

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

  it("supports common Markdown block structure in Agent Text", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: "Full Agent Text",
        body: [
          "> A wise quote",
          "",
          "1. First",
          "2. Second",
          "3. Third",
          "",
          "---",
          "",
          "- Bullet A",
          "- Bullet B",
        ].join("\n"),
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
