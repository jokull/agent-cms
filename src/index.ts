import { Effect } from "effect";
import { D1Client } from "@effect/sql-d1";
import { createWebHandler } from "./http/router.js";
import { ensureSchema } from "./migrations.js";
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

/**
 * Create the agent-cms fetch handler.
 * Auto-migrates the D1 database on first request (fast no-op on subsequent requests).
 *
 * Usage in your Worker's src/index.ts:
 * ```typescript
 * import { createCMSHandler } from "agent-cms";
 *
 * export default {
 *   fetch: (request, env) => createCMSHandler({
 *     bindings: {
 *       db: env.DB,
 *       assets: env.ASSETS,
 *       environment: env.ENVIRONMENT,
 *       assetBaseUrl: env.ASSET_BASE_URL,
 *       readKey: env.CMS_READ_KEY,
 *       writeKey: env.CMS_WRITE_KEY,
 *       ai: env.AI,
 *       vectorize: env.VECTORIZE,
 *     },
 *   }).fetch(request),
 * };
 * ```
 */
export function createCMSHandler(config: CmsHandlerConfig) {
  const { bindings, hooks } = config;
  const sqlLayer = D1Client.layer({ db: bindings.db });
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

  // Auto-migrate: once per isolate (persists across requests in the same Worker instance)
  let migrated = false;

  return {
    fetch: async (request: Request): Promise<Response> => {
      if (!migrated) {
        await Effect.runPromise(ensureSchema().pipe(Effect.provide(sqlLayer)));
        migrated = true;
      }
      return handler(request);
    },
  };
}
