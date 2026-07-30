import type { DastDocument, StructuredTextEnvelope } from "@agent-cms/editor-react";
import type { DemoBlock } from "./blocks.js";

/**
 * A hand-written envelope exercising every DAST node type the toolkit
 * supports, so the demo starts non-empty and every toolbar/blockView code
 * path has something to click on immediately.
 */
export const seedEnvelope: StructuredTextEnvelope<DemoBlock> = {
  value: {
    schema: "dast",
    document: {
      type: "root",
      children: [
        {
          type: "heading",
          level: 1,
          children: [{ type: "span", value: "editor-react demo", marks: ["strong"] }],
        },
        {
          type: "paragraph",
          children: [
            { type: "span", value: "This paragraph carries a " },
            { type: "span", value: "custom mark", marks: ["customMark_kbd"] },
            { type: "span", value: " (rendered as " },
            { type: "span", value: "customMark_kbd", marks: ["code"] },
            { type: "span", value: ") plus a " },
            { type: "span", value: "regular link", marks: ["emphasis"] },
            { type: "span", value: "." },
          ],
        },
        {
          type: "paragraph",
          children: [
            { type: "span", value: "External: " },
            {
              type: "link",
              url: "https://example.com",
              children: [{ type: "span", value: "example.com" }],
            },
            { type: "span", value: "  Record link: " },
            {
              type: "itemLink",
              item: "record-42",
              children: [{ type: "span", value: "record #42" }],
            },
            { type: "span", value: "  Inline record: " },
            { type: "inlineItem", item: "record-7" },
          ],
        },
        {
          type: "heading",
          level: 2,
          children: [{ type: "span", value: "Lists" }],
        },
        {
          type: "list",
          style: "bulleted",
          children: [
            {
              type: "listItem",
              children: [{ type: "paragraph", children: [{ type: "span", value: "First item" }] }],
            },
            {
              type: "listItem",
              children: [
                { type: "paragraph", children: [{ type: "span", value: "Second item, with a nested list:" }] },
                {
                  type: "list",
                  style: "numbered",
                  children: [
                    {
                      type: "listItem",
                      children: [{ type: "paragraph", children: [{ type: "span", value: "Nested one" }] }],
                    },
                    {
                      type: "listItem",
                      children: [{ type: "paragraph", children: [{ type: "span", value: "Nested two" }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "blockquote",
          attribution: "Someone, somewhere",
          children: [{ type: "paragraph", children: [{ type: "span", value: "A quoted thought." }] }],
        },
        {
          type: "code",
          language: "ts",
          code: "const answer: number = 42;",
        },
        { type: "thematicBreak" },
        {
          type: "heading",
          level: 3,
          children: [{ type: "span", value: "A table" }],
        },
        {
          type: "table",
          children: [
            {
              type: "tableRow",
              children: [
                { type: "tableCell", children: [{ type: "paragraph", children: [{ type: "span", value: "Name" }] }] },
                { type: "tableCell", children: [{ type: "paragraph", children: [{ type: "span", value: "Value" }] }] },
              ],
            },
            {
              type: "tableRow",
              children: [
                { type: "tableCell", children: [{ type: "paragraph", children: [{ type: "span", value: "Foo" }] }] },
                { type: "tableCell", children: [{ type: "paragraph", children: [{ type: "span", value: "Bar" }] }] },
              ],
            },
          ],
        },
        { type: "block", item: "hero-1" },
        {
          type: "paragraph",
          children: [
            { type: "span", value: "An inline block chip: " },
            { type: "inlineBlock", item: "cta-1" },
            { type: "span", value: " sits right in the text." },
          ],
        },
      ],
    },
  } satisfies DastDocument,
  blocks: {
    "hero-1": {
      _type: "hero_section",
      heading: "Ship your CMS in an afternoon",
      image_url: "https://picsum.photos/seed/hero/640/240",
    },
    "cta-1": {
      _type: "cta_chip",
      label: "Get started",
    },
  },
};
