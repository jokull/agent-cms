import { Effect } from "effect";
import type { SqlClient } from "@effect/sql";
import type { GqlContext } from "./gql-types.js";
import { materializeStructuredTextValue } from "../services/structured-text-service.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

interface StructuredTextEnvelopeLoader {
  cache: Map<string, Promise<unknown>>;
  pending: Map<string, {
    deferred: Deferred<unknown>;
    params: MaterializeParams;
  }>;
  scheduled: boolean;
}

interface MaterializeParams {
  allowedBlockApiKeys?: readonly string[];
  parentContainerModelApiKey: string;
  parentBlockId: string | null;
  parentFieldApiKey: string;
  rootRecordId: string;
  rootFieldApiKey: string;
  rawValue: unknown;
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

function getLoader(context: GqlContext | undefined, params: MaterializeParams) {
  if (!context) return null;
  context.structuredTextEnvelopeLoaders ??= new Map();
  const loaderKey = getLoaderKey(params);
  let loader = context.structuredTextEnvelopeLoaders.get(loaderKey);
  if (!loader) {
    loader = {
      cache: new Map(),
      pending: new Map(),
      scheduled: false,
    } satisfies StructuredTextEnvelopeLoader;
    context.structuredTextEnvelopeLoaders.set(loaderKey, loader);
  }
  return loader;
}

function scheduleFlush(params: {
  loader: StructuredTextEnvelopeLoader;
  runSql: <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) => Promise<A>;
}) {
  if (params.loader.scheduled) return;
  params.loader.scheduled = true;

  queueMicrotask(() => {
    void (async () => {
      const pending = [...params.loader.pending.entries()];
      params.loader.pending.clear();
      params.loader.scheduled = false;
      if (pending.length === 0) return;

    try {
      const results = await params.runSql(
        Effect.gen(function* () {
          const envelopes = new Map<string, unknown>();
          const materializeContext = { blockModelSchemas: new Map() };
          for (const [requestKey, entry] of pending) {
            const envelope = yield* materializeStructuredTextValue({
              ...entry.params,
              materializeContext,
            });
            envelopes.set(requestKey, envelope);
          }
          return envelopes;
        })
      );

      for (const [requestKey, entry] of pending) {
        entry.deferred.resolve(results.get(requestKey) ?? null);
      }
    } catch (error) {
        for (const [requestKey, entry] of pending) {
          params.loader.cache.delete(requestKey);
          entry.deferred.reject(error);
        }
      }
    })();
  });
}

export async function loadStructuredTextEnvelope(params: {
  runSql: <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) => Promise<A>;
  context?: GqlContext;
} & MaterializeParams) {
  const loader = getLoader(params.context, params);
  if (!loader) {
    return params.runSql(materializeStructuredTextValue(params));
  }

  const requestKey = getRequestKey(params);
  const cached = loader.cache.get(requestKey);
  if (cached) {
    return cached;
  }

  const deferred = createDeferred<unknown>();
  loader.cache.set(requestKey, deferred.promise);
  loader.pending.set(requestKey, {
    deferred,
    params,
  });
  scheduleFlush({
    loader,
    runSql: params.runSql,
  });
  return deferred.promise;
}
