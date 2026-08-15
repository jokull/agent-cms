/**
 * Request-scoped, batched structured-text envelope loader backed by
 * `RequestResolver`.
 *
 * `structured_text` fields materialize their DAST value (resolving linked
 * records, blocks and assets) through `materializeStructuredTextValues`.
 * Without batching, every block instance in a list would issue its own
 * materialization; the resolver collapses same-key lookups within the batch
 * window into one service call carrying all requests.
 *
 * One resolver per loaderKey (container model, field, block, allowed blocks),
 * promise-cached per request context. See `asset-loader.ts` for the rc.109
 * construction facts.
 */
import { Effect, Exit, Request, RequestResolver } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { GqlContext } from "./gql-types.js";
import { materializeStructuredTextValues } from "../services/structured-text-service.js";

type RunSql = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) => Promise<A>;

interface MaterializeParams {
  allowedBlockApiKeys?: readonly string[];
  parentContainerModelApiKey: string;
  parentBlockId: string | null;
  parentFieldApiKey: string;
  rootRecordId: string;
  rootFieldApiKey: string;
  rawValue: unknown;
}

/** A single materialization request, keyed for the result map + cache. */
export class GetStructuredTextEnvelope extends Request.Class<
  { readonly requestKey: string } & MaterializeParams,
  unknown,
  unknown,
  never
> {}

export type StructuredTextResolver = RequestResolver.RequestResolver<GetStructuredTextEnvelope>;

/** Per-request resolver cache, keyed by the loader key. */
const resolverCache = new WeakMap<GqlContext, Map<string, Promise<StructuredTextResolver>>>();

function getLoaderKey(params: MaterializeParams) {
  const allowed = params.allowedBlockApiKeys?.join(",") ?? "*";
  return [
    params.parentContainerModelApiKey,
    params.parentFieldApiKey,
    params.parentBlockId ?? "root",
    params.rootFieldApiKey,
    allowed,
  ].join(":");
}

function getRequestKey(params: MaterializeParams) {
  return [
    params.rootRecordId,
    params.rootFieldApiKey,
    params.parentContainerModelApiKey,
    params.parentFieldApiKey,
    params.parentBlockId ?? "root",
  ].join(":");
}

/**
 * Build the resolver for one loaderKey. Every lookup in the batch window is
 * materialized in a single `materializeStructuredTextValues` call; results
 * are cached (LRU, 4096) for the lifetime of the resolver.
 */
export function buildStructuredTextResolver(
  runSql: RunSql,
): Effect.Effect<StructuredTextResolver, unknown, never> {
  return RequestResolver.make<GetStructuredTextEnvelope>(
    Effect.fn(function* (entries) {
      const results = yield* Effect.tryPromise(() =>
        runSql(
          materializeStructuredTextValues({
            materializeContext: { blockModelSchemas: new Map(), candidateBlockModels: new Map() },
            requests: entries.map((entry) => {
              const { requestKey, ...params } = entry.request;
              return { requestKey, ...params };
            }),
          })
        )
      );
      for (const entry of entries) {
        entry.completeUnsafe(Exit.succeed(results.get(entry.request.requestKey) ?? null));
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
  params: MaterializeParams,
): Promise<StructuredTextResolver> | null {
  if (!context) return null;
  let byKey = resolverCache.get(context);
  if (!byKey) {
    byKey = new Map();
    resolverCache.set(context, byKey);
  }
  const loaderKey = getLoaderKey(params);
  let resolver = byKey.get(loaderKey);
  if (!resolver) {
    resolver = Effect.runPromise(buildStructuredTextResolver(runSql));
    byKey.set(loaderKey, resolver);
  }
  return resolver;
}

/** Materialize one structured-text envelope, batched with sibling lookups. */
export async function loadStructuredTextEnvelope(params: {
  runSql: RunSql;
  context?: GqlContext;
} & MaterializeParams) {
  const resolver = await getResolver(params.runSql, params.context, params);
  if (!resolver) {
    const results = await params.runSql(
      materializeStructuredTextValues({
        materializeContext: { blockModelSchemas: new Map(), candidateBlockModels: new Map() },
        requests: [{ requestKey: "single", ...params }],
      })
    );
    return results.get("single") ?? null;
  }

  return Effect.runPromise(
    Effect.request(
      new GetStructuredTextEnvelope({ requestKey: getRequestKey(params), ...params }),
      resolver,
    ),
  );
}
