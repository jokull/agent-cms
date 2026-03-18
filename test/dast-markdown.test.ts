import { describe, it, expect } from "vitest";
import {
  dastToMarkdown,
  markdownToDast,
  dastToEditableMarkdown,
  editableMarkdownToDast,
} from "../src/dast/markdown.js";
import type { DastDocument } from "../src/dast/types.js";
import type { PreservationMap } from "../src/dast/markdown.js";
import { validateDast } from "../src/dast/validate.js";

/** Helper: build a minimal DAST doc from block-level children */
function doc(children: DastDocument["document"]["children"]): DastDocument {
  return { schema: "dast", document: { type: "root", children } };
}

const emptyPres: PreservationMap = { nodes: {}, links: {}, itemLinks: {} };

// =========================================================================
// Legacy API (dastToMarkdown / markdownToDast) — basic coverage
// =========================================================================

describe("dastToMarkdown (legacy)", () => {
  it("converts a paragraph with plain text", () => {
    const md = dastToMarkdown(doc([
      { type: "paragraph", children: [{ type: "span", value: "Hello world" }] },
    ]));
    expect(md.trim()).toBe("Hello world");
  });

  it("converts headings", () => {
    const md = dastToMarkdown(doc([
      { type: "heading", level: 1, children: [{ type: "span", value: "Title" }] },
      { type: "heading", level: 3, children: [{ type: "span", value: "Sub" }] },
    ]));
    expect(md).toContain("# Title");
    expect(md).toContain("### Sub");
  });

  it("converts inline marks", () => {
    const md = dastToMarkdown(doc([
      {
        type: "paragraph",
        children: [
          { type: "span", value: "bold", marks: ["strong"] },
          { type: "span", value: " " },
          { type: "span", value: "italic", marks: ["emphasis"] },
          { type: "span", value: " " },
          { type: "span", value: "struck", marks: ["strikethrough"] },
          { type: "span", value: " " },
          { type: "span", value: "mono", marks: ["code"] },
        ],
      },
    ]));
    expect(md).toContain("**bold**");
    expect(md).toMatch(/[*_]italic[*_]/);
    expect(md).toContain("~~struck~~");
    expect(md).toContain("`mono`");
  });

  it("converts links", () => {
    const md = dastToMarkdown(doc([
      {
        type: "paragraph",
        children: [
          { type: "link", url: "https://example.com", children: [{ type: "span", value: "click" }] },
        ],
      },
    ]));
    expect(md).toContain("[click](https://example.com)");
  });

  it("converts itemLinks with itemLink: prefix", () => {
    const md = dastToMarkdown(doc([
      {
        type: "paragraph",
        children: [
          { type: "itemLink", item: "rec_abc", children: [{ type: "span", value: "post" }] },
        ],
      },
    ]));
    expect(md).toContain("[post](itemLink:rec_abc)");
  });

  it("preserves block refs as sentinels", () => {
    const md = dastToMarkdown(doc([
      { type: "paragraph", children: [{ type: "span", value: "intro" }] },
      { type: "block", item: "blk_xyz" },
      { type: "paragraph", children: [{ type: "span", value: "outro" }] },
    ]));
    expect(md).toContain("<!-- cms:block:blk_xyz -->");
  });

  it("preserves inline refs as sentinels", () => {
    const md = dastToMarkdown(doc([
      {
        type: "paragraph",
        children: [
          { type: "span", value: "see " },
          { type: "inlineItem", item: "rec_inline" },
          { type: "span", value: " and " },
          { type: "inlineBlock", item: "iblk_123" },
        ],
      },
    ]));
    expect(md).toContain("<!-- cms:inlineItem:rec_inline -->");
    expect(md).toContain("<!-- cms:inlineBlock:iblk_123 -->");
  });
});

