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
});
