import { getSchema } from "@tiptap/core";
import { Node as PmModelNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { DastCodecError, dastToPm, pmToDast } from "../src/bridge/codec.js";
import type { DastDocument } from "../src/bridge/dast-types.js";
import { createDastExtensions } from "../src/bridge/extensions.js";

const schema = getSchema(createDastExtensions());
const blocksOnlySchema = getSchema(createDastExtensions({ mode: "blocks_only" }));

/** Assert the ProseMirror schema itself accepts the converted document. */
function checkAgainstSchema(pmJson: ReturnType<typeof dastToPm>, s = schema) {
  const node = PmModelNode.fromJSON(s, pmJson);
  node.check();
  return node;
}

function doc(children: DastDocument["document"]["children"]): DastDocument {
  return { schema: "dast", document: { type: "root", children } };
}

const kitchenSink: DastDocument = doc([
  {
    type: "heading",
    level: 2,
    children: [{ type: "span", value: "Title", marks: ["strong"] }],
  },
  {
    type: "paragraph",
    children: [
      { type: "span", value: "plain " },
      { type: "span", value: "bold", marks: ["strong"] },
      {
        type: "link",
        url: "https://example.com",
        meta: [{ id: "rel", value: "nofollow" }],
        children: [{ type: "span", value: "a link", marks: ["emphasis"] }],
      },
      { type: "span", value: " then " },
      { type: "itemLink", item: "rec_1", children: [{ type: "span", value: "a record link" }] },
      { type: "inlineItem", item: "rec_2" },
      { type: "inlineBlock", item: "blk_inline_1" },
    ],
  },
  {
    type: "list",
    style: "numbered",
    children: [
      { type: "listItem", children: [{ type: "paragraph", children: [{ type: "span", value: "one" }] }] },
      {
        type: "listItem",
        children: [
          { type: "paragraph", children: [{ type: "span", value: "two" }] },
          {
            type: "list",
            style: "bulleted",
            children: [
              { type: "listItem", children: [{ type: "paragraph", children: [{ type: "span", value: "nested" }] }] },
            ],
          },
        ],
      },
    ],
  },
  {
    type: "blockquote",
    attribution: "Someone",
    children: [{ type: "paragraph", children: [{ type: "span", value: "quoted" }] }],
  },
  { type: "code", code: "const x = 1;\n", language: "ts", highlight: [1] },
  { type: "thematicBreak" },
  { type: "block", item: "blk_1" },
  {
    type: "table",
    children: [
      {
        type: "tableRow",
        children: [
          { type: "tableCell", children: [{ type: "paragraph", children: [{ type: "span", value: "cell" }] }] },
          { type: "tableCell", children: [{ type: "paragraph", children: [] }] },
        ],
      },
    ],
  },
]);

describe("DAST ↔ ProseMirror codec", () => {
  it("round-trips the kitchen sink byte-identically", () => {
    const pm = dastToPm(kitchenSink);
    checkAgainstSchema(pm);
    expect(pmToDast(pm)).toEqual(kitchenSink);
  });

  it("round-trips through a real ProseMirror node (engine-normalized)", () => {
    const node = checkAgainstSchema(dastToPm(kitchenSink));
    expect(pmToDast(node.toJSON())).toEqual(kitchenSink);
  });

  it("drops empty spans on load (documented normalization)", () => {
    const withEmpty = doc([
      { type: "paragraph", children: [{ type: "span", value: "" }, { type: "span", value: "kept" }] },
    ]);
    const pm = dastToPm(withEmpty);
    checkAgainstSchema(pm);
    expect(pmToDast(pm)).toEqual(doc([{ type: "paragraph", children: [{ type: "span", value: "kept" }] }]));
  });

  it("splits adjacent links with different targets into separate wrappers", () => {
    const two: DastDocument = doc([
      {
        type: "paragraph",
        children: [
          { type: "link", url: "https://a.com", children: [{ type: "span", value: "a" }] },
          { type: "link", url: "https://b.com", children: [{ type: "span", value: "b" }] },
        ],
      },
    ]);
    expect(pmToDast(dastToPm(two))).toEqual(two);
  });

  it("preserves multiple marks inside a link wrapper", () => {
    const fancy: DastDocument = doc([
      {
        type: "paragraph",
        children: [
          {
            type: "link",
            url: "https://a.com",
            children: [
              { type: "span", value: "bold", marks: ["strong"] },
              { type: "span", value: " and plain" },
            ],
          },
        ],
      },
    ]);
    expect(pmToDast(dastToPm(fancy))).toEqual(fancy);
  });

  it("fails loudly on unknown node types instead of dropping them", () => {
    expect(() =>
      pmToDast({ type: "doc", content: [{ type: "mystery" }] })
    ).toThrow(DastCodecError);
  });

  it("the schema rejects mixed inline/block tableCell content (ticket 17)", () => {
    expect(() =>
      PmModelNode.fromJSON(schema, {
        type: "doc",
        content: [
          {
            type: "table",
            content: [
              {
                type: "tableRow",
                content: [
                  {
                    type: "tableCell",
                    content: [
                      { type: "paragraph", attrs: { style: null } },
                      { type: "text", text: "bare inline" },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }).check()
    ).toThrow();
  });

  it("the schema rejects a heading inside a blockquote (grammar is enforced)", () => {
    expect(() =>
      PmModelNode.fromJSON(schema, {
        type: "doc",
        content: [
          {
            type: "blockquote",
            attrs: { attribution: null },
            content: [{ type: "heading", attrs: { level: 1, style: null } }],
          },
        ],
      }).check()
    ).toThrow();
  });

  it("blocks_only mode accepts only block atoms at the root", () => {
    const blocksOnly = doc([
      { type: "block", item: "blk_1" },
      { type: "block", item: "blk_2" },
    ]);
    const node = checkAgainstSchema(dastToPm(blocksOnly), blocksOnlySchema);
    expect(pmToDast(node.toJSON())).toEqual(blocksOnly);
    expect(() =>
      checkAgainstSchema(dastToPm(doc([{ type: "paragraph", children: [] }])), blocksOnlySchema)
    ).toThrow();
  });
});