describe("markdownToDast (legacy)", () => {
  it("parses a paragraph", () => {
    const dast = markdownToDast("Hello world");
    expect(dast.document.children).toHaveLength(1);
    expect(dast.document.children[0]).toEqual({
      type: "paragraph",
      children: [{ type: "span", value: "Hello world" }],
    });
  });

  it("produces valid DAST from rich markdown", () => {
    const dast = markdownToDast(
      "# Hello\n\n**bold** and *italic* and [link](https://x.com)\n\n- item\n\n> quote\n\n```ts\ncode\n```\n\n---"
    );
    expect(validateDast(dast)).toEqual([]);
  });
});

// =========================================================================
// Editable API — the core of visual editing
// =========================================================================

describe("dastToEditableMarkdown", () => {
  it("returns markdown and an empty preservation map for simple content", () => {
    const result = dastToEditableMarkdown(doc([
      { type: "paragraph", children: [{ type: "span", value: "Hello" }] },
    ]));
    expect(result.markdown.trim()).toBe("Hello");
    expect(Object.keys(result.preservation.nodes)).toHaveLength(0);
    expect(Object.keys(result.preservation.links)).toHaveLength(0);
  });

  it("preserves paragraph.style in sidecar", () => {
    const result = dastToEditableMarkdown(doc([
      { type: "paragraph", style: "lead", children: [{ type: "span", value: "Big text" }] },
    ]));
    expect(result.preservation.nodes).toHaveProperty("n0");
    expect(result.preservation.nodes["n0"].style).toBe("lead");
    // Sentinel should appear in markdown
    expect(result.markdown).toContain("<!-- cms:n0 -->");
  });

  it("preserves heading.style in sidecar", () => {
    const result = dastToEditableMarkdown(doc([
      { type: "heading", level: 2, style: "accent", children: [{ type: "span", value: "Title" }] },
    ]));
    expect(result.preservation.nodes["n0"].style).toBe("accent");
    expect(result.markdown).toContain("<!-- cms:n0 -->");
  });

  it("preserves blockquote.attribution in sidecar", () => {
    const result = dastToEditableMarkdown(doc([
      {
        type: "blockquote",
        attribution: "— Albert Einstein",
        children: [{ type: "paragraph", children: [{ type: "span", value: "quote" }] }],
      },
    ]));
    expect(result.preservation.nodes["n0"].attribution).toBe("— Albert Einstein");
  });

  it("preserves code.highlight in sidecar", () => {
    const result = dastToEditableMarkdown(doc([
      { type: "code", code: "const x = 1;", language: "ts", highlight: [1, 3] },
    ]));
    expect(result.preservation.nodes["n0"].highlight).toEqual([1, 3]);
  });

  it("does NOT emit sentinel for nodes without extra metadata", () => {
    const result = dastToEditableMarkdown(doc([
      { type: "paragraph", children: [{ type: "span", value: "plain" }] },
      { type: "heading", level: 1, children: [{ type: "span", value: "heading" }] },
    ]));
    expect(result.markdown).not.toContain("<!-- cms:n");
  });

  it("preserves link.meta in sidecar", () => {
    const result = dastToEditableMarkdown(doc([
      {
        type: "paragraph",
        children: [
          {
            type: "link",
            url: "https://example.com",
            meta: [{ id: "rel", value: "nofollow" }],
            children: [{ type: "span", value: "click" }],
          },
        ],
      },
    ]));
    expect(Object.values(result.preservation.links)).toEqual([{
      meta: [{ id: "rel", value: "nofollow" }],
    }]);
    expect(result.markdown).toContain("<!-- cms:linkMeta:");
  });

  it("preserves itemLink.meta in sidecar", () => {
    const result = dastToEditableMarkdown(doc([
      {
        type: "paragraph",
        children: [
          {
            type: "itemLink",
            item: "rec_abc",
            meta: [{ id: "anchor", value: "section-2" }],
            children: [{ type: "span", value: "post" }],
          },
        ],
      },
    ]));
    expect(Object.values(result.preservation.itemLinks)).toEqual([{
      meta: [{ id: "anchor", value: "section-2" }],
    }]);
    expect(result.markdown).toContain("<!-- cms:itemLinkMeta:");
  });

  it("preserves link metadata per occurrence, not just per URL", () => {
    const result = dastToEditableMarkdown(doc([
      {
        type: "paragraph",
        children: [
          {
            type: "link",
            url: "https://example.com",
            meta: [{ id: "rel", value: "nofollow" }],
            children: [{ type: "span", value: "first" }],
          },
          { type: "span", value: " then " },
          {
            type: "link",
            url: "https://example.com",
            meta: [{ id: "rel", value: "ugc" }],
            children: [{ type: "span", value: "second" }],
          },
        ],
      },
    ]));

    expect(result.markdown).toContain("<!-- cms:linkMeta:");
    expect(Object.keys(result.preservation.links)).toHaveLength(2);
  });

  it("preserves itemLink metadata per occurrence, not just per target item", () => {
    const result = dastToEditableMarkdown(doc([
      {
        type: "paragraph",
        children: [
          {
            type: "itemLink",
            item: "rec_same",
            meta: [{ id: "anchor", value: "intro" }],
            children: [{ type: "span", value: "first" }],
          },
          { type: "span", value: " then " },
          {
            type: "itemLink",
            item: "rec_same",
            meta: [{ id: "anchor", value: "details" }],
            children: [{ type: "span", value: "second" }],
          },
        ],
      },
    ]));

    expect(result.markdown).toContain("<!-- cms:itemLinkMeta:");
    expect(Object.keys(result.preservation.itemLinks)).toHaveLength(2);
  });

  it("encodes block and inline ref ids safely in sentinels", () => {
    const result = dastToEditableMarkdown(doc([
      { type: "block", item: "blk / snowman ☃" },
      {
        type: "paragraph",
        children: [
          { type: "inlineItem", item: "rec / alpha β" },
          { type: "span", value: " " },
          { type: "inlineBlock", item: "iblk ? x=y&z" },
        ],
      },
    ]));

    expect(result.markdown).toContain("cms:block:blk%20%2F%20snowman%20%E2%98%83");
    expect(result.markdown).toContain("cms:inlineItem:rec%20%2F%20alpha%20%CE%B2");
    expect(result.markdown).toContain("cms:inlineBlock:iblk%20%3F%20x%3Dy%26z");
  });
});

