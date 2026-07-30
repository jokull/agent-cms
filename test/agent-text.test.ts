import { describe, expect, it } from "vitest";
import {
  agentTextToDast,
  dastToAgentText,
} from "../src/dast/agent-text.js";
import type { DastDocument } from "../src/dast/types.js";

const doc: DastDocument = {
  schema: "dast",
  document: {
    type: "root",
    children: [
      { type: "paragraph", children: [{ type: "span", value: "Intro" }] },
      { type: "block", item: "hero1" },
      {
        type: "paragraph",
        children: [
          { type: "span", value: "See " },
          { type: "inlineBlock", item: "callout1" },
          { type: "span", value: " and " },
          {
            type: "itemLink",
            item: "rec1",
            children: [{ type: "span", value: "the record" }],
          },
        ],
      },
    ],
  },
};

describe("Agent Text structured text format", () => {
  it("compiles handle references to DAST", () => {
    const result = agentTextToDast([
      "Intro",
      "",
      "[[block:hero1]]",
      "",
      "See [[inline_block:callout1]] and [[record:rec1|the record]]",
    ].join("\n"));

    expect(result.document.children[1]).toEqual({ type: "block", item: "hero1" });
  });

  it("serializes DAST into the canonical authoring syntax", () => {
    const source = dastToAgentText(doc);
    expect(source).toContain("[[block:hero1]]");
    expect(source).toContain("[[inline_block:callout1]]");
    expect(source).toContain("[[record:rec1|the record]]");
  });

  it("round-trips through DAST", () => {
    expect(agentTextToDast(dastToAgentText(doc))).toEqual(doc);
  });

  it("accepts light whitespace inside handles", () => {
    const source = "Intro\n\n[[ block : hero1 ]]\n\nSee [[ record : rec1 | the record ]]";
    const docWithHandles = agentTextToDast(source);
    expect(docWithHandles.document.children[1]).toEqual({ type: "block", item: "hero1" });
  });

  it("keeps GFM tables available in Agent Text strings", () => {
    const result = agentTextToDast([
      "| Plan | Price |",
      "| --- | --- |",
      "| Basic | $9 |",
    ].join("\n"));

    expect(result.document.children[0]?.type).toBe("table");
  });

  it("does not rewrite handle-looking text inside code", () => {
    const result = agentTextToDast([
      "```",
      "[[block:literal]]",
      "```",
      "",
      "Use `[[record:rec1|literal]]` in examples.",
    ].join("\n"));

    expect(result.document.children[0]).toEqual({
      type: "code",
      code: "[[block:literal]]",
    });
    expect(result.document.children[1]).toEqual({
      type: "paragraph",
      children: [
        { type: "span", value: "Use " },
        { type: "span", value: "[[record:rec1|literal]]", marks: ["code"] },
        { type: "span", value: " in examples." },
      ],
    });
  });

  it("serializes record labels with escaped brackets as Agent Text handles", () => {
    const source = dastToAgentText({
      schema: "dast",
      document: {
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [
              { type: "span", value: "See " },
              {
                type: "itemLink",
                item: "rec1",
                children: [{ type: "span", value: "record [A]" }],
              },
            ],
          },
        ],
      },
    });

    expect(source).toContain("[[record:rec1|record \\[A\\]]]");
    expect(agentTextToDast(source).document.children[0]).toEqual({
      type: "paragraph",
      children: [
        { type: "span", value: "See " },
        {
          type: "itemLink",
          item: "rec1",
          children: [{ type: "span", value: "record [A]" }],
        },
      ],
    });
  });

  it("round-trips a custom mark (customMark_*) through Agent Text", () => {
    // dastToAgentText serializes via dastdown, which emits `<m k="...">` for
    // any non-default mark. agentTextToDast reparses via the markdown
    // projection (not dastdown), so without matching <m k="..."> support
    // there this would silently corrupt the round-trip into literal text
    // rather than losing just the mark.
    const source = dastToAgentText({
      schema: "dast",
      document: {
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [{ type: "span", value: "shortcut", marks: ["strong", "customMark_kbd"] }],
          },
        ],
      },
    });

    expect(source).toContain('<m k="customMark_kbd">');

    const result = agentTextToDast(source);
    const paragraph = result.document.children[0];
    if (paragraph.type !== "paragraph") throw new Error("expected a paragraph");
    const span = paragraph.children[0];
    if (span.type !== "span") throw new Error("expected a span");
    expect(span.value).toBe("shortcut");
    expect(span.marks).toContain("strong");
    expect(span.marks).toContain("customMark_kbd");
  });
});
