import { describe, expect, it } from "vitest";
import {
  estimateFormatMetrics,
  evaluateFormatCandidates,
  getFormatCandidates,
} from "../src/dast/format-lab.js";
import type { DastDocument } from "../src/dast/types.js";
import { validateDast } from "../src/dast/validate.js";

const editorialDoc: DastDocument = {
  schema: "dast",
  document: {
    type: "root",
    children: [
      {
        type: "heading",
        level: 2,
        children: [{ type: "span", value: "Kyoto Guide" }],
      },
      {
        type: "paragraph",
        children: [
          { type: "span", value: "Start with the " },
          {
            type: "itemLink",
            item: "rec_temple",
            children: [{ type: "span", value: "temple overview" }],
          },
          { type: "span", value: " before lunch." },
        ],
      },
      { type: "block", item: "hero1" },
      {
        type: "paragraph",
        children: [
          { type: "span", value: "Add the seasonal callout " },
          { type: "inlineBlock", item: "callout1" },
          { type: "span", value: " here." },
        ],
      },
    ],
  },
};

describe("structured text format lab", () => {
  it("round-trips the canonical authoring format through DAST", () => {
    const results = evaluateFormatCandidates(editorialDoc);

    expect(results.map((result) => result.name)).toEqual(["agentText"]);
    for (const result of results) {
      expect(result.roundTrips, result.name).toBe(true);
      expect(validateDast(getFormatCandidates().find((candidate) => candidate.name === result.name)?.parse(result.source))).toEqual([]);
    }
  });

  it("does not use HTML comments or angle tags for CMS references", () => {
    const byName = Object.fromEntries(
      evaluateFormatCandidates(editorialDoc).map((result) => [result.name, result.metrics]),
    );

    expect(byName.agentText.htmlCommentMarkers).toBe(0);
    expect(byName.agentText.angleTagMarkers).toBe(0);
  });

  it("keeps canonical handles compact and visually scannable", () => {
    const candidates = getFormatCandidates();
    const agentText = candidates.find((candidate) => candidate.name === "agentText")?.serialize(editorialDoc) ?? "";

    expect(agentText).toContain("[[block:hero1]]");
    expect(agentText).toContain("[[inline_block:callout1]]");
    expect(agentText).toContain("[[record:rec_temple|temple overview]]");
  });

  it("chooses Agent Text as the canonical authoring default", () => {
    const byName = Object.fromEntries(
      evaluateFormatCandidates(editorialDoc).map((result) => [result.name, result]),
    );

    expect(byName.agentText.roundTrips).toBe(true);
    expect(byName.agentText.metrics.htmlCommentMarkers).toBe(0);
    expect(byName.agentText.metrics.angleTagMarkers).toBe(0);
    expect(byName.agentText.source).toContain("[[block:");
    expect(byName.agentText.source).toContain("[[record:");
  });

  it("provides cheap metrics for iterating on syntax variants", () => {
    expect(estimateFormatMetrics("Intro\n\n[[block:hero1]]")).toMatchObject({
      referenceMarkers: 1,
      htmlCommentMarkers: 0,
      angleTagMarkers: 0,
    });
  });
});
