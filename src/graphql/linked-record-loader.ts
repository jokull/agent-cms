/**
 * Request-scoped, batched linked-record loader backed by `RequestResolver`.
 *
 * Resolves `link`/`links` fields against their target models without an N+1:
 * every lookup that arrives within the batch window for the same
 * (target models, drafts mode) key is resolved in one batched query.
 *
 * One resolver per (targetApiKeys, includeDrafts) key, built once per request
 * context (promise-cached so concurrent first callers share the build).
 * See `asset-loader.ts` for the rc.109 construction facts (make/setDelay →
 * value; withCache → Effect, evaluate once).
 */
import { Effect, Exit, Request, RequestResolver } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { DynamicRow, GqlContext } from "./gql-types.js";
import { batchResolveLinkedRecords } from "./structured-text-resolver.js";

type RunSql = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) => Promise<A>;

/** A single linked-record lookup. `null` when the record does not exist. */
export class GetLinkedRecord extends Request.Class<
  { readonly id: string },
  DynamicRow | null,
  unknown,
  never
> {}

export type LinkedRecordResolver = RequestResolver.RequestResolver<GetLinkedRecord>;

type LoaderKey = `${string}:${string}`;

function getLoaderKey(targetApiKeys: readonly string[], includeDrafts: boolean): LoaderKey {
  return `${includeDrafts ? "drafts" : "published"}:${targetApiKeys.join(",")}`;
}

/** Per-request resolver cache, keyed by (target models, drafts mode). */
const resolverCache = new WeakMap<GqlContext, Map<LoaderKey, Promise<LinkedRecordResolver>>>();

/**
 * Build the resolver for one (targetApiKeys, includeDrafts) key. Batches all
 * lookups in the window into one `batchResolveLinkedRecords` call and caches
 * results (LRU, 4096) for the lifetime of the resolver.
 */
export function buildLinkedRecordResolver(params: {
  runSql: RunSql;
  targetApiKeys: string[];
  typeNames: Map<string, string>;
  includeDrafts: boolean;
}): Effect.Effect<LinkedRecordResolver, unknown, never> {
  return RequestResolver.make<GetLinkedRecord>(
    Effect.fn(function* (entries) {
      const ids = [...new Set(entries.map((entry) => entry.request.id))];
      const fetched = yield* Effect.tryPromise(() =>
        batchResolveLinkedRecords({
          runSql: params.runSql,
          targetApiKeys: params.targetApiKeys,
          ids,
          typeNames: params.typeNames,
          includeDrafts: params.includeDrafts,
        })
      );
      for (const entry of entries) {
        entry.completeUnsafe(Exit.succeed(fetched.get(entry.request.id) ?? null));
      }
    }),
  ).pipe(
    RequestResolver.setDelay("0 millis"),
    RequestResolver.withCache({ capacity: 4096 }),
  );
}

function getResolver(
  params: {
    runSql: RunSql;
    context?: GqlContext;
    targetApiKeys: string[];
    includeDrafts: boolean;
    typeNames: Map<string, string>;
  },
): Promise<LinkedRecordResolver> | null {
  const { context, targetApiKeys, includeDrafts } = params;
  if (!context) return null;
  let byKey = resolverCache.get(context);
  if (!byKey) {
    byKey = new Map();
    resolverCache.set(context, byKey);
  }
  const key = getLoaderKey(targetApiKeys, includeDrafts);
  let resolver = byKey.get(key);
  if (!resolver) {
    resolver = Effect.runPromise(buildLinkedRecordResolver(params));
    byKey.set(key, resolver);
  }
  return resolver;
}

/**
 * Load linked records by id, batching across every sibling resolver that asks
 * within the same batch window for the same (targets, drafts mode) key.
 * Missing ids are simply absent from the result.
 */
export async function loadLinkedRecords(params: {
  runSql: RunSql;
  targetApiKeys: string[];
  ids: string[];
  typeNames: Map<string, string>;
  includeDrafts: boolean;
  context?: GqlContext;
}) {
  if (params.ids.length === 0) return new Map<string, DynamicRow>();

  const resolver = await getResolver(params);
  if (!resolver) return batchResolveLinkedRecords(params);

  const rows = await Promise.all(
    params.ids.map((id) =>
      Effect.runPromise(Effect.request(new GetLinkedRecord({ id }), resolver)),
    ),
  );
  const result = new Map<string, DynamicRow>();
  for (let i = 0; i < params.ids.length; i++) {
    const row = rows[i];
    if (row) result.set(params.ids[i], row);
  }
  return result;
}
