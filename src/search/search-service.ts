import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { extractRecordText } from "./extract-text.js";
import { createFtsTable as _createFtsTable, dropFtsTable, ftsIndex, ftsDeindex, ftsSearch } from "./fts5.js";
import type { FtsResult } from "./fts5.js";
import type { ParsedFieldRow, FieldRow } from "../db/row-types.js";
import { parseFieldValidators } from "../db/row-types.js";
import { ValidationError } from "../errors.js";
import type { AiBinding, VectorizeBinding } from "./vectorize.js";
import { vectorizeIndex, vectorizeDeindex, vectorizeSearch, reciprocalRankFusion } from "./vectorize.js";

/** Optional Vectorize bindings — set once at startup, used by all search operations. */
let _ai: AiBinding | undefined;
let _vectorize: VectorizeBinding | undefined;

/** Configure Vectorize bindings. Call once at startup from createWebHandler. */
export function configureVectorize(ai?: AiBinding, vectorize?: VectorizeBinding) {
  _ai = ai;
  _vectorize = vectorize;
}

/** Check if Vectorize is available. */
export function hasVectorize(): boolean {
  return !!_ai && !!_vectorize;
}

/**
 * Index a record after creation.
 */
export function indexRecord(
  modelApiKey: string,
  recordId: string,
  data: Record<string, unknown>,
  fields: ParsedFieldRow[]
) {
  return Effect.gen(function* () {
    const { title, body } = extractRecordText(data, fields);
    if (!title && !body) return;
    yield* ftsIndex(modelApiKey, recordId, title, body);
    // Vectorize indexing (async, non-blocking)
    if (_ai && _vectorize) {
      yield* Effect.promise(() =>
        vectorizeIndex(_ai!, _vectorize!, modelApiKey, recordId, title, body)
      ).pipe(Effect.ignore);
    }
  });
}

/**
 * Reindex a record after update: deindex old, then fetch fresh data and index.
 */
export function reindexRecord(
  modelApiKey: string,
  recordId: string,
  fields: ParsedFieldRow[]
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* ftsDeindex(modelApiKey, recordId);
    // Fetch current record data
    const rows = yield* sql.unsafe<Record<string, unknown>>(
      `SELECT * FROM "content_${modelApiKey}" WHERE id = ?`,
      [recordId]
    );
    if (rows.length === 0) return;
    const { title, body } = extractRecordText(rows[0], fields);
    if (!title && !body) return;
    yield* ftsIndex(modelApiKey, recordId, title, body);
    // Vectorize reindex
    if (_ai && _vectorize) {
      yield* Effect.promise(() =>
        vectorizeIndex(_ai!, _vectorize!, modelApiKey, recordId, title, body)
      ).pipe(Effect.ignore);
    }
  });
}

/**
 * Remove a record from the index.
 */
export function deindexRecord(modelApiKey: string, recordId: string) {
  return Effect.gen(function* () {
    yield* ftsDeindex(modelApiKey, recordId);
    if (_vectorize) {
      yield* Effect.promise(() =>
        vectorizeDeindex(_vectorize!, modelApiKey, recordId)
      ).pipe(Effect.ignore);
    }
  });
}

/**
 * Rebuild the entire FTS5 index for a model.
 * Used after field changes that affect what text is extracted.
 */
export function rebuildIndex(modelApiKey: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Drop and recreate
    yield* dropFtsTable(modelApiKey);
    yield* _createFtsTable(modelApiKey);
    // Get fields
    const models = yield* sql.unsafe<{ id: string }>(
      "SELECT id FROM models WHERE api_key = ?",
      [modelApiKey]
    );
    if (models.length === 0) return;
    const fieldRows = yield* sql.unsafe<FieldRow>(
      "SELECT * FROM fields WHERE model_id = ? ORDER BY position",
      [models[0].id]
    );
    const fields = fieldRows.map(parseFieldValidators);
    // Re-index all records
    const records = yield* sql.unsafe<Record<string, unknown>>(
      `SELECT * FROM "content_${modelApiKey}"`
    );
    for (const record of records) {
      const { title, body } = extractRecordText(record, fields);
      if (title || body) {
        yield* ftsIndex(modelApiKey, String(record.id), title, body);
        if (_ai && _vectorize) {
          yield* Effect.promise(() =>
            vectorizeIndex(_ai!, _vectorize!, modelApiKey, String(record.id), title, body)
          ).pipe(Effect.ignore);
        }
      }
    }
  });
}

/**
 * Create the FTS5 table for a model (called from model-service on model creation).
 */
export function createFtsTable(modelApiKey: string) {
  return _createFtsTable(modelApiKey);
}

/**
 * Drop the FTS5 index for a model.
 */
export function dropIndex(modelApiKey: string) {
  return dropFtsTable(modelApiKey);
}

/**
 * Rebuild search indexes for all content models (or a specific one).
 * Use after deploying search to a CMS with existing content,
 * or to recover from Vectorize drift.
 */
