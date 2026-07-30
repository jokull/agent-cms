#!/usr/bin/env node
/**
 * agent-cms-codegen --schema <file-or-url> --out-dir <dir>
 *
 * Reads an agent-cms schema export (a JSON file or a live `/api/schema`
 * endpoint) and writes contract.ts + procedures.ts.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generate } from "./generate.ts";
import { parseSchemaExport } from "./schema-types.ts";

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function loadSchema(source: string): Promise<unknown> {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const url = source.endsWith("/schema") ? source : `${source.replace(/\/$/, "")}/api/schema`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch schema (${response.status}) from ${url}`);
    return response.json();
  }
  return JSON.parse(await readFile(source, "utf8"));
}

async function main() {
  const argv = process.argv.slice(2);
  const source = argValue(argv, "--schema");
  const outDir = argValue(argv, "--out-dir");
  if (!source || !outDir) {
    console.error("Usage: agent-cms-codegen --schema <file-or-url> --out-dir <dir>");
    process.exit(1);
  }
  const schema = parseSchemaExport(await loadSchema(source));
  const files = generate(schema);
  await mkdir(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(outDir, name), content);
    console.log(`wrote ${join(outDir, name)}`);
  }
  console.log(
    "contract.ts imports DAST types from @agent-cms/dast (types-only, erased at build).\n" +
      "  If it is not installed yet: pnpm add result-rpc @agent-cms/dast"
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
