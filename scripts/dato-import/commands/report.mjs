import { resolve } from "node:path";

import { summarizeFindings } from "../core/runtime.mjs";
import { readLatestJsonMatching } from "./status.mjs";

export async function readReport(outDir = resolve(process.cwd(), "scripts/dato-import/out")) {
  const latest = await readLatestJsonMatching(outDir, (name) => name.startsWith("findings-"));
  if (!latest) {
    return { outDir, latest: null, summary: null };
  }

  const findings = Array.isArray(latest.value?.findings) ? latest.value.findings : Array.isArray(latest.value) ? latest.value : [];
  return {
    outDir,
    latest,
    summary: summarizeFindings(findings),
  };
}
