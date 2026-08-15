/**
 * Request-scoped, batched asset loader backed by `RequestResolver`.
 *
 * Assets were the last relation family in the Yoga path without batching:
 * `media` fields issued a query per record (and per block instance), so a
 * list of N records each with an image cost N sequential D1 round trips.
 *
 * This is the docs-canonical `RequestResolver` shape (see ai-docs
 * 05_batching/10_request-resolver): a `Request.Class` per lookup, a resolver
 * that batches all requests arriving within the batch window into one SQL
 * `IN (...)` query, and `withCache` so a gallery, a media field and an SEO
 * image referencing the same upload collapse to a single fetch.
 *
 * The resolver value is built once per request context (lazily, via a
 * `WeakMap`) and shared by every resolver call in that request. Building it
 * requires evaluating the `withCache` effect exactly once — passing the
 * Effect form to `Effect.request` would rebuild the cache on every lookup.
 *
 * Returns raw `AssetRow`s rather than projected objects: each call site
 * overlays its own media reference (alt/title/focalPoint/customData) on top,
 * and those overlay rules differ between content fields, block fields and SEO.
 */
import { Effect, Exit, Request, RequestResolver } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { AssetRow } from "../db/row-types.js";
import type { GqlContext } from "./gql-types.js";

type RunSql = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) => Promise<A>;

/** A single asset lookup. `null` when the asset id does not exist. */
export class GetAsset extends Request.Class<
  { readonly id: string },
  AssetRow | null,
  unknown
> {}

export type AssetResolver = RequestResolver.RequestResolver<GetAsset>;

/**
 * Per-request resolver cache. Assets vary by neither drafts nor locale.
 *
 * The WeakMap stores the build PROMISE, not the value: the first concurrent
 * sibling resolvers all miss and share one build; storing the value would
 * let each racing caller build (and use) its own resolver, scattering the
 * batch across instances.
 */
const resolverCache = new WeakMap<GqlContext, Promise<AssetResolver>>();

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

/**
 * Build the request resolver for a given `runSql`. Batches every asset lookup
 * that arrives within the batch window into one query and caches the result
 * (LRU, 4096 entries) for the lifetime of the resolver.
 */
export function buildAssetResolver(
  runSql: RunSql,
): Effect.Effect<AssetResolver, unknown> {
  return RequestResolver.make<GetAsset>(
    Effect.fn(function* (entries) {
      const ids = [...new Set(entries.map((entry) => entry.request.id))];
      const rows = yield* Effect.tryPromise(() => batchFetchAssetRows(runSql, ids));
      for (const entry of entries) {
        entry.completeUnsafe(Exit.succeed(rows.get(entry.request.id) ?? null));
      }
    }),
  ).pipe(
    RequestResolver.setDelay("0 millis"),
    RequestResolver.withCache({ capacity: 4096 }),
  );
}

function getResolver(
  runSql: RunSql,
  context: GqlContext | undefined,
): Promise<AssetResolver> | null {
  if (!context) return null;
  let resolver = resolverCache.get(context);
  if (!resolver) {
    resolver = Effect.runPromise(buildAssetResolver(runSql));
    resolverCache.set(context, resolver);
  }
  return resolver;
}

/**
 * Load assets by id, batching across every sibling resolver that asks within
 * the same batch window. Missing ids are simply absent from the result.
 */
export async function loadAssets(params: {
  runSql: RunSql;
  ids: readonly string[];
  context?: GqlContext;
}): Promise<Map<string, AssetRow>> {
  if (params.ids.length === 0) return new Map();
  const resolver = await getResolver(params.runSql, params.context);
  if (!resolver) return batchFetchAssetRows(params.runSql, params.ids);
  const rows = await Promise.all(
    params.ids.map((id) =>
      Effect.runPromise(Effect.request(new GetAsset({ id }), resolver)),
    ),
  );
  const result = new Map<string, AssetRow>();
  for (let i = 0; i < params.ids.length; i++) {
    const row = rows[i];
    if (row) result.set(params.ids[i], row);
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
