import { D1Client } from "@effect/sql-d1";
import { Layer } from "effect";
import { createWebHandler } from "./http/router.js";
import type { AiBinding, VectorizeBinding } from "./search/vectorize.js";
import type { CmsHooks } from "./hooks.js";

export type { CmsHooks } from "./hooks.js";

/** Explicit runtime bindings/config passed to agent-cms */
export interface CmsBindings {
  db: D1Database;
  assets?: R2Bucket;
  environment?: string;
  /** Public URL base for assets (e.g. "https://my-cms.workers.dev") */
  assetBaseUrl?: string;
  /** Read API key — required for GraphQL reads. Like DatoCMS CDA token.
   *  Pass from your secret/binding of choice. */
  readKey?: string;
  /** Write API key — required for REST writes, MCP, publish/unpublish.
   *  Like DatoCMS CMA token. Pass from your secret/binding of choice. */
  writeKey?: string;
  /** Workers AI binding for embedding generation (optional — enables vector search) */
  ai?: AiBinding;
  /** Vectorize index binding (optional — enables semantic search) */
  vectorize?: VectorizeBinding;
}

export interface CmsHandlerConfig {
  bindings: CmsBindings;
  /** Lifecycle hooks fired on content events */
  hooks?: CmsHooks;
}

type CachedCmsHandler = ReturnType<typeof createCMSHandlerUncached>;

const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;
const handlerCache = new Map<string, CachedCmsHandler>();

function getObjectId(value: object | undefined): number {
  if (!value) return 0;
  const existing = objectIds.get(value);
  if (existing) return existing;
  const id = nextObjectId++;
  objectIds.set(value, id);
  return id;
}

function cacheKey(config: CmsHandlerConfig): string {
  const { bindings, hooks } = config;
  return [
    getObjectId(bindings.db as unknown as object),
    getObjectId(bindings.assets as unknown as object | undefined),
    getObjectId(bindings.ai as unknown as object | undefined),
    getObjectId(bindings.vectorize as unknown as object | undefined),
    getObjectId(hooks as unknown as object | undefined),
    bindings.environment ?? "",
    bindings.assetBaseUrl ?? "",
    bindings.readKey ?? "",
    bindings.writeKey ?? "",
  ].join("|");
}

/**
 * Create the agent-cms fetch handler.
 *
 * Usage in your Worker's src/index.ts:
 * ```typescript
 * import { createCMSHandler } from "agent-cms";
 *
 * export default {
 *   fetch: (request, env) => getHandler(env).fetch(request),
 * };
 *
 * let cachedHandler: ReturnType<typeof createCMSHandler> | null = null;
 *
 * function getHandler(env: Env) {
 *   if (!cachedHandler) {
 *     cachedHandler = createCMSHandler({
 *       bindings: {
 *         db: env.DB,
 *         assets: env.ASSETS,
 *         environment: env.ENVIRONMENT,
 *         assetBaseUrl: env.ASSET_BASE_URL,
 *         readKey: env.CMS_READ_KEY,
 *         writeKey: env.CMS_WRITE_KEY,
 *         ai: env.AI,
 *         vectorize: env.VECTORIZE,
 *       },
 *     });
 *   }
 *   return cachedHandler;
 * }
 * ```
 */
export function createCMSHandler(config: CmsHandlerConfig) {
  const key = cacheKey(config);
  const cached = handlerCache.get(key);
  if (cached) return cached;

  const handler = createCMSHandlerUncached(config);
  handlerCache.set(key, handler);
  return handler;
}

function createCMSHandlerUncached(config: CmsHandlerConfig) {
  const { bindings, hooks } = config;
  const sqlLayer = D1Client.layer({ db: bindings.db }).pipe(Layer.orDie);
  const handler = createWebHandler(sqlLayer, {
    assetBaseUrl: bindings.assetBaseUrl,
    isProduction: bindings.environment === "production",
    readKey: bindings.readKey,
    writeKey: bindings.writeKey,
    r2Bucket: bindings.assets,
    ai: bindings.ai,
    vectorize: bindings.vectorize,
    hooks,
  });

  return {
    fetch: (request: Request): Promise<Response> => handler(request),
  };
}
