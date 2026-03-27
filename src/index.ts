import { D1Client } from "@effect/sql-d1";
import { Layer } from "effect";
import { createWebHandler } from "./http/router.js";
import type { AiBinding, VectorizeBinding } from "./search/vectorize.js";
import type { CmsHooks } from "./hooks.js";
import { decodeCmsBindings, type DecodedCmsBindings } from "./config-schema.js";
export { createCmsAdminClient } from "./admin-client.js";
export type {
  CmsAdminClientConfig,
  CreateEditorTokenRequest,
  CreateEditorTokenResponse,
  EditorTokenListItem,
} from "./admin-client.js";
export { createEditorMcpProxy } from "./editor-mcp-proxy.js";
export type {
  EditorMcpPrincipal,
  EditorMcpProxyConfig,
  EditorMcpProxy,
  EditorMcpProxyPaths,
} from "./editor-mcp-proxy.js";

export type { CmsHooks } from "./hooks.js";

/** Explicit runtime bindings/config passed to agent-cms */
export interface CmsBindings {
  db: D1Database;
  assets?: R2Bucket;
  environment?: "production" | "development";
  /** Public URL base for assets (e.g. "https://my-cms.workers.dev") */
  assetBaseUrl?: string;
  /** Write API key — required for REST writes, MCP, publish/unpublish.
   *  Like DatoCMS CMA token. Use any string for local dev (e.g. "dev"). */
  writeKey?: string;
  /** Workers AI binding for embedding generation (optional — enables vector search) */
  ai?: AiBinding;
  /** Vectorize index binding (optional — enables semantic search) */
  vectorize?: VectorizeBinding;
  /** R2 API token access key ID — enables presigned upload URLs */
  r2AccessKeyId?: string;
  /** R2 API token secret access key — enables presigned upload URLs */
  r2SecretAccessKey?: string;
  /** R2 bucket name — needed for presigned upload URLs */
  r2BucketName?: string;
  /** Cloudflare account ID — needed for the R2 S3-compatible endpoint */
  cfAccountId?: string;
  /** Public URL of the frontend site — used for assembling preview URLs */
  siteUrl?: string;
  /** Worker Loader binding for Code Mode MCP (optional — enables /mcp/codemode) */
  loader?: unknown;
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

function cacheKey(bindings: DecodedCmsBindings, hooks: CmsHooks | undefined): string {
  return [
    getObjectId(bindings.db as unknown as object),
    getObjectId(bindings.assets as unknown as object | undefined),
    getObjectId(bindings.ai as unknown as object | undefined),
    getObjectId(bindings.vectorize as unknown as object | undefined),
    getObjectId(hooks as unknown as object | undefined),
    bindings.environment ?? "",
    bindings.assetBaseUrl ?? "",
    bindings.writeKey ?? "",
    bindings.r2Credentials?.accessKeyId ?? "",
    bindings.r2Credentials?.bucketName ?? "",
    bindings.r2Credentials?.accountId ?? "",
    bindings.siteUrl ?? "",
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
 *   scheduled: (_controller, env) => getHandler(env).runScheduledTransitions(),
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
  const decodedBindings = decodeCmsBindings(config.bindings);
  const key = cacheKey(decodedBindings, config.hooks);
  const cached = handlerCache.get(key);
  if (cached) return cached;

  const handler = createCMSHandlerUncached(decodedBindings, config.hooks);
  handlerCache.set(key, handler);
  return handler;
}

function createCMSHandlerUncached(bindings: DecodedCmsBindings, hooks?: CmsHooks) {
  const sqlLayer = D1Client.layer({ db: bindings.db }).pipe(Layer.orDie);
  const webHandler = createWebHandler(sqlLayer, {
    assetBaseUrl: bindings.assetBaseUrl,
    isProduction: bindings.environment === "production",
    writeKey: bindings.writeKey,
    r2Bucket: bindings.assets,
    ai: bindings.ai,
    vectorize: bindings.vectorize,
    hooks,
    r2Credentials: bindings.r2Credentials,
    siteUrl: bindings.siteUrl,
    loader: bindings.loader,
  });

  return {
    fetch: (request: Request): Promise<Response> => webHandler.fetch(request),

    /**
     * Execute a GraphQL query directly, without HTTP serialization.
     * For in-process queries when CMS and site share a Worker.
     * Skips CORS, auth, and request logging — caller is trusted.
     */
    execute: webHandler.execute,

    /** Run due scheduled publish/unpublish transitions. Safe to call from a cron trigger. */
    runScheduledTransitions: (now?: Date) => webHandler.runScheduledTransitions(now),

    /**
     * Resolve canonical paths for all published records of a model.
     * Uses the model's canonicalPathTemplate with dot-notation traversal
     * for nested link fields (e.g., "/blog/{category.slug}/{slug}").
     * For in-process sitemap generation when CMS and site share a Worker.
     */
    resolveCanonicalPaths: (modelApiKey: string) => webHandler.resolveCanonicalPaths(modelApiKey),
  };
}