describe("editableMarkdownToDast", () => {
  it("restores paragraph.style from preservation map", () => {
    const pres: PreservationMap = {
      nodes: { n0: { style: "lead" } },
      links: {},
      itemLinks: {},
    };
    const dast = editableMarkdownToDast("<!-- cms:n0 -->\n\nBig text", pres);
    const para = dast.document.children[0];
    expect(para.type).toBe("paragraph");
    if (para.type === "paragraph") {
      expect(para.style).toBe("lead");
    }
  });

  it("restores blockquote.attribution from preservation map", () => {
    const pres: PreservationMap = {
      nodes: { n0: { attribution: "— Einstein" } },
      links: {},
      itemLinks: {},
    };
    const dast = editableMarkdownToDast("<!-- cms:n0 -->\n\n> wisdom", pres);
    const bq = dast.document.children[0];
    expect(bq.type).toBe("blockquote");
    if (bq.type === "blockquote") {
      expect(bq.attribution).toBe("— Einstein");
    }
  });

  it("restores code.highlight from preservation map", () => {
    const pres: PreservationMap = {
      nodes: { n0: { highlight: [1, 3] } },
      links: {},
      itemLinks: {},
    };
    const dast = editableMarkdownToDast("<!-- cms:n0 -->\n\n```ts\nconst x = 1;\n```", pres);
    const code = dast.document.children[0];
    expect(code.type).toBe("code");
    if (code.type === "code") {
      expect(code.highlight).toEqual([1, 3]);
    }
  });

  it("restores link.meta from preservation map", () => {
    const pres: PreservationMap = {
      nodes: {},
      links: { l0: { meta: [{ id: "rel", value: "nofollow" }] } },
      itemLinks: {},
    };
    const dast = editableMarkdownToDast("[<!-- cms:linkMeta:l0 -->click](https://example.com)", pres);
    const para = dast.document.children[0];
    if (para.type !== "paragraph") return;
    const link = para.children.find((c) => c.type === "link");
    expect(link).toMatchObject({
      type: "link",
      url: "https://example.com",
      meta: [{ id: "rel", value: "nofollow" }],
    });
  });

  it("restores itemLink.meta from preservation map", () => {
    const pres: PreservationMap = {
      nodes: {},
      links: {},
      itemLinks: { i0: { meta: [{ id: "anchor", value: "s2" }] } },
    };
    const dast = editableMarkdownToDast("[<!-- cms:itemLinkMeta:i0 -->post](itemLink:rec_abc)", pres);
    const para = dast.document.children[0];
    if (para.type !== "paragraph") return;
    const link = para.children.find((c) => c.type === "itemLink");
    expect(link).toMatchObject({
      type: "itemLink",
      item: "rec_abc",
      meta: [{ id: "anchor", value: "s2" }],
    });
  });

  it("restores distinct link metadata for repeated URLs", () => {
    const original = doc([
      {
        type: "paragraph",
        children: [
          {
            type: "link",
            url: "https://example.com",
            meta: [{ id: "rel", value: "nofollow" }],
            children: [{ type: "span", value: "first" }],
          },
          { type: "span", value: " then " },
          {
            type: "link",
            url: "https://example.com",
            meta: [{ id: "rel", value: "ugc" }],
            children: [{ type: "span", value: "second" }],
          },
        ],
      },
    ]);

    const { markdown, preservation } = dastToEditableMarkdown(original);
    const result = editableMarkdownToDast(markdown, preservation);
    expect(result).toEqual(original);
  });

  it("restores distinct itemLink metadata for repeated target ids", () => {
    const original = doc([
      {
        type: "paragraph",
        children: [
          {
            type: "itemLink",
            item: "rec_same",
            meta: [{ id: "anchor", value: "intro" }],
            children: [{ type: "span", value: "first" }],
          },
          { type: "span", value: " then " },
          {
            type: "itemLink",
            item: "rec_same",
            meta: [{ id: "anchor", value: "details" }],
            children: [{ type: "span", value: "second" }],
          },
        ],
      },
    ]);

    const { markdown, preservation } = dastToEditableMarkdown(original);
    const result = editableMarkdownToDast(markdown, preservation);
    expect(result).toEqual(original);
  });

  it("restores block ref sentinels", () => {
    const dast = editableMarkdownToDast(
      "intro\n\n<!-- cms:block:blk_xyz -->\n\noutro",
      emptyPres,
    );
    const block = dast.document.children.find((c) => c.type === "block");
    expect(block).toMatchObject({ type: "block", item: "blk_xyz" });
  });

  it("decodes encoded block and inline sentinel ids", () => {
    const dast = editableMarkdownToDast(
      "<!-- cms:block:blk%20%2F%20snowman%20%E2%98%83 -->\n\nsee <!-- cms:inlineItem:rec%20%2F%20alpha%20%CE%B2 --> and <!-- cms:inlineBlock:iblk%20%3F%20x%3Dy%26z -->",
      emptyPres,
    );

    expect(dast.document.children[0]).toMatchObject({ type: "block", item: "blk / snowman ☃" });
    const para = dast.document.children[1];
    if (para.type !== "paragraph") return;
    expect(para.children.find((c) => c.type === "inlineItem")).toMatchObject({
      type: "inlineItem",
      item: "rec / alpha β",
    });
    expect(para.children.find((c) => c.type === "inlineBlock")).toMatchObject({
      type: "inlineBlock",
      item: "iblk ? x=y&z",
    });
  });

  it("does not throw on malformed percent-encoded sentinels", () => {
    expect(() =>
      editableMarkdownToDast("<!-- cms:block:%E0%A4%A -->", emptyPres)
    ).not.toThrow();
  });

  it("restores inline ref sentinels", () => {
    const dast = editableMarkdownToDast(
      "see <!-- cms:inlineItem:rec_inline --> here",
      emptyPres,
    );
    const para = dast.document.children[0];
    if (para.type !== "paragraph") return;
    expect(para.children.find((c) => c.type === "inlineItem")).toMatchObject({
      type: "inlineItem",
      item: "rec_inline",
    });
  });
});

