import { D1Client } from "@effect/sql-d1";
import { createWebHandler } from "./http/router.js";

/** Cloudflare Worker environment bindings for agent-cms */
export interface CmsEnv {
  DB: D1Database;
  ASSETS?: R2Bucket;
  ENVIRONMENT?: string;
  /** Public URL base for assets (e.g. "https://my-cms.workers.dev") */
  ASSET_BASE_URL?: string;
  /** Read API key — required for GraphQL reads. Like DatoCMS CDA token.
   *  Set via: wrangler secret put CMS_READ_KEY */
  CMS_READ_KEY?: string;
  /** Write API key — required for REST writes, MCP, publish/unpublish.
   *  Like DatoCMS CMA token. Set via: wrangler secret put CMS_WRITE_KEY */
  CMS_WRITE_KEY?: string;
}

/**
 * Create the agent-cms fetch handler.
 *
 * Usage in your Worker's src/index.ts:
 * ```typescript
 * import { createCMSHandler } from "agent-cms";
 *
 * export default {
 *   fetch: (request, env) => createCMSHandler(env).fetch(request),
 * };
 * ```
 */
export function createCMSHandler(env: CmsEnv) {
  const sqlLayer = D1Client.layer({ db: env.DB });
  const handler = createWebHandler(sqlLayer, {
    assetBaseUrl: env.ASSET_BASE_URL,
    isProduction: env.ENVIRONMENT === "production",
    readKey: env.CMS_READ_KEY,
    writeKey: env.CMS_WRITE_KEY,
    r2Bucket: env.ASSETS,
  });

  return {
    fetch: (request: Request): Promise<Response> => handler(request),
  };
}

// Default export for direct wrangler dev usage
export default {
  async fetch(request: Request, env: CmsEnv): Promise<Response> {
    return createCMSHandler(env).fetch(request);
  },
};
