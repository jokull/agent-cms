import { createCMSHandler } from "agent-cms";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return createCMSHandler({
      bindings: {
        db: env.DB,
        assets: env.ASSETS,
        environment: env.ENVIRONMENT,
        assetBaseUrl: env.ASSET_BASE_URL,
      },
    }).fetch(request);
  },
};

interface Env {
  DB: D1Database;
  ASSETS?: R2Bucket;
  ENVIRONMENT?: string;
  ASSET_BASE_URL?: string;
}
