import { describe, expect, it } from "vitest";
import {
  CUSTOM_MARK_PREFIX,
  DEFAULT_MARKS,
  emptyDastDocument,
  isCustomMark,
  isDefaultMark,
  isMark,
  type BlockLevelNode,
  type DastDocument,
  type Mark,
  type SpanNode,
} from "../src/index.ts";

describe("@agent-cms/dast grammar constants", () => {
  it("DEFAULT_MARKS holds the six DatoCMS default marks in order", () => {
    expect(DEFAULT_MARKS).toEqual([
      "strong",
      "emphasis",
      "underline",
      "strikethrough",
      "code",
      "highlight",
    ]);
  });

  it("isDefaultMark accepts defaults and rejects custom marks", () => {
    expect(isDefaultMark("strong")).toBe(true);
    expect(isDefaultMark("customMark_kbd")).toBe(false);
    expect(isDefaultMark("bold")).toBe(false);
  });

  it("isCustomMark requires the prefix and a non-empty suffix", () => {
    expect(isCustomMark("customMark_kbd")).toBe(true);
    expect(isCustomMark(CUSTOM_MARK_PREFIX)).toBe(false);
    expect(isCustomMark("strong")).toBe(false);
  });

  it("isMark accepts both flavours", () => {
    expect(isMark("highlight")).toBe(true);
    expect(isMark("customMark_kbd")).toBe(true);
    expect(isMark("nope")).toBe(false);
  });

  it("emptyDastDocument is a valid empty root", () => {
    expect(emptyDastDocument()).toEqual({ schema: "dast", document: { type: "root", children: [] } });
  });
});

describe("@agent-cms/dast types", () => {
  it("a span may carry a custom mark (the divergence that broke the editor)", () => {
    const marks: readonly Mark[] = ["strong", "customMark_kbd"];
    const span: SpanNode = { type: "span", value: "hi", marks };
    expect(span.marks).toHaveLength(2);
  });

  it("a document composes block-level nodes including tables", () => {
    const children: readonly BlockLevelNode[] = [
      { type: "paragraph", children: [{ type: "span", value: "hello" }] },
      { type: "block", item: "blk_1" },
      {
        type: "table",
        children: [
          { type: "tableRow", children: [{ type: "tableCell", children: [{ type: "paragraph", children: [] }] }] },
        ],
      },
    ];
    const doc: DastDocument = { schema: "dast", document: { type: "root", children } };
    expect(doc.document.children).toHaveLength(3);
  });
});
