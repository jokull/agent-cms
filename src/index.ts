import { D1Client } from "@effect/sql-d1";
import { createWebHandler } from "./http/router.js";

/** Cloudflare Worker environment bindings for agent-cms */
export interface CmsEnv {
  DB: D1Database;
  ENVIRONMENT?: string;
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
  const handler = createWebHandler(sqlLayer);

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
