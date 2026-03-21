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

    if (options.modelApiKey) {
      // Single model search
      const modelApiKey = options.modelApiKey;
      const rows = yield* sql.unsafe<{
        record_id: string;
        title: string;
        rank: number;
        snippet: string;
      }>(
        `SELECT record_id, title, rank, snippet("fts_${modelApiKey}", 2, '<mark>', '</mark>', '...', 32) as snippet
         FROM "fts_${modelApiKey}"
         WHERE "fts_${modelApiKey}" MATCH ?
         ORDER BY rank
         LIMIT ? OFFSET ?`,
        [query, limit, offset]
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
      return `SELECT record_id, title, '${apiKey}' as model_api_key, rank, snippet("${t.name}", 2, '<mark>', '</mark>', '...', 32) as snippet FROM "${t.name}" WHERE "${t.name}" MATCH ?`;
    });

    const unionQuery = unions.join(" UNION ALL ") + " ORDER BY rank LIMIT ? OFFSET ?";
    const params = [...tables.map(() => query), limit, offset];

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
