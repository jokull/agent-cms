import { Effect, Option } from "effect";
import { contentTableName } from "../dynamic/tables.js";
import type { DynamicRow } from "../dynamic/row-types.js";
import { SqlClient } from "effect/unstable/sql";
import { extractRecordText } from "./extract-text.js";
import { createFtsTable as _createFtsTable, dropFtsTable, ftsIndex, ftsDeindex, ftsSearch, ftsCount } from "./fts5.js";
import type { FtsResult } from "./fts5.js";
import type { ParsedFieldRow, FieldRow } from "../db/row-types.js";
import { parseFieldValidators } from "../db/row-types.js";
import { ValidationError } from "../errors.js";
import { vectorizeIndex, vectorizeDeindex, vectorizeSearch, reciprocalRankFusion } from "./vectorize.js";
import { VectorizeContext } from "./vectorize-context.js";
import { materializeRecordStructuredTextFields } from "../services/structured-text-service.js";

/**
 * Index a record after creation.
 */
export function indexRecord(
  modelApiKey: string,
  recordId: string,
  data: DynamicRow,
  fields: ParsedFieldRow[]
) {
  return Effect.gen(function* () {
    const materialized = yield* materializeRecordStructuredTextFields({
      modelApiKey,
      record: data,
      fields,
    });
    const { title, body } = extractRecordText(materialized, fields);
    if (!title && !body) return;
    yield* ftsIndex(modelApiKey, recordId, title, body);
    const bindings = yield* VectorizeContext;
    if (Option.isSome(bindings)) {
      yield* vectorizeIndex(bindings.value.ai, bindings.value.vectorize, modelApiKey, recordId, title, body).pipe(Effect.ignore);
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
    const rows = yield* sql.unsafe<DynamicRow>(
      `SELECT * FROM "${contentTableName(modelApiKey)}" WHERE id = ?`,
      [recordId]
    );
    if (rows.length === 0) return;
    const materialized = yield* materializeRecordStructuredTextFields({
      modelApiKey,
      record: rows[0],
      fields,
    });
    const { title, body } = extractRecordText(materialized, fields);
    if (!title && !body) return;
    yield* ftsIndex(modelApiKey, recordId, title, body);
    const bindings = yield* VectorizeContext;
    if (Option.isSome(bindings)) {
      yield* vectorizeIndex(bindings.value.ai, bindings.value.vectorize, modelApiKey, recordId, title, body).pipe(Effect.ignore);
    }
  });
}

/**
 * Remove a record from the index.
 */
export function deindexRecord(modelApiKey: string, recordId: string) {
  return Effect.gen(function* () {
    yield* ftsDeindex(modelApiKey, recordId);
    const bindings = yield* VectorizeContext;
    if (Option.isSome(bindings)) {
      yield* vectorizeDeindex(bindings.value.vectorize, modelApiKey, recordId).pipe(Effect.ignore);
    }
  });
}

/**
 * Rebuild the entire FTS5 index for a model.
 */
export function rebuildIndex(modelApiKey: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* dropFtsTable(modelApiKey);
    yield* _createFtsTable(modelApiKey);
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
    const records = yield* sql.unsafe<DynamicRow>(
      `SELECT * FROM "${contentTableName(modelApiKey)}"`
    );
    const bindings = yield* VectorizeContext;
    for (const record of records) {
      const materialized = yield* materializeRecordStructuredTextFields({
        modelApiKey,
        record,
        fields,
      });
      const { title, body } = extractRecordText(materialized, fields);
      if (title || body) {
        yield* ftsIndex(modelApiKey, String(record.id), title, body);
        if (Option.isSome(bindings)) {
          yield* vectorizeIndex(bindings.value.ai, bindings.value.vectorize, modelApiKey, String(record.id), title, body).pipe(Effect.ignore);
        }
      }
    }
  });
}

/**
 * Create the FTS5 table for a model.
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
 */
export function reindexAll(modelApiKey?: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    let modelRows: ReadonlyArray<{ id: string; api_key: string }>;
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

    const bindings = yield* VectorizeContext;
    let totalRecords = 0;
    let totalIndexed = 0;

    for (const model of modelRows) {
      yield* dropFtsTable(model.api_key);
      yield* _createFtsTable(model.api_key);

      const fieldRows = yield* sql.unsafe<FieldRow>(
        "SELECT * FROM fields WHERE model_id = ? ORDER BY position",
        [model.id]
      );
      const fields = fieldRows.map(parseFieldValidators);

      const records = yield* sql.unsafe<DynamicRow>(
        `SELECT * FROM "${contentTableName(model.api_key)}"`
      );
      totalRecords += records.length;

      for (const record of records) {
        const materialized = yield* materializeRecordStructuredTextFields({
          modelApiKey: model.api_key,
          record,
          fields,
        });
        const { title, body } = extractRecordText(materialized, fields);
        if (title || body) {
          yield* ftsIndex(model.api_key, String(record.id), title, body);
          if (Option.isSome(bindings)) {
            yield* vectorizeIndex(bindings.value.ai, bindings.value.vectorize, model.api_key, String(record.id), title, body).pipe(Effect.ignore);
          }
          totalIndexed++;
        }
      }
    }

    return {
      models: modelRows.length,
      records: totalRecords,
      indexed: totalIndexed,
      vectorize: Option.isSome(bindings),
    };
  });
}

