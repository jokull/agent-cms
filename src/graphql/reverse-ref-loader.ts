/**
 * Request-scoped, batched reverse-reference loader backed by `RequestResolver`.
 *
 * Resolves `_all<Model>` meta fields: for each parent record, find the
 * source-table rows that reference it (via `link` or `links` fields) and
 * return them in the requested order/limit. Without batching, N parents
 * cost N queries; the resolver collapses lookups within the batch window
 * into one query with OR'd conditions, then buckets rows back per parent.
 *
 * The caller builds a `loaderKey` encoding every query parameter
 * (source table, refs, drafts, locale, filter, order, first, skip) — one
 * resolver per key, closing over the first caller's params, promise-cached
 * per request context (see `asset-loader.ts` for the rc.109 construction
 * facts).
 */
import { Effect, Exit, Request, RequestResolver } from "effect";
import { isString, type StoredFieldValue } from "../dynamic/row-types.js";
import { SqlClient } from "effect/unstable/sql";
import type { GqlContext, ReverseRef } from "./gql-types.js";
import type { DynamicRow } from "../dynamic/row-types.js";
import { decodeJsonIfString } from "../json.js";
import { decodeSnapshot, deserializeRecord } from "../dynamic/decode.js";

type RunSql = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) => Promise<A>;

interface ReverseRefLoaderParams {
  runSql: RunSql;
  context?: GqlContext;
  loaderKey: string;
  parentId: string;
  sourceTableName: string;
  sourceRefs: readonly ReverseRef[];
  includeDrafts: boolean;
  filterWhere?: string;
  filterParams: readonly unknown[];
  orderBy?: string;
  first: number;
  skip: number;
}

/** The batch-relevant subset of the params, shared by every request in a key. */
type ReverseRefBatchParams = Omit<ReverseRefLoaderParams, "context" | "loaderKey" | "parentId">;

/** A single reverse-reference lookup: the source rows referencing one parent. */
export class GetReverseRefs extends Request.Class<
  { readonly parentId: string },
  DynamicRow[],
  unknown
> {}

export type ReverseRefResolver = RequestResolver.RequestResolver<GetReverseRefs>;

/** Per-request resolver cache, keyed by the caller's loaderKey. */
const resolverCache = new WeakMap<GqlContext, Map<string, Promise<ReverseRefResolver>>>();

function buildRefConditionsForSingleParent(sourceRefs: readonly ReverseRef[]) {
  const conditions: string[] = [];
  for (const ref of sourceRefs) {
    if (ref.fieldType === "link") {
      conditions.push(`"${ref.fieldApiKey}" = ?`);
    } else {
      conditions.push(`EXISTS (SELECT 1 FROM json_each("${ref.fieldApiKey}") WHERE value = ?)`);
    }
  }
  return conditions;
}

function buildRefConditionsForManyParents(sourceRefs: readonly ReverseRef[], parentIds: readonly string[]) {
  const parentIdPlaceholders = parentIds.map(() => "?").join(", ");
  const conditions: string[] = [];
  const params: string[] = [];

  for (const ref of sourceRefs) {
    if (ref.fieldType === "link") {
      conditions.push(`"${ref.fieldApiKey}" IN (${parentIdPlaceholders})`);
      params.push(...parentIds);
    } else {
      conditions.push(`EXISTS (SELECT 1 FROM json_each("${ref.fieldApiKey}") WHERE value IN (${parentIdPlaceholders}))`);
      params.push(...parentIds);
    }
  }

  return { conditions, params };
}

function decodeRows(rows: readonly DynamicRow[], includeDrafts: boolean) {
  return rows.map((row) => decodeSnapshot(deserializeRecord(row), includeDrafts));
}

function extractMatchingParentIds(row: DynamicRow, sourceRefs: readonly ReverseRef[], parentIdSet: ReadonlySet<string>) {
  const matches = new Set<string>();

  for (const ref of sourceRefs) {
    const rawValue = row[ref.fieldApiKey];
    if (rawValue == null) continue;

    if (ref.fieldType === "link") {
      if (isString(rawValue) && parentIdSet.has(rawValue)) {
        matches.add(rawValue);
      }
      continue;
    }

    // SAFETY: link/links cells hold a JSON string or parsed value
    // (StoredFieldValue); the decode/array checks below validate shape.
    const decoded = decodeJsonIfString(rawValue as StoredFieldValue);
    if (!Array.isArray(decoded)) continue;
    for (const item of decoded) {
      if (isString(item) && parentIdSet.has(item)) {
        matches.add(item);
      }
    }
  }

  return matches;
}

