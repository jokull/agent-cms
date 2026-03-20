import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function getArg(name, fallback = undefined) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

export async function ensureOutDir(outDir) {
  await mkdir(outDir, { recursive: true });
}

export async function writeJson(outDir, filename, value) {
  await ensureOutDir(outDir);
  const path = resolve(outDir, filename);
  await writeFile(path, JSON.stringify(value, null, 2));
  return path;
}

export async function readJson(outDir, filename) {
  const path = resolve(outDir, filename);
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return { path, value };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function summarizeFindings(findings) {
  const byType = {};
  for (const finding of findings) {
    byType[finding.type] = (byType[finding.type] ?? 0) + 1;
  }
  return {
    total: findings.length,
    byType,
  };
}
