/**
 * Request-scoped, microtask-batched asset loader.
 *
 * Assets were the last relation family in the Yoga path without one: `media`
 * fields issued a query per record (and per block instance), so a list of N
 * records each with an image cost N sequential D1 round trips. `link`/`links`
 * have had `linked-record-loader.ts` for this; this is the same shape for
 * `assets`, and every asset read on the resolver path routes through it.
 *
 * Assets need no loader key. Unlike linked records they are not affected by
 * drafts or locale, so one cache per request keyed by id is sufficient — and
 * it means a gallery, a media field and an SEO image referencing the same
 * upload collapse to a single fetch.
 *
 * Returns raw `AssetRow`s rather than projected objects: each call site
 * overlays its own media reference (alt/title/focalPoint/customData) on top,
 * and those overlay rules differ between content fields, block fields and SEO.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import type { AssetRow } from "../db/row-types.js";
import type { GqlContext } from "./gql-types.js";

type RunSql = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) => Promise<A>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

interface AssetLoader {
  cache: Map<string, Promise<AssetRow | null>>;
  pending: Map<string, Deferred<AssetRow | null>>;
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

/** One unbatched fetch. Used directly when there is no request context. */
export async function batchFetchAssetRows(
  runSql: RunSql,
  ids: readonly string[],
): Promise<Map<string, AssetRow>> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await runSql(
    Effect.gen(function* () {
      const s = yield* SqlClient.SqlClient;
      return yield* s.unsafe<AssetRow>(
        `SELECT * FROM assets WHERE id IN (${placeholders})`,
        [...ids],
      );
    }),
  );
  const map = new Map<string, AssetRow>();
  for (const row of rows) map.set(row.id, row);
  return map;
}

function getLoader(context: GqlContext | undefined): AssetLoader | null {
  if (!context) return null;
  context.assetLoader ??= {
    cache: new Map(),
    pending: new Map(),
    scheduled: false,
  } satisfies AssetLoader;
  return context.assetLoader;
}

function scheduleFlush(loader: AssetLoader, runSql: RunSql) {
  if (loader.scheduled) return;
  loader.scheduled = true;

  queueMicrotask(() => {
    void (async () => {
      const pending = new Map(loader.pending);
      loader.pending.clear();
      loader.scheduled = false;
      if (pending.size === 0) return;

      const ids = [...pending.keys()];
      try {
        const fetched = await batchFetchAssetRows(runSql, ids);
        for (const [id, deferred] of pending) {
          deferred.resolve(fetched.get(id) ?? null);
        }
      } catch (error) {
        // Evict on failure so a retry within the same request can succeed.
        for (const [id, deferred] of pending) {
          loader.cache.delete(id);
          deferred.reject(error);
        }
      }
    })();
  });
}

/**
 * Load assets by id, batching across every sibling resolver that asks within
 * the same microtask tick. Missing ids are simply absent from the result.
 */
export async function loadAssets(params: {
  runSql: RunSql;
  ids: readonly string[];
  context?: GqlContext;
}): Promise<Map<string, AssetRow>> {
  if (params.ids.length === 0) return new Map();

  const loader = getLoader(params.context);
  if (!loader) return batchFetchAssetRows(params.runSql, params.ids);

  for (const id of params.ids) {
    if (loader.cache.has(id)) continue;
    const deferred = createDeferred<AssetRow | null>();
    loader.cache.set(id, deferred.promise);
    loader.pending.set(id, deferred);
  }

  scheduleFlush(loader, params.runSql);

  const result = new Map<string, AssetRow>();
  for (const id of params.ids) {
    const row = await loader.cache.get(id);
    if (row) result.set(id, row);
  }
  return result;
}

/** Single-id convenience over {@link loadAssets}. */
export async function loadAsset(params: {
  runSql: RunSql;
  id: string;
  context?: GqlContext;
}): Promise<AssetRow | null> {
  const map = await loadAssets({ runSql: params.runSql, ids: [params.id], context: params.context });
  return map.get(params.id) ?? null;
}
