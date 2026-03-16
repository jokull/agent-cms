/**
 * Vectorize semantic search using Cloudflare Workers AI + Vectorize.
 * Optional — gracefully degrades when bindings are not available.
 */

/** Minimal type for Workers AI binding (avoids importing @cloudflare/workers-types globally) */
export interface AiBinding {
  run(model: string, input: { text: string[] }): Promise<{ data: number[][] }>;
}

/** Minimal type for Vectorize binding */
export interface VectorizeBinding {
  upsert(vectors: Array<{ id: string; values: number[]; metadata?: Record<string, string> }>): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
  query(vector: number[], options: { topK: number; returnMetadata?: "all" | "none" }): Promise<{
    matches: Array<{ id: string; score: number; metadata?: Record<string, string> }>;
  }>;
}

const EMBED_MODEL = "@cf/baai/bge-small-en-v1.5";

/**
 * Generate embeddings for text chunks using Workers AI.
 */
export async function embedTexts(ai: AiBinding, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const result = await ai.run(EMBED_MODEL, { text: texts });
  return result.data;
}

/**
 * Index a record into Vectorize.
 * Creates one vector per record with title + body concatenated.
 */
export async function vectorizeIndex(
  ai: AiBinding,
  vectorize: VectorizeBinding,
  modelApiKey: string,
  recordId: string,
  title: string,
  body: string
): Promise<void> {
  const text = [title, body].filter(Boolean).join(" — ");
  if (!text) return;
  const [embedding] = await embedTexts(ai, [text]);
  await vectorize.upsert([{
    id: `${modelApiKey}:${recordId}`,
    values: embedding,
    metadata: { recordId, modelApiKey },
  }]);
}

/**
 * Remove a record from Vectorize.
 */
export async function vectorizeDeindex(
  vectorize: VectorizeBinding,
  modelApiKey: string,
  recordId: string
): Promise<void> {
  await vectorize.deleteByIds([`${modelApiKey}:${recordId}`]);
}

export interface VectorResult {
  recordId: string;
  modelApiKey: string;
  score: number;
}

/**
 * Semantic search via Vectorize.
 */
export async function vectorizeSearch(
  ai: AiBinding,
  vectorize: VectorizeBinding,
  query: string,
  topK: number = 20
): Promise<VectorResult[]> {
  const [queryEmbedding] = await embedTexts(ai, [query]);
  const results = await vectorize.query(queryEmbedding, {
    topK,
    returnMetadata: "all",
  });
  return results.matches.map((m) => ({
    recordId: m.metadata?.recordId ?? m.id.split(":")[1],
    modelApiKey: m.metadata?.modelApiKey ?? m.id.split(":")[0],
    score: m.score,
  }));
}

/**
 * Reciprocal Rank Fusion — merge FTS5 and Vectorize results.
 * Records appearing in both result sets get boosted.
 */
export function reciprocalRankFusion(
  ftsResults: Array<{ recordId: string; modelApiKey: string }>,
  vectorResults: Array<{ recordId: string; modelApiKey: string }>,
  k: number = 60
): Array<{ recordId: string; modelApiKey: string; score: number }> {
  const scores = new Map<string, { recordId: string; modelApiKey: string; score: number }>();

  for (let i = 0; i < ftsResults.length; i++) {
    const r = ftsResults[i];
    const key = `${r.modelApiKey}:${r.recordId}`;
    const rrf = 1 / (k + i + 1);
    const existing = scores.get(key);
    if (existing) {
      existing.score += rrf;
    } else {
      scores.set(key, { recordId: r.recordId, modelApiKey: r.modelApiKey, score: rrf });
    }
  }

  for (let i = 0; i < vectorResults.length; i++) {
    const r = vectorResults[i];
    const key = `${r.modelApiKey}:${r.recordId}`;
    const rrf = 1 / (k + i + 1);
    const existing = scores.get(key);
    if (existing) {
      existing.score += rrf;
    } else {
      scores.set(key, { recordId: r.recordId, modelApiKey: r.modelApiKey, score: rrf });
    }
  }

  return [...scores.values()].sort((a, b) => b.score - a.score);
}
