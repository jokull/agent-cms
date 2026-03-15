import { describe, it, expect, beforeEach } from "vitest";
import { validateBlocksOnly } from "../src/dast/index.js";
import { createTestApp, jsonRequest } from "./app-helpers.js";

describe("Block-only StructuredText (modular content)", () => {
  describe("validateBlocksOnly", () => {
    it("accepts document with only block nodes", () => {
      const doc = {
        schema: "dast",
        document: {
          type: "root",
          children: [
            { type: "block", item: "block_1" },
            { type: "block", item: "block_2" },
          ],
        },
      };
      expect(validateBlocksOnly(doc)).toEqual([]);
    });

    it("accepts empty document", () => {
      const doc = { schema: "dast", document: { type: "root", children: [] } };
      expect(validateBlocksOnly(doc)).toEqual([]);
    });

    it("rejects paragraph nodes", () => {
      const doc = {
        schema: "dast",
        document: {
          type: "root",
          children: [
            { type: "paragraph", children: [{ type: "span", value: "prose" }] },
          ],
        },
      };
      const errors = validateBlocksOnly(doc);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain("paragraph");
      expect(errors[0].message).toContain("block nodes");
    });

    it("rejects heading nodes", () => {
      const errors = validateBlocksOnly({
        schema: "dast",
        document: {
          type: "root",
          children: [{ type: "heading", level: 1, children: [{ type: "span", value: "Title" }] }],
        },
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain("heading");
    });

    it("rejects mixed block and prose nodes", () => {
      const errors = validateBlocksOnly({
        schema: "dast",
        document: {
          type: "root",
          children: [
            { type: "block", item: "block_1" },
            { type: "paragraph", children: [{ type: "span", value: "prose" }] },
            { type: "block", item: "block_2" },
          ],
        },
      });
      // Only the paragraph should be flagged
      expect(errors).toHaveLength(1);
      expect(errors[0].path).toBe("document.children[1]");
    });
  });

  describe("REST API integration", () => {
    let handler: (req: Request) => Promise<Response>;

    beforeEach(async () => {
      ({ handler } = createTestApp());

      // Block type
      const heroRes = await jsonRequest(handler, "POST", "/api/models", {
        name: "Hero", apiKey: "hero", isBlock: true,
      });
      const hero = await heroRes.json();
      await jsonRequest(handler, "POST", `/api/models/${hero.id}/fields`, {
        label: "Headline", apiKey: "headline", fieldType: "string",
      });

      // Content model with blocks-only ST field
      const pageRes = await jsonRequest(handler, "POST", "/api/models", {
        name: "Page", apiKey: "page",
      });
      const page = await pageRes.json();
      await jsonRequest(handler, "POST", `/api/models/${page.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });
      await jsonRequest(handler, "POST", `/api/models/${page.id}/fields`, {
        label: "Sections", apiKey: "sections", fieldType: "structured_text",
        validators: {
          structured_text_blocks: ["hero"],
          blocks_only: true,
        },
      });
    });

    it("accepts blocks-only content", async () => {
      const blockId = "01HBLOCKS_ONLY_1";
      const res = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "page",
        data: {
          title: "Modular Page",
          sections: {
            value: {
              schema: "dast",
              document: {
                type: "root",
                children: [{ type: "block", item: blockId }],
              },
            },
            blocks: {
              [blockId]: { _type: "hero", headline: "Welcome" },
            },
          },
        },
      });
      expect(res.status).toBe(201);
    });

    it("rejects prose in blocks-only field", async () => {
      const res = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "page",
        data: {
          title: "Bad Page",
          sections: {
            value: {
              schema: "dast",
              document: {
                type: "root",
                children: [
                  { type: "paragraph", children: [{ type: "span", value: "not allowed" }] },
                ],
              },
            },
            blocks: {},
          },
        },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("block nodes");
    });

    it("rejects mixed block + prose in blocks-only field", async () => {
      const blockId = "01HBLOCKS_MIX_1";
      const res = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "page",
        data: {
          title: "Mixed Page",
          sections: {
            value: {
              schema: "dast",
              document: {
                type: "root",
                children: [
                  { type: "block", item: blockId },
                  { type: "heading", level: 1, children: [{ type: "span", value: "Not allowed" }] },
                ],
              },
            },
            blocks: {
              [blockId]: { _type: "hero", headline: "Fine" },
            },
          },
        },
      });
      expect(res.status).toBe(400);
    });
  });
});
