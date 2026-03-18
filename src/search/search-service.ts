import { Effect, Option } from "effect";
import { SqlClient } from "@effect/sql";
import { extractRecordText } from "./extract-text.js";
import { createFtsTable as _createFtsTable, dropFtsTable, ftsIndex, ftsDeindex, ftsSearch } from "./fts5.js";
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
  data: Record<string, unknown>,
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
    const rows = yield* sql.unsafe<Record<string, unknown>>(
      `SELECT * FROM "content_${modelApiKey}" WHERE id = ?`,
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
    const records = yield* sql.unsafe<Record<string, unknown>>(
      `SELECT * FROM "content_${modelApiKey}"`
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

      const records = yield* sql.unsafe<Record<string, unknown>>(
        `SELECT * FROM "content_${model.api_key}"`
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
    const mode = params.mode ?? (hasVector ? "hybrid" : "keyword");
    const useVector = (mode === "semantic" || mode === "hybrid") && hasVector;

    let ftsResults: FtsResult[] = [];
    if (mode !== "semantic") {
      ftsResults = yield* ftsSearch(params.query, {
        modelApiKey: params.modelApiKey,
        first: limit,
        skip: params.skip,
      }).pipe(Effect.catchAll(() => Effect.succeed([] as FtsResult[])));
    }

    let vectorResults: Array<{ recordId: string; modelApiKey: string; score: number }> = [];
    if (useVector && Option.isSome(bindings)) {
      vectorResults = yield* vectorizeSearch(bindings.value.ai, bindings.value.vectorize, params.query, limit * 2).pipe(
        Effect.catchAll(() => Effect.succeed([]))
      );

      if (params.modelApiKey) {
        vectorResults = vectorResults.filter((r) => r.modelApiKey === params.modelApiKey);
      }
    }

    if (mode === "hybrid" && ftsResults.length > 0 && vectorResults.length > 0) {
      const merged = reciprocalRankFusion(ftsResults, vectorResults);
      const paged = merged.slice(params.skip ?? 0, (params.skip ?? 0) + limit);

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

    return {
      results: ftsResults,
      meta: {
        count: ftsResults.length,
        mode: (hasVector ? mode : "keyword"),
      },
    };
  });
}
