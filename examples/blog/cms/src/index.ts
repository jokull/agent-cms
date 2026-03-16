import { createCMSHandler } from "agent-cms";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return createCMSHandler({
      bindings: {
        db: env.DB,
        assets: env.ASSETS,
        environment: env.ENVIRONMENT,
        assetBaseUrl: env.ASSET_BASE_URL,
        ai: env.AI,
        vectorize: env.VECTORIZE,
      },
    }).fetch(request);
  },
};

interface Env {
  DB: D1Database;
  ASSETS?: R2Bucket;
  ENVIRONMENT?: string;
  ASSET_BASE_URL?: string;
  AI?: { run(model: string, input: { text: string[] }): Promise<{ data: number[][] }> };
  VECTORIZE?: {
    upsert(vectors: Array<{ id: string; values: number[]; metadata?: Record<string, string> }>): Promise<unknown>;
    deleteByIds(ids: string[]): Promise<unknown>;
    query(vector: number[], options: { topK: number; returnMetadata?: "all" | "none" }): Promise<{
      matches: Array<{ id: string; score: number; metadata?: Record<string, string> }>;
    }>;
  };
}
