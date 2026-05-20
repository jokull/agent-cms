import { describe, expect, it } from "vitest";
import {
  FORMAT_CANDIDATES,
  SCENARIOS,
  buildPrompt,
  runEval,
  scoreOutput,
} from "../scripts/structured-text-agent-eval.mjs";

describe("structured text agent eval harness", () => {
  it("builds realistic format-specific prompts", () => {
    const scenario = SCENARIOS[0];
    const agentText = FORMAT_CANDIDATES.find((candidate) => candidate.name === "agentText");
    expect(agentText).toBeDefined();

    const prompt = buildPrompt({ scenario, candidate: agentText! });
    expect(prompt).toContain("You are editing a structured_text field");
    expect(prompt).toContain("Task:");
    expect(prompt).toContain("Never expand references into JSON");
    expect(prompt).toContain("[[block:");
    expect(prompt).toContain("[[record:");
    expect(prompt).not.toContain("<!-- cms:block");
  });

  it("scores a successful Agent Text edit", () => {
    const scenario = SCENARIOS[0];
    const agentText = FORMAT_CANDIDATES.find((candidate) => candidate.name === "agentText");
    const output = [
      "# 48 Hours in Kyoto",
      "",
      "Start at [[record:rec_kiyomizu|Kiyomizu-dera]] before the morning crowds arrive.",
      "",
      "[[block:hero_photo]]",
      "",
      "Save room for seasonal sweets [[inline_block:sweet_tip]] near the station.",
    ].join("\n");

    const score = scoreOutput({ scenario, candidate: agentText!, output });
    expect(score.parseOk).toBe(true);
    expect(score.ok).toBe(true);
    expect(score.score).toBe(1);
  });

  it("penalizes broken reference preservation", () => {
    const scenario = SCENARIOS[0];
    const agentText = FORMAT_CANDIDATES.find((candidate) => candidate.name === "agentText");
    const output = [
      "# 48 Hours in Kyoto",
      "",
      "Start at Kiyomizu-dera before the morning crowds arrive.",
      "",
      "Save room for seasonal sweets near the station.",
    ].join("\n");

    const score = scoreOutput({ scenario, candidate: agentText!, output });
    expect(score.parseOk).toBe(true);
    expect(score.ok).toBe(false);
    expect(score.score).toBeLessThan(1);
    expect(score.checks.some((check) => check.id === "block_preserved" && !check.passed)).toBe(true);
  });

  it("penalizes responses that leak unsupported reference syntax", () => {
    const scenario = SCENARIOS[0];
    const agentText = FORMAT_CANDIDATES.find((candidate) => candidate.name === "agentText");
    const output = [
      "# 48 Hours in Kyoto",
      "",
      "Start at [[record:rec_kiyomizu|Kiyomizu-dera]] before the morning crowds arrive.",
      "",
      '<block id="hero_photo"/>',
      "",
      "Save room for seasonal sweets [[inline_block:sweet_tip]] near the station.",
    ].join("\n");

    const score = scoreOutput({ scenario, candidate: agentText!, output });
    expect(score.parseOk).toBe(true);
    expect(score.ok).toBe(false);
    expect(score.checks.some((check) => check.id === "no_lower_angle_ref_tags" && !check.passed)).toBe(true);
  });

  it("includes harder scenarios that stress weaker models", () => {
    expect(SCENARIOS.map((scenario) => scenario.id)).toContain("ambiguous_reference_stress");
    expect(SCENARIOS.map((scenario) => scenario.id)).toContain("campaign_reference_maze");
  });

  it("can dry-run all scenarios without an LLM", async () => {
    const rows = await runEval({ live: false });
    expect(rows.length).toBe(SCENARIOS.length * FORMAT_CANDIDATES.length);
    expect(rows.every((row) => row.parseOk)).toBe(true);
  });

  it("supports repeat runs for noisy weaker-model checks", async () => {
    const rows = await runEval({
      live: false,
      repeat: 2,
      scenarioIds: ["complex_rewrite_reorder"],
      formats: [FORMAT_CANDIDATES.find((candidate) => candidate.name === "agentText")!],
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.iteration)).toEqual([0, 1]);
    expect(rows.every((row) => row.score === 1)).toBe(true);
  });

  it("rejects unknown live providers", async () => {
    await expect(runEval({ provider: "unknown", formats: [FORMAT_CANDIDATES[0]] })).rejects.toThrow("Unknown provider");
  });
});
