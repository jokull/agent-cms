import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import type { DynamicRow, GqlContext, ReverseRef } from "./gql-types.js";
import { decodeJsonIfString } from "../json.js";
import { decodeSnapshot, deserializeRecord } from "./gql-utils.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

interface ReverseRefLoader {
  cache: Map<string, Promise<DynamicRow[]>>;
  pending: Map<string, {
    deferred: Deferred<DynamicRow[]>;
    parentId: string;
  }>;
  scheduled: boolean;
}

interface ReverseRefLoaderParams {
  runSql: <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) => Promise<A>;
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

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function getLoader(context: GqlContext | undefined, loaderKey: string) {
  if (!context) return null;
  context.reverseRefLoaders ??= new Map();
  let loader = context.reverseRefLoaders.get(loaderKey);
  if (!loader) {
    loader = {
      cache: new Map(),
      pending: new Map(),
      scheduled: false,
    } satisfies ReverseRefLoader;
    context.reverseRefLoaders.set(loaderKey, loader);
  }
  return loader;
}

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
      if (typeof rawValue === "string" && parentIdSet.has(rawValue)) {
        matches.add(rawValue);
      }
      continue;
    }

    const decoded = decodeJsonIfString(rawValue);
    if (!Array.isArray(decoded)) continue;
    for (const item of decoded) {
      if (typeof item === "string" && parentIdSet.has(item)) {
        matches.add(item);
      }
    }
  }

  return matches;
}

async function querySingleParent(params: Omit<ReverseRefLoaderParams, "loaderKey" | "context">) {
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

function scheduleFlush(params: {
  loader: ReverseRefLoader;
  runSql: <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) => Promise<A>;
  sourceTableName: string;
  sourceRefs: readonly ReverseRef[];
  includeDrafts: boolean;
  filterWhere?: string;
  filterParams: readonly unknown[];
  orderBy?: string;
  first: number;
  skip: number;
}) {
  if (params.loader.scheduled) return;
  params.loader.scheduled = true;

  queueMicrotask(() => {
    void (async () => {
      const pendingEntries = [...params.loader.pending.entries()];
      params.loader.pending.clear();
      params.loader.scheduled = false;
      if (pendingEntries.length === 0) return;

      try {
        if (pendingEntries.length === 1) {
          const [cacheKey, entry] = pendingEntries[0];
          const result = await querySingleParent({
            runSql: params.runSql,
            parentId: entry.parentId,
            sourceTableName: params.sourceTableName,
            sourceRefs: params.sourceRefs,
            includeDrafts: params.includeDrafts,
            filterWhere: params.filterWhere,
            filterParams: params.filterParams,
            orderBy: params.orderBy,
            first: params.first,
            skip: params.skip,
          });
          entry.deferred.resolve(result);
          params.loader.cache.set(cacheKey, Promise.resolve(result));
          return;
        }

        const parentIds = pendingEntries.map(([, entry]) => entry.parentId);
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

        const rows = await params.runSql(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql.unsafe<DynamicRow>(query, queryParams);
          })
        );

        const buckets = new Map<string, DynamicRow[]>();
        const seenRowIds = new Map<string, Set<string>>();
        for (const parentId of parentIds) {
          buckets.set(parentId, []);
          seenRowIds.set(parentId, new Set());
        }

        for (const row of decodeRows(rows, params.includeDrafts)) {
          const rowId = typeof row.id === "string" ? row.id : String(row.id);
          const matchingParentIds = extractMatchingParentIds(row, params.sourceRefs, parentIdSet);
          for (const parentId of matchingParentIds) {
            const parentSeenRowIds = seenRowIds.get(parentId);
            if (!parentSeenRowIds || parentSeenRowIds.has(rowId)) continue;
            parentSeenRowIds.add(rowId);
            const bucket = buckets.get(parentId);
            if (bucket) bucket.push(row);
          }
        }

        for (const [cacheKey, entry] of pendingEntries) {
          const result = (buckets.get(entry.parentId) ?? []).slice(params.skip, params.skip + params.first);
          entry.deferred.resolve(result);
          params.loader.cache.set(cacheKey, Promise.resolve(result));
        }
      } catch (error) {
        for (const [cacheKey, entry] of pendingEntries) {
          params.loader.cache.delete(cacheKey);
          entry.deferred.reject(error);
        }
      }
    })();
  });
}

export async function loadReverseRefs(params: ReverseRefLoaderParams): Promise<DynamicRow[]> {
  const loader = getLoader(params.context, params.loaderKey);
  if (!loader) {
    return querySingleParent(params);
  }

  const cacheKey = params.parentId;
  const cached = loader.cache.get(cacheKey);
  if (cached) return cached;

  const deferred = createDeferred<DynamicRow[]>();
  loader.cache.set(cacheKey, deferred.promise);
  loader.pending.set(cacheKey, {
    deferred,
    parentId: params.parentId,
  });

  scheduleFlush({
    loader,
    runSql: params.runSql,
    sourceTableName: params.sourceTableName,
    sourceRefs: params.sourceRefs,
    includeDrafts: params.includeDrafts,
    filterWhere: params.filterWhere,
    filterParams: params.filterParams,
    orderBy: params.orderBy,
    first: params.first,
    skip: params.skip,
  });

  return deferred.promise;
}
