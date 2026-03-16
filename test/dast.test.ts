import { describe, it, expect } from "vitest";
import { validateDast, extractBlockIds, extractInlineBlockIds, extractAllBlockIds, extractLinkIds } from "../src/dast/index.js";

describe("DAST Validation", () => {
  describe("valid documents", () => {
    it("validates a minimal document", () => {
      const doc = {
        schema: "dast",
        document: { type: "root", children: [] },
      };
      expect(validateDast(doc)).toEqual([]);
    });

    it("validates a document with paragraph + span", () => {
      const doc = {
        schema: "dast",
        document: {
          type: "root",
          children: [
            {
              type: "paragraph",
              children: [{ type: "span", value: "Hello world" }],
            },
          ],
        },
      };
      expect(validateDast(doc)).toEqual([]);
    });

    it("validates spans with marks", () => {
      const doc = {
        schema: "dast",
        document: {
          type: "root",
          children: [
            {
              type: "paragraph",
              children: [
                { type: "span", value: "bold", marks: ["strong"] },
                { type: "span", value: "italic", marks: ["emphasis"] },
                { type: "span", value: "multi", marks: ["strong", "emphasis", "code"] },
              ],
            },
          ],
        },
      };
      expect(validateDast(doc)).toEqual([]);
    });

    it("validates headings", () => {
      const doc = {
        schema: "dast",
        document: {
          type: "root",
          children: [
            { type: "heading", level: 1, children: [{ type: "span", value: "Title" }] },
            { type: "heading", level: 3, children: [{ type: "span", value: "Subtitle" }] },
          ],
        },
      };
      expect(validateDast(doc)).toEqual([]);
    });

    it("validates lists", () => {
      const doc = {
        schema: "dast",
        document: {
          type: "root",
          children: [
            {
              type: "list",
              style: "bulleted",
              children: [
                {
                  type: "listItem",
                  children: [
                    { type: "paragraph", children: [{ type: "span", value: "Item 1" }] },
                  ],
                },
                {
                  type: "listItem",
                  children: [
                    { type: "paragraph", children: [{ type: "span", value: "Item 2" }] },
                  ],
                },
              ],
            },
          ],
        },
      };
      expect(validateDast(doc)).toEqual([]);
    });

    it("validates code blocks", () => {
      const doc = {
        schema: "dast",
        document: {
          type: "root",
          children: [
            { type: "code", code: "const x = 1;", language: "typescript" },
          ],
        },
      };
      expect(validateDast(doc)).toEqual([]);
    });

    it("validates blockquotes", () => {
      const doc = {
        schema: "dast",
        document: {
          type: "root",
          children: [
            {
              type: "blockquote",
              children: [
                { type: "paragraph", children: [{ type: "span", value: "A quote" }] },
              ],
            },
          ],
        },
      };
      expect(validateDast(doc)).toEqual([]);
    });

    it("validates thematic breaks", () => {
      const doc = {
        schema: "dast",
        document: {
          type: "root",
          children: [
            { type: "paragraph", children: [{ type: "span", value: "Before" }] },
            { type: "thematicBreak" },
            { type: "paragraph", children: [{ type: "span", value: "After" }] },
          ],
        },
      };
      expect(validateDast(doc)).toEqual([]);
    });

    it("validates block references", () => {
      const doc = {
        schema: "dast",
        document: {
          type: "root",
          children: [
            { type: "block", item: "block_abc123" },
          ],
        },
      };
      expect(validateDast(doc)).toEqual([]);
    });

    it("validates links", () => {
      const doc = {
        schema: "dast",
        document: {
          type: "root",
          children: [
            {
              type: "paragraph",
              children: [
                {
                  type: "link",
                  url: "https://example.com",
                  children: [{ type: "span", value: "Click here" }],
                },
              ],
            },
          ],
        },
      };
      expect(validateDast(doc)).toEqual([]);
    });

    it("validates itemLink and inlineItem", () => {
      const doc = {
        schema: "dast",
        document: {
          type: "root",
          children: [
            {
              type: "paragraph",
              children: [
                { type: "itemLink", item: "rec_123", children: [{ type: "span", value: "linked record" }] },
                { type: "inlineItem", item: "rec_456" },
                { type: "inlineBlock", item: "block_789" },
              ],
            },
          ],
        },
      };
      expect(validateDast(doc)).toEqual([]);
    });
  });

  describe("invalid documents", () => {
    it("rejects non-object", () => {
      expect(validateDast("string")).toHaveLength(1);
      expect(validateDast(null)).toHaveLength(1);
    });

    it("rejects wrong schema", () => {
      const errors = validateDast({ schema: "wrong", document: { type: "root", children: [] } });
      expect(errors.some((e) => e.message.includes("dast"))).toBe(true);
    });

    it("rejects invalid root type", () => {
      const errors = validateDast({ schema: "dast", document: { type: "paragraph", children: [] } });
      expect(errors.some((e) => e.message.includes("root"))).toBe(true);
    });

    it("rejects invalid block-level node", () => {
      const errors = validateDast({
        schema: "dast",
        document: { type: "root", children: [{ type: "span", value: "wrong level" }] },
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it("rejects invalid heading level", () => {
      const errors = validateDast({
        schema: "dast",
        document: { type: "root", children: [{ type: "heading", level: 7, children: [] }] },
      });
      expect(errors.some((e) => e.message.includes("1-6"))).toBe(true);
    });

    it("rejects invalid marks", () => {
      const errors = validateDast({
        schema: "dast",
        document: {
          type: "root",
          children: [
            { type: "paragraph", children: [{ type: "span", value: "x", marks: ["invalid_mark"] }] },
          ],
        },
      });
      expect(errors.some((e) => e.message.includes("Invalid mark"))).toBe(true);
    });

    it("rejects block node without item", () => {
      const errors = validateDast({
        schema: "dast",
        document: { type: "root", children: [{ type: "block" }] },
      });
      expect(errors.some((e) => e.message.includes("item ID"))).toBe(true);
    });

    it("rejects code block without code string", () => {
      const errors = validateDast({
        schema: "dast",
        document: { type: "root", children: [{ type: "code" }] },
      });
      expect(errors.some((e) => e.message.includes("code string"))).toBe(true);
    });
  });

  describe("extractBlockIds / extractInlineBlockIds / extractAllBlockIds", () => {
    const doc = {
      schema: "dast" as const,
      document: {
        type: "root" as const,
        children: [
          { type: "block" as const, item: "block_1" },
          {
            type: "paragraph" as const,
            children: [
              { type: "inlineBlock" as const, item: "inline_1" },
              { type: "span" as const, value: "text" },
            ],
          },
          { type: "block" as const, item: "block_2" },
        ],
      },
    };

    it("extractBlockIds returns only block-level IDs", () => {
      expect(extractBlockIds(doc as any)).toEqual(["block_1", "block_2"]);
    });

    it("extractInlineBlockIds returns only inline block IDs", () => {
      expect(extractInlineBlockIds(doc as any)).toEqual(["inline_1"]);
    });

    it("extractAllBlockIds returns both", () => {
      expect(extractAllBlockIds(doc as any)).toEqual(["block_1", "inline_1", "block_2"]);
    });

    it("returns empty for document without blocks", () => {
      const doc = {
        schema: "dast" as const,
        document: {
          type: "root" as const,
          children: [
            { type: "paragraph" as const, children: [{ type: "span" as const, value: "no blocks" }] },
          ],
        },
      };
      expect(extractBlockIds(doc as any)).toEqual([]);
    });
  });

  describe("extractLinkIds", () => {
    it("extracts itemLink and inlineItem IDs", () => {
      const doc = {
        schema: "dast" as const,
        document: {
          type: "root" as const,
          children: [
            {
              type: "paragraph" as const,
              children: [
                { type: "itemLink" as const, item: "rec_1", children: [{ type: "span" as const, value: "link" }] },
                { type: "inlineItem" as const, item: "rec_2" },
                { type: "span" as const, value: "text" },
              ],
            },
          ],
        },
      };
      expect(extractLinkIds(doc as any)).toEqual(["rec_1", "rec_2"]);
    });
  });
});
