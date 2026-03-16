import type { Effect } from "effect";
import type { SqlClient } from "@effect/sql";
import type { DynamicRow, GqlContext } from "./gql-types.js";
import { batchResolveLinkedRecords } from "./structured-text-resolver.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

interface LinkedRecordLoader {
  cache: Map<string, Promise<DynamicRow | null>>;
  pending: Map<string, Deferred<DynamicRow | null>>;
  scheduled: boolean;
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

function getLoaderKey(targetApiKeys: readonly string[], includeDrafts: boolean) {
  return `${includeDrafts ? "drafts" : "published"}:${targetApiKeys.join(",")}`;
}

function getLoader(context: GqlContext | undefined, targetApiKeys: readonly string[], includeDrafts: boolean) {
  if (!context) return null;
  context.linkedRecordLoaders ??= new Map();
  const loaderKey = getLoaderKey(targetApiKeys, includeDrafts);
  let loader = context.linkedRecordLoaders.get(loaderKey);
  if (!loader) {
    loader = {
      cache: new Map(),
      pending: new Map(),
      scheduled: false,
    } satisfies LinkedRecordLoader;
    context.linkedRecordLoaders.set(loaderKey, loader);
  }
  return loader;
}

function scheduleFlush(params: {
  loader: LinkedRecordLoader;
  runSql: <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) => Promise<A>;
  targetApiKeys: string[];
  typeNames: Map<string, string>;
  includeDrafts: boolean;
}) {
  if (params.loader.scheduled) return;
  params.loader.scheduled = true;

  queueMicrotask(async () => {
    const pending = new Map(params.loader.pending);
    params.loader.pending.clear();
    params.loader.scheduled = false;
    if (pending.size === 0) return;

    const ids = [...pending.keys()];
    try {
      const fetched = await batchResolveLinkedRecords({
        runSql: params.runSql,
        targetApiKeys: params.targetApiKeys,
        ids,
        typeNames: params.typeNames,
        includeDrafts: params.includeDrafts,
      });
      for (const [id, deferred] of pending) {
        deferred.resolve(fetched.get(id) ?? null);
      }
    } catch (error) {
      for (const [id, deferred] of pending) {
        params.loader.cache.delete(id);
        deferred.reject(error);
      }
    }
  });
}

export async function loadLinkedRecords(params: {
  runSql: <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) => Promise<A>;
  targetApiKeys: string[];
  ids: string[];
  typeNames: Map<string, string>;
  includeDrafts: boolean;
  context?: GqlContext;
}) {
  if (params.ids.length === 0) return new Map<string, DynamicRow>();

  const loader = getLoader(params.context, params.targetApiKeys, params.includeDrafts);
  if (!loader) {
    return batchResolveLinkedRecords(params);
  }

  for (const id of params.ids) {
    if (loader.cache.has(id)) continue;
    const deferred = createDeferred<DynamicRow | null>();
    loader.cache.set(id, deferred.promise);
    loader.pending.set(id, deferred);
  }

  scheduleFlush({
    loader,
    runSql: params.runSql,
    targetApiKeys: params.targetApiKeys,
    typeNames: params.typeNames,
    includeDrafts: params.includeDrafts,
  });

  const result = new Map<string, DynamicRow>();
  for (const id of params.ids) {
    const record = await loader.cache.get(id);
    if (record) result.set(id, record);
  }
  return result;
}
