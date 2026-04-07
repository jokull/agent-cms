import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { openState } from "../core/import-state.mjs";

export async function readLatestJson(dir) {
  return readLatestJsonMatching(dir, () => true);
}

export async function readLatestJsonMatching(dir, predicate) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && predicate(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) return null;
  const name = files[files.length - 1];
  const path = resolve(dir, name);
  const value = JSON.parse(await readFile(path, "utf8"));
  return { name, path, value };
}

export function readProjectStatus(outDir, project) {
  const state = openState(outDir, project);

  const recordCounts = state.recordCountsByStatus();
  const assetCounts = state.assetCountsByStatus();
  const referencedPending = state.referencedAssetCount();
  const latestRun = state.latestRun();
  const activeRun = state.activeRun();

  state.close();

  return { recordCounts, assetCounts, referencedPending, latestRun, activeRun };
}

export async function readStatus(outDir = resolve(process.cwd(), "scripts/dato-import/out")) {
  const latestCheckpoint = await readLatestJsonMatching(outDir, (name) => name.startsWith("checkpoint-"));
  const latestFindings = await readLatestJsonMatching(outDir, (name) => name.startsWith("findings-"));
  return { outDir, latestCheckpoint, latestFindings };
}
