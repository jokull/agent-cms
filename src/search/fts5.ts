import { Effect } from "effect";
import { SqlClient } from "@effect/sql";

export interface FtsResult {
  recordId: string;
  modelApiKey: string;
  rank: number;
  title: string;
  snippet: string;
}

/**
 * Turn arbitrary user text into a valid FTS5 MATCH expression.
 *
 * MATCH takes a *query language*, not a literal string: bare `'`, `"`, `&`,
 * `%`, `-`, `(`, `:` and friends are operators or syntax errors. Passing raw
 * user input (e.g. a search for `Coocoo's`) raises "fts5: syntax error", which
 * the search service used to swallow into an empty result set (#30).
 *
 * Two deliberate features survive: a user-authored `"..."` segment stays a
 * phrase query, and a trailing `*` still means prefix search. Everything else
 * becomes a quoted term, joined implicitly with AND. Terms that tokenize to
 * nothing (pure punctuation like `&`) are dropped — FTS5 rejects empty phrases.
 * Returns null when nothing searchable remains, so callers skip the query.
 */
const HAS_TOKEN_CHAR = /[\p{L}\p{N}]/u;

export function toMatchExpression(query: string): string | null {
  const terms: string[] = [];
  const scanner = /"([^"]*)"|(\S+)/gu;
  for (const match of query.matchAll(scanner)) {
    const phrase = match[1];
    // TypeScript types capture groups as `string`, but this one belongs to an
    // alternation: when the `(\S+)` branch matches, group 1 really is undefined
    // at runtime. The check is load-bearing, so the rule is wrong here.
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition
    if (phrase !== undefined) {
      if (HAS_TOKEN_CHAR.test(phrase)) terms.push(`"${phrase.replace(/"/g, '""')}"`);
      continue;
    }
    const raw = match[2] ?? "";
    const prefix = raw.endsWith("*");
    const bare = prefix ? raw.slice(0, -1) : raw;
    if (!HAS_TOKEN_CHAR.test(bare)) continue;
    terms.push(`"${bare.replace(/"/g, '""')}"${prefix ? "*" : ""}`);
  }
  return terms.length > 0 ? terms.join(" ") : null;
}

/**
 * Create FTS5 virtual table for a model.
 */
export function createFtsTable(modelApiKey: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(
      `CREATE VIRTUAL TABLE IF NOT EXISTS "fts_${modelApiKey}" USING fts5(record_id UNINDEXED, title, body)`
    );
  });
}

/**
 * Drop FTS5 virtual table for a model.
 */
export function dropFtsTable(modelApiKey: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`DROP TABLE IF EXISTS "fts_${modelApiKey}"`);
  });
}

/**
 * Index a single record into the FTS5 table.
 */
export function ftsIndex(modelApiKey: string, recordId: string, title: string, body: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(
      `INSERT INTO "fts_${modelApiKey}"(record_id, title, body) VALUES (?, ?, ?)`,
      [recordId, title, body]
    );
  });
}

/**
 * Remove a record from the FTS5 index.
 */
export function ftsDeindex(modelApiKey: string, recordId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(
      `DELETE FROM "fts_${modelApiKey}" WHERE record_id = ?`,
      [recordId]
    );
  });
}

/**
 * Query FTS5 with BM25 ranking and snippets.
 * When modelApiKey is not specified, searches across all FTS5 tables.
 */
export function ftsSearch(query: string, options: {
  modelApiKey?: string;
  first?: number;
  skip?: number;
}) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const limit = Math.min(options.first ?? 10, 100);
    const offset = options.skip ?? 0;
    const match = toMatchExpression(query);
    if (match === null) return [];

    if (options.modelApiKey) {
      // Single model search
      const modelApiKey = options.modelApiKey;
      const rows = yield* sql.unsafe<{
        record_id: string;
        title: string;
        rank: number;
        snippet: string;
      }>(
        // bm25 column weights: record_id 0.0 (UNINDEXED), title 10.0, body 1.0.
        // FTS5 has no implicit column weighting, so title matches must be
        // weighted explicitly here to rank above body matches.
        `SELECT record_id, title, bm25("fts_${modelApiKey}", 0.0, 10.0, 1.0) as rank, snippet("fts_${modelApiKey}", 2, '<mark>', '</mark>', '...', 32) as snippet
         FROM "fts_${modelApiKey}"
         WHERE "fts_${modelApiKey}" MATCH ?
         ORDER BY rank
         LIMIT ? OFFSET ?`,
        [match, limit, offset]
      );
      return rows.map((r) => ({
        recordId: r.record_id,
        modelApiKey,
        rank: r.rank,
        title: r.title,
        snippet: r.snippet,
      }));
    }

    // Cross-model search: discover all fts_* tables
    // FTS5 shadow tables have names like fts_post_content, fts_post_idx, etc.
    // We only want the main FTS5 virtual tables, which have sql starting with CREATE VIRTUAL TABLE
    const tables = yield* sql.unsafe<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fts_%' AND sql LIKE 'CREATE VIRTUAL TABLE%'`
    );

    if (tables.length === 0) return [];

    // Build UNION ALL query
    const unions = tables.map((t) => {
      const apiKey = t.name.replace(/^fts_/, "");
      return `SELECT record_id, title, '${apiKey}' as model_api_key, bm25("${t.name}", 0.0, 10.0, 1.0) as rank, snippet("${t.name}", 2, '<mark>', '</mark>', '...', 32) as snippet FROM "${t.name}" WHERE "${t.name}" MATCH ?`;
    });

    const unionQuery = unions.join(" UNION ALL ") + " ORDER BY rank LIMIT ? OFFSET ?";
    const params = [...tables.map(() => match), limit, offset];

    const rows = yield* sql.unsafe<{
      record_id: string;
      title: string;
      model_api_key: string;
      rank: number;
      snippet: string;
    }>(unionQuery, params);

    return rows.map((r) => ({
      recordId: r.record_id,
      modelApiKey: r.model_api_key,
      rank: r.rank,
      title: r.title,
      snippet: r.snippet,
    }));
  });
}

/**
 * Count total FTS5 matches for a query, over the same MATCH predicate used by
 * `ftsSearch` (ignoring LIMIT/OFFSET). Cheap in SQLite — lets keyword search
 * report an honest total instead of just the returned page length.
 */
export function ftsCount(query: string, options: { modelApiKey?: string }) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const match = toMatchExpression(query);
    if (match === null) return 0;

    if (options.modelApiKey) {
      const modelApiKey = options.modelApiKey;
      const rows = yield* sql.unsafe<{ c: number }>(
        `SELECT COUNT(*) as c FROM "fts_${modelApiKey}" WHERE "fts_${modelApiKey}" MATCH ?`,
        [match]
      );
      return rows[0]?.c ?? 0;
    }

    const tables = yield* sql.unsafe<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fts_%' AND sql LIKE 'CREATE VIRTUAL TABLE%'`
    );
    if (tables.length === 0) return 0;

    const counts = tables.map(
      (t) => `SELECT COUNT(*) as c FROM "${t.name}" WHERE "${t.name}" MATCH ?`
    );
    const countQuery = `SELECT COALESCE(SUM(c), 0) as c FROM (${counts.join(" UNION ALL ")})`;
    const rows = yield* sql.unsafe<{ c: number }>(
      countQuery,
      tables.map(() => match)
    );
    return rows[0]?.c ?? 0;
  });
}
