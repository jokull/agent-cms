import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const CMS_URL = process.env.CMS_URL ?? "http://127.0.0.1:8787";
const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? "7");
const WARMUP_ITERATIONS = Number(process.env.BENCH_WARMUP ?? "1");
const SUITE_PATH = resolve(process.cwd(), process.env.BENCH_SUITE ?? "benchmarks/blog-query-suite.json");
const OUT_DIR = resolve(process.cwd(), "benchmarks/results");

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(samples) {
  const durations = samples.map((s) => s.durationMs);
  const bytes = samples.map((s) => s.responseBytes);
  const sqlCounts = samples.map((s) => s.sqlStatementCount);
  const sqlDurations = samples.map((s) => s.sqlTotalMs);
  return {
    samples,
    medianMs: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    minMs: Math.min(...durations),
    maxMs: Math.max(...durations),
    medianBytes: percentile(bytes, 50),
    medianSqlStatements: percentile(sqlCounts, 50),
    p95SqlStatements: percentile(sqlCounts, 95),
    medianSqlMs: percentile(sqlDurations, 50),
  };
}

async function runQuery(entry, iteration) {
  const headers = { "content-type": "application/json" };
  if (entry.includeDrafts) headers["X-Include-Drafts"] = "true";
  if (process.env.BENCH_DEBUG_SQL === "1") headers["X-Debug-Sql"] = "true";

  const t0 = performance.now();
  const response = await fetch(`${CMS_URL}/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: entry.query,
      variables: entry.variables ?? {},
    }),
  });
  const text = await response.text();
  const t1 = performance.now();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  return {
    iteration,
    status: response.status,
    ok: response.ok,
    durationMs: Number((t1 - t0).toFixed(3)),
    responseBytes: Buffer.byteLength(text),
    errorCount: Array.isArray(parsed?.errors) ? parsed.errors.length : 0,
    sqlStatementCount: Number(response.headers.get("X-Sql-Statement-Count") ?? "0"),
    sqlTotalMs: Number(response.headers.get("X-Sql-Total-Ms") ?? "0"),
  };
}

async function fetchCategoryMap() {
  const response = await fetch(`${CMS_URL}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: "query BenchCategoryIds { allCategories(first: 100) { id slug } }",
    }),
  });
  const body = await response.json();
  const map = new Map();
  for (const category of body?.data?.allCategories ?? []) {
    if (typeof category.slug === "string" && typeof category.id === "string") {
      map.set(category.slug, category.id);
    }
  }
  return map;
}

function resolveVariables(value, refs) {
  if (typeof value === "string" && value.startsWith("__CATEGORY_ID__:")) {
    const slug = value.slice("__CATEGORY_ID__:".length);
    const resolved = refs.categories.get(slug);
    if (!resolved) {
      throw new Error(`No category id found for slug '${slug}'`);
    }
    return resolved;
  }
  if (Array.isArray(value)) return value.map((item) => resolveVariables(item, refs));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveVariables(item, refs)]));
  }
  return value;
}

async function main() {
  if (!existsSync(SUITE_PATH)) {
    throw new Error(`Benchmark suite not found: ${SUITE_PATH}`);
  }

  const suite = JSON.parse(await readFile(SUITE_PATH, "utf8"));
  const refs = { categories: await fetchCategoryMap() };
  await mkdir(OUT_DIR, { recursive: true });

  const startedAt = new Date().toISOString();
  const results = {
    startedAt,
    cmsUrl: CMS_URL,
    iterations: ITERATIONS,
    warmupIterations: WARMUP_ITERATIONS,
    suitePath: SUITE_PATH,
    benchmarks: [],
  };

  for (const entry of suite) {
    const resolvedEntry = {
      ...entry,
      variables: resolveVariables(entry.variables ?? {}, refs),
    };
    for (let i = 0; i < WARMUP_ITERATIONS; i++) {
      await runQuery(resolvedEntry, `warmup-${i + 1}`);
    }

    const samples = [];
    for (let i = 0; i < ITERATIONS; i++) {
      samples.push(await runQuery(resolvedEntry, i + 1));
    }

    results.benchmarks.push({
      name: entry.name,
      includeDrafts: Boolean(entry.includeDrafts),
      summary: summarize(samples),
    });
  }

  const outPath = resolve(OUT_DIR, `blog-bench-${startedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(outPath, JSON.stringify(results, null, 2));

  const lines = [];
  lines.push(`Benchmark run: ${startedAt}`);
  lines.push(`Target: ${CMS_URL}`);
  lines.push(`Iterations: ${ITERATIONS} (+${WARMUP_ITERATIONS} warmup)`);
  lines.push("");
  for (const benchmark of results.benchmarks) {
    const summary = benchmark.summary;
    lines.push(
      `${benchmark.name.padEnd(30)} median=${summary.medianMs.toFixed(3)}ms p95=${summary.p95Ms.toFixed(3)}ms bytes=${summary.medianBytes} sql=${summary.medianSqlStatements}/${summary.medianSqlMs.toFixed(3)}ms`
    );
  }
  console.log(lines.join("\n"));
  console.log(`\nSaved ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