export type SearchMode = "keyword" | "semantic" | "hybrid";

function lookupIndexedTitle(modelApiKey: string, recordId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<{ title: string }>(
      `SELECT title FROM "fts_${modelApiKey}" WHERE record_id = ? LIMIT 1`,
      [recordId]
    ).pipe(Effect.catch(() => Effect.succeed([])));
    return rows[0]?.title ?? null;
  });
}

/**
 * Search content records.
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

    const bindings = yield* VectorizeContext;
    const hasVector = Option.isSome(bindings);
    const limit = Math.min(params.first ?? 10, 100);
    const skip = params.skip ?? 0;
    // Pre-fusion candidate window. Fusion and semantic paging happen in memory,
    // so both backends must surface enough rows to cover everything up to the
    // requested page (skip + limit), not just one page's worth.
    const candidateWindow = skip + limit;
    const mode = params.mode ?? (hasVector ? "hybrid" : "keyword");
    const useVector = (mode === "semantic" || mode === "hybrid") && hasVector;

    let ftsResults: FtsResult[] = [];
    if (mode !== "semantic") {
      // Keyword mode pages directly in SQL (LIMIT/OFFSET). Hybrid mode fuses in
      // memory, so it must fetch the whole candidate window from offset 0 and
      // page after fusion — otherwise skip would be applied twice.
      const ftsFirst = mode === "hybrid" ? candidateWindow : limit;
      const ftsSkip = mode === "hybrid" ? 0 : skip;
      ftsResults = yield* ftsSearch(params.query, {
        modelApiKey: params.modelApiKey,
        first: ftsFirst,
        skip: ftsSkip,
      }).pipe(
        // Degrade to no keyword hits rather than failing the whole search, but
        // never silently: an invisible FTS error is how #30 hid for months.
        Effect.catch((cause) =>
          Effect.logError("FTS keyword search failed", cause).pipe(
            Effect.as<FtsResult[]>([])
          )
        )
      );
    }

    let vectorResults: Array<{ recordId: string; modelApiKey: string; score: number }> = [];
    if (useVector && Option.isSome(bindings)) {
      vectorResults = yield* vectorizeSearch(bindings.value.ai, bindings.value.vectorize, params.query, candidateWindow).pipe(
        Effect.catch((cause) =>
          Effect.logError("Vector search failed", cause).pipe(Effect.as([]))
        )
      );

      if (params.modelApiKey) {
        vectorResults = vectorResults.filter((r) => r.modelApiKey === params.modelApiKey);
      }
    }

    if (mode === "hybrid" && ftsResults.length > 0 && vectorResults.length > 0) {
      const merged = reciprocalRankFusion(ftsResults, vectorResults);
      // Single paging step, after fusion — skip is NOT re-applied to ftsResults.
      const paged = merged.slice(skip, skip + limit);

      const ftsMetaMap = new Map(ftsResults.map((r) => [`${r.modelApiKey}:${r.recordId}`, { title: r.title, snippet: r.snippet }]));

      const results = yield* Effect.forEach(paged, (r) =>
        Effect.gen(function* () {
          const meta = ftsMetaMap.get(`${r.modelApiKey}:${r.recordId}`);
          // Vector-only hits are absent from the FTS metadata map; backfill the
          // title from the FTS table so semantic-only results keep a title.
          const title = meta?.title ?? (yield* lookupIndexedTitle(r.modelApiKey, r.recordId));
          return {
            recordId: r.recordId,
            modelApiKey: r.modelApiKey,
            rank: r.score,
            title,
            snippet: meta?.snippet ?? "",
          };
        })
      );

      // No honest total for hybrid: the true union of distinct keyword+vector
      // matches is not cheaply computable, so meta reports only page length.
      return { results, meta: { returned: results.length, mode: "hybrid" as const } };
    }

    if (mode === "semantic" && vectorResults.length > 0) {
      const paged = vectorResults.slice(skip, skip + limit);
      const results = yield* Effect.forEach(paged, (r) =>
        Effect.gen(function* () {
          const title = yield* lookupIndexedTitle(r.modelApiKey, r.recordId);
          return {
            recordId: r.recordId,
            modelApiKey: r.modelApiKey,
            rank: r.score,
            title,
            snippet: "",
          };
        })
      );
      return { results, meta: { returned: results.length, mode: "semantic" as const } };
    }

    if (mode === "keyword") {
      // Keyword total is cheaply knowable: COUNT(*) over the same MATCH predicate.
      const total = yield* ftsCount(params.query, { modelApiKey: params.modelApiKey }).pipe(
        Effect.catch(() => Effect.succeed(0))
      );
      return {
        results: ftsResults,
        meta: { returned: ftsResults.length, total, mode: "keyword" as const },
      };
    }

    // Fallback: hybrid/semantic requested but one backend returned nothing.
    // In degraded hybrid, ftsResults holds the candidate window from offset 0,
    // so page it here to honor skip.
    const ftsPage = mode === "hybrid" ? ftsResults.slice(skip, skip + limit) : ftsResults;
    return {
      results: ftsPage,
      meta: { returned: ftsPage.length, mode },
    };
  });
}
