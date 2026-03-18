import { resolve } from "node:path";

import { summarizeFindings } from "../core/runtime.mjs";
import { readLatestJson } from "./status.mjs";

export async function readReport(outDir = resolve(process.cwd(), "scripts/dato-import/out/trip")) {
  const latest = await readLatestJson(outDir);
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