// =========================================================================
// Round-trip: full editing workflow
// =========================================================================

describe("editable round-trip", () => {
  it("preserves all metadata when text is unchanged", () => {
    const original = doc([
      { type: "paragraph", style: "lead", children: [{ type: "span", value: "Lead paragraph" }] },
      {
        type: "blockquote",
        attribution: "— Author",
        children: [{ type: "paragraph", children: [{ type: "span", value: "quote" }] }],
      },
      { type: "code", code: "x = 1", language: "python", highlight: [1] },
      {
        type: "paragraph",
        children: [
          {
            type: "link",
            url: "https://example.com",
            meta: [{ id: "rel", value: "nofollow" }],
            children: [{ type: "span", value: "link" }],
          },
        ],
      },
    ]);

    const { markdown, preservation } = dastToEditableMarkdown(original);
    const result = editableMarkdownToDast(markdown, preservation);

    expect(result).toEqual(original);
  });

  it("preserves metadata when text is edited but structure stays", () => {
    const original = doc([
      { type: "paragraph", style: "lead", children: [{ type: "span", value: "Original text" }] },
    ]);

    const { markdown, preservation } = dastToEditableMarkdown(original);
    // Edit the text
    const edited = markdown.replace("Original text", "Updated text");
    const result = editableMarkdownToDast(edited, preservation);

    expect(result.document.children[0]).toMatchObject({
      type: "paragraph",
      style: "lead",
      children: [{ type: "span", value: "Updated text" }],
    });
  });

  it("deleting a block sentinel removes the block ref", () => {
    const original = doc([
      { type: "paragraph", children: [{ type: "span", value: "before" }] },
      { type: "block", item: "blk_1" },
      { type: "paragraph", children: [{ type: "span", value: "after" }] },
    ]);

    const { markdown, preservation } = dastToEditableMarkdown(original);
    // Remove the block sentinel line
    const edited = markdown.replace(/<!-- cms:block:blk_1 -->\n*/g, "");
    const result = editableMarkdownToDast(edited, preservation);

    expect(result.document.children).toHaveLength(2);
    expect(result.document.children.every((c) => c.type === "paragraph")).toBe(true);
  });

  it("deleting a node metadata sentinel drops metadata but keeps content", () => {
    const original = doc([
      { type: "paragraph", style: "lead", children: [{ type: "span", value: "Keep me" }] },
    ]);

    const { markdown, preservation } = dastToEditableMarkdown(original);
    const edited = markdown.replace(/<!-- cms:n0 -->\n*/g, "");
    const result = editableMarkdownToDast(edited, preservation);

    expect(result).toEqual(doc([
      { type: "paragraph", children: [{ type: "span", value: "Keep me" }] },
    ]));
  });

  it("moving a node metadata sentinel moves the metadata to the following node", () => {
    const original = doc([
      { type: "paragraph", style: "lead", children: [{ type: "span", value: "First" }] },
      { type: "paragraph", children: [{ type: "span", value: "Second" }] },
    ]);

    const { markdown, preservation } = dastToEditableMarkdown(original);
    const edited = markdown
      .replace("<!-- cms:n0 -->\n\nFirst\n\nSecond", "First\n\n<!-- cms:n0 -->\n\nSecond");
    const result = editableMarkdownToDast(edited, preservation);

    expect(result.document.children[0]).toEqual({
      type: "paragraph",
      children: [{ type: "span", value: "First" }],
    });
    expect(result.document.children[1]).toEqual({
      type: "paragraph",
      style: "lead",
      children: [{ type: "span", value: "Second" }],
    });
  });

  it("reordering block sentinels reorders blocks", () => {
    const original = doc([
      { type: "block", item: "blk_a" },
      { type: "paragraph", children: [{ type: "span", value: "middle" }] },
      { type: "block", item: "blk_b" },
    ]);

    const { markdown, preservation } = dastToEditableMarkdown(original);
    // Swap: put blk_b before blk_a
    const edited = markdown
      .replace("<!-- cms:block:blk_a -->", "PLACEHOLDER")
      .replace("<!-- cms:block:blk_b -->", "<!-- cms:block:blk_a -->")
      .replace("PLACEHOLDER", "<!-- cms:block:blk_b -->");
    const result = editableMarkdownToDast(edited, preservation);

    expect(result.document.children[0]).toMatchObject({ type: "block", item: "blk_b" });
    expect(result.document.children[2]).toMatchObject({ type: "block", item: "blk_a" });
  });

  it("adding a new paragraph does not break existing metadata", () => {
    const original = doc([
      { type: "paragraph", style: "lead", children: [{ type: "span", value: "First" }] },
      { type: "paragraph", children: [{ type: "span", value: "Second" }] },
    ]);

    const { markdown, preservation } = dastToEditableMarkdown(original);
    // Add a new paragraph between them
    const edited = markdown.replace("Second", "New paragraph\n\nSecond");
    const result = editableMarkdownToDast(edited, preservation);

    // The first paragraph should keep its style
    expect(result.document.children[0]).toMatchObject({
      type: "paragraph",
      style: "lead",
      children: [{ type: "span", value: "First" }],
    });
    // There should be 3 paragraphs now
    expect(result.document.children).toHaveLength(3);
  });

  it("nodes without metadata don't emit sentinels (clean markdown)", () => {
    const original = doc([
      { type: "heading", level: 1, children: [{ type: "span", value: "Title" }] },
      { type: "paragraph", children: [{ type: "span", value: "Normal paragraph" }] },
      {
        type: "list",
        style: "bulleted",
        children: [
          { type: "listItem", children: [{ type: "paragraph", children: [{ type: "span", value: "item" }] }] },
        ],
      },
    ]);

    const { markdown } = dastToEditableMarkdown(original);
    // No node sentinels because no metadata to preserve
    expect(markdown).not.toContain("<!-- cms:n");
  });

  it("all round-trip outputs pass DAST validation", () => {
    const original = doc([
      { type: "heading", level: 2, style: "accent", children: [{ type: "span", value: "Title" }] },
      { type: "paragraph", style: "lead", children: [{ type: "span", value: "Lead" }] },
      { type: "block", item: "blk_1" },
      {
        type: "blockquote",
        attribution: "— Socrates",
        children: [{ type: "paragraph", children: [{ type: "span", value: "wisdom" }] }],
      },
      { type: "code", code: "x = 1", language: "py", highlight: [1] },
      {
        type: "paragraph",
        children: [
          { type: "link", url: "https://x.com", meta: [{ id: "r", value: "v" }], children: [{ type: "span", value: "link" }] },
          { type: "span", value: " " },
          { type: "itemLink", item: "rec_1", meta: [{ id: "a", value: "b" }], children: [{ type: "span", value: "ref" }] },
          { type: "span", value: " " },
          { type: "inlineItem", item: "rec_2" },
          { type: "span", value: " " },
          { type: "inlineBlock", item: "iblk_1" },
        ],
      },
      { type: "thematicBreak" },
    ]);

    const { markdown, preservation } = dastToEditableMarkdown(original);
    const result = editableMarkdownToDast(markdown, preservation);
    expect(validateDast(result)).toEqual([]);
  });

  it("round-trips combined underline + highlight marks", () => {
    const original = doc([
      {
        type: "paragraph",
        children: [
          { type: "span", value: "combo", marks: ["underline", "highlight"] },
        ],
      },
    ]);

    const { markdown, preservation } = dastToEditableMarkdown(original);
    const result = editableMarkdownToDast(markdown, preservation);
    expect(result).toEqual(original);
  });

  it("escapes HTML-sensitive text inside marked spans", () => {
    const original = doc([
      {
        type: "paragraph",
        children: [
          { type: "span", value: "1 < 2 & </mark> ok", marks: ["highlight"] },
          { type: "span", value: " " },
          { type: "span", value: "x < y & </u> ok", marks: ["underline"] },
        ],
      },
    ]);

    const { markdown, preservation } = dastToEditableMarkdown(original);
    expect(markdown).toContain("&lt;");
    expect(markdown).toContain("&amp;");
    const result = editableMarkdownToDast(markdown, preservation);
    expect(result).toEqual(original);
  });
});