/** One parent, no batching. Used directly when there is no request context. */
async function querySingleParent(params: ReverseRefBatchParams & { parentId: string }) {
  const refConditions = buildRefConditionsForSingleParent(params.sourceRefs);
  const queryParams: unknown[] = params.sourceRefs.map(() => params.parentId);

  let query = `SELECT * FROM "${params.sourceTableName}" WHERE (${refConditions.join(" OR ")})`;
  if (!params.includeDrafts) {
    query += ` AND "_status" IN ('published', 'updated')`;
  }
  if (params.filterWhere) {
    query += ` AND ${params.filterWhere}`;
    queryParams.push(...params.filterParams);
  }
  if (params.orderBy) {
    query += ` ORDER BY ${params.orderBy}`;
  }
  query += ` LIMIT ?`;
  queryParams.push(params.first);
  if (params.skip > 0) {
    query += ` OFFSET ?`;
    queryParams.push(params.skip);
  }

  const rows = await params.runSql(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.unsafe<DynamicRow>(query, queryParams);
    })
  );

  return decodeRows(rows, params.includeDrafts);
}

/**
 * Build the resolver for one loaderKey. Batches all lookups in the window:
 * a single pending parent runs the LIMIT/OFFSET query; multiple parents run
 * one OR'd query and bucket rows back (deduping shared rows per parent).
 */
export function buildReverseRefResolver(
  params: ReverseRefBatchParams,
): Effect.Effect<ReverseRefResolver, unknown> {
  return RequestResolver.make<GetReverseRefs>(
    Effect.fn(function* (entries) {
      if (entries.length === 1) {
        const [entry] = entries;
        const result = yield* Effect.tryPromise(() =>
          querySingleParent({ ...params, parentId: entry.request.parentId })
        );
        entry.completeUnsafe(Exit.succeed(result));
        return;
      }

      const parentIds = entries.map((entry) => entry.request.parentId);
      const parentIdSet = new Set(parentIds);
      const { conditions, params: refParams } = buildRefConditionsForManyParents(params.sourceRefs, parentIds);
      const queryParams: unknown[] = [...refParams];

      let query = `SELECT * FROM "${params.sourceTableName}" WHERE (${conditions.join(" OR ")})`;
      if (!params.includeDrafts) {
        query += ` AND "_status" IN ('published', 'updated')`;
      }
      if (params.filterWhere) {
        query += ` AND ${params.filterWhere}`;
        queryParams.push(...params.filterParams);
      }
      if (params.orderBy) {
        query += ` ORDER BY ${params.orderBy}`;
      }

      const rows = yield* Effect.tryPromise(() =>
        params.runSql(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql.unsafe<DynamicRow>(query, queryParams);
          })
        )
      );

      const buckets = new Map<string, DynamicRow[]>();
      const seenRowIds = new Map<string, Set<string>>();
      for (const parentId of parentIds) {
        buckets.set(parentId, []);
        seenRowIds.set(parentId, new Set());
      }

      for (const row of decodeRows(rows, params.includeDrafts)) {
        const rowId = isString(row.id) ? row.id : String(row.id);
        const matchingParentIds = extractMatchingParentIds(row, params.sourceRefs, parentIdSet);
        for (const parentId of matchingParentIds) {
          const parentSeenRowIds = seenRowIds.get(parentId);
          if (!parentSeenRowIds || parentSeenRowIds.has(rowId)) continue;
          parentSeenRowIds.add(rowId);
          const bucket = buckets.get(parentId);
          if (bucket) bucket.push(row);
        }
      }

      for (const entry of entries) {
        const result = (buckets.get(entry.request.parentId) ?? []).slice(params.skip, params.skip + params.first);
        entry.completeUnsafe(Exit.succeed(result));
      }
    }),
  ).pipe(
    RequestResolver.setDelay("0 millis"),
    RequestResolver.withCache({ capacity: 4096 }),
  );
}

function getResolver(
  params: ReverseRefLoaderParams,
): Promise<ReverseRefResolver> | null {
  const { context, loaderKey } = params;
  if (!context) return null;
  let byKey = resolverCache.get(context);
  if (!byKey) {
    byKey = new Map();
    resolverCache.set(context, byKey);
  }
  let resolver = byKey.get(loaderKey);
  if (!resolver) {
    const { context: _ctx, loaderKey: _key, parentId: _pid, ...batchParams } = params;
    void _ctx;
    void _key;
    void _pid;
    resolver = Effect.runPromise(buildReverseRefResolver(batchParams));
    byKey.set(loaderKey, resolver);
  }
  return resolver;
}

/** Load the source rows referencing one parent, batched with siblings. */
export async function loadReverseRefs(params: ReverseRefLoaderParams): Promise<DynamicRow[]> {
  const resolver = await getResolver(params);
  if (!resolver) return querySingleParent(params);

  return Effect.runPromise(
    Effect.request(new GetReverseRefs({ parentId: params.parentId }), resolver),
  );
}
