import { createCMSHandler } from "agent-cms";

let cachedHandler: ReturnType<typeof createCMSHandler> | null = null;

function getHandler(env: Env) {
  if (!cachedHandler) {
    cachedHandler = createCMSHandler({
      bindings: {
        db: env.DB,
        assets: env.ASSETS,
        environment: env.ENVIRONMENT,
        assetBaseUrl: env.ASSET_BASE_URL,
      },
    });
  }
  return cachedHandler;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return getHandler(env).fetch(request);
  },
};

interface Env {
  DB: D1Database;
  ASSETS?: R2Bucket;
  ENVIRONMENT?: string;
  ASSET_BASE_URL?: string;
}