export function reindexAll(modelApiKey?: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Get content models to reindex
    let modelRows: Array<{ id: string; api_key: string }>;
    if (modelApiKey) {
      modelRows = yield* sql.unsafe<{ id: string; api_key: string }>(
        "SELECT id, api_key FROM models WHERE api_key = ? AND is_block = 0",
        [modelApiKey]
      );
      if (modelRows.length === 0) {
        return yield* new ValidationError({ message: `Model '${modelApiKey}' not found or is a block type` });
      }
    } else {
      modelRows = yield* sql.unsafe<{ id: string; api_key: string }>(
        "SELECT id, api_key FROM models WHERE is_block = 0"
      );
    }

    let totalRecords = 0;
    let totalIndexed = 0;

    for (const model of modelRows) {
      // Drop and recreate FTS table
      yield* dropFtsTable(model.api_key);
      yield* _createFtsTable(model.api_key);

      // Get fields
      const fieldRows = yield* sql.unsafe<FieldRow>(
        "SELECT * FROM fields WHERE model_id = ? ORDER BY position",
        [model.id]
      );
      const fields = fieldRows.map(parseFieldValidators);

      // Fetch all records
      const records = yield* sql.unsafe<Record<string, unknown>>(
        `SELECT * FROM "content_${model.api_key}"`
      );
      totalRecords += records.length;

      for (const record of records) {
        const { title, body } = extractRecordText(record, fields);
        if (title || body) {
          yield* ftsIndex(model.api_key, String(record.id), title, body);
          if (_ai && _vectorize) {
            yield* Effect.promise(() =>
              vectorizeIndex(_ai!, _vectorize!, model.api_key, String(record.id), title, body)
            ).pipe(Effect.ignore);
          }
          totalIndexed++;
        }
      }
    }

    return {
      models: modelRows.length,
      records: totalRecords,
      indexed: totalIndexed,
      vectorize: hasVectorize(),
    };
  });
}

export type SearchMode = "keyword" | "semantic" | "hybrid";

/**
 * Search content records.
 * Mode determines strategy:
 *   - "keyword": FTS5 only (always available)
 *   - "semantic": Vectorize only (requires AI+Vectorize bindings)
 *   - "hybrid": FTS5 + Vectorize with reciprocal rank fusion (falls back to keyword)
 */
export function search(params: {
  query: string;
  modelApiKey?: string;
  first?: number;
  skip?: number;
  mode?: SearchMode;
}) {
  return Effect.gen(function* () {
    if (!params.query || params.query.trim().length === 0) {
      return yield* new ValidationError({ message: "Search query is required" });
    }

    const limit = Math.min(params.first ?? 10, 100);
    const mode = params.mode ?? (hasVectorize() ? "hybrid" : "keyword");
    const useVector = (mode === "semantic" || mode === "hybrid") && hasVectorize();

    // FTS5 results (skip for pure semantic mode)
    let ftsResults: FtsResult[] = [];
    if (mode !== "semantic") {
      ftsResults = yield* ftsSearch(params.query, {
        modelApiKey: params.modelApiKey,
        first: limit,
        skip: params.skip,
      }).pipe(Effect.catchAll(() => Effect.succeed([] as FtsResult[])));
    }

    // Vectorize results
    let vectorResults: Array<{ recordId: string; modelApiKey: string; score: number }> = [];
    if (useVector) {
      vectorResults = yield* Effect.promise(() =>
        vectorizeSearch(_ai!, _vectorize!, params.query, limit * 2)
      ).pipe(Effect.catchAll(() => Effect.succeed([])));

      // Filter by modelApiKey if specified
      if (params.modelApiKey) {
        vectorResults = vectorResults.filter((r) => r.modelApiKey === params.modelApiKey);
      }
    }

    // Merge results
    if (mode === "hybrid" && ftsResults.length > 0 && vectorResults.length > 0) {
      const merged = reciprocalRankFusion(ftsResults, vectorResults);
      const paged = merged.slice(params.skip ?? 0, (params.skip ?? 0) + limit);

      // Enrich with FTS snippets where available
      const ftsSnippetMap = new Map(ftsResults.map((r) => [`${r.modelApiKey}:${r.recordId}`, r.snippet]));

      const results = paged.map((r) => ({
        recordId: r.recordId,
        modelApiKey: r.modelApiKey,
        rank: r.score,
        snippet: ftsSnippetMap.get(`${r.modelApiKey}:${r.recordId}`) ?? "",
      }));

      return { results, meta: { count: results.length, mode: "hybrid" as const } };
    }

    if (mode === "semantic" && vectorResults.length > 0) {
      const paged = vectorResults.slice(params.skip ?? 0, (params.skip ?? 0) + limit);
      const results = paged.map((r) => ({
        recordId: r.recordId,
        modelApiKey: r.modelApiKey,
        rank: r.score,
        snippet: "",
      }));
      return { results, meta: { count: results.length, mode: "semantic" as const } };
    }

    // Fallback: FTS5-only results
    return {
      results: ftsResults,
      meta: {
        count: ftsResults.length,
        mode: (hasVectorize() ? mode : "keyword") as SearchMode,
      },
    };
  });
}