// =========================================================================
// Basic round-trip (legacy wrappers)
// =========================================================================

describe("legacy round-trip", () => {
  const cases: Array<{ name: string; dast: DastDocument }> = [
    {
      name: "plain paragraph",
      dast: doc([{ type: "paragraph", children: [{ type: "span", value: "Hello" }] }]),
    },
    {
      name: "heading + paragraph",
      dast: doc([
        { type: "heading", level: 2, children: [{ type: "span", value: "Title" }] },
        { type: "paragraph", children: [{ type: "span", value: "Body text" }] },
      ]),
    },
    {
      name: "link",
      dast: doc([
        {
          type: "paragraph",
          children: [
            { type: "link", url: "https://example.com", children: [{ type: "span", value: "click" }] },
          ],
        },
      ]),
    },
    {
      name: "itemLink",
      dast: doc([
        {
          type: "paragraph",
          children: [
            { type: "itemLink", item: "rec_123", children: [{ type: "span", value: "see this" }] },
          ],
        },
      ]),
    },
    {
      name: "block ref",
      dast: doc([
        { type: "paragraph", children: [{ type: "span", value: "before" }] },
        { type: "block", item: "blk_abc" },
        { type: "paragraph", children: [{ type: "span", value: "after" }] },
      ]),
    },
    {
      name: "code block",
      dast: doc([{ type: "code", code: "const x = 1;", language: "typescript" }]),
    },
    {
      name: "bulleted list",
      dast: doc([
        {
          type: "list",
          style: "bulleted",
          children: [
            { type: "listItem", children: [{ type: "paragraph", children: [{ type: "span", value: "a" }] }] },
            { type: "listItem", children: [{ type: "paragraph", children: [{ type: "span", value: "b" }] }] },
          ],
        },
      ]),
    },
    {
      name: "blockquote",
      dast: doc([
        { type: "blockquote", children: [{ type: "paragraph", children: [{ type: "span", value: "wisdom" }] }] },
      ]),
    },
    {
      name: "thematic break",
      dast: doc([
        { type: "paragraph", children: [{ type: "span", value: "a" }] },
        { type: "thematicBreak" },
        { type: "paragraph", children: [{ type: "span", value: "b" }] },
      ]),
    },
    {
      name: "marks",
      dast: doc([
        {
          type: "paragraph",
          children: [
            { type: "span", value: "bold", marks: ["strong"] },
            { type: "span", value: " " },
            { type: "span", value: "italic", marks: ["emphasis"] },
          ],
        },
      ]),
    },
  ];

  for (const { name, dast } of cases) {
    it(`round-trips: ${name}`, () => {
      const md = dastToMarkdown(dast);
      const result = markdownToDast(md);
      expect(result).toEqual(dast);
    });

    it(`round-trip produces valid DAST: ${name}`, () => {
      const md = dastToMarkdown(dast);
      const result = markdownToDast(md);
      expect(validateDast(result)).toEqual([]);
    });
  }
});
