import { createCMSHandler } from "agent-cms";

let cachedHandler: ReturnType<typeof createCMSHandler> | null = null;

function getHandler(env: Env) {
  if (!cachedHandler) {
    cachedHandler = createCMSHandler({
      bindings: {
        db: env.DB,
        assets: env.ASSETS,
        ai: env.AI,
        writeKey: env.CMS_WRITE_KEY || "dev",
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
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  CMS_WRITE_KEY?: string;
  ASSET_BASE_URL?: string;
}
