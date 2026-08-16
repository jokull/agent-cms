/**
 * Vectorize semantic search using Cloudflare Workers AI + Vectorize.
 * All functions return Effect — async boundaries use Effect.tryPromise.
 */
import { Data, Effect } from "effect";
import { isString } from "../dynamic/row-types.js";

/**
 * Workers AI text-embeddings response shape (bge-small-en-v1.5).
 */
export interface AiEmbeddingsResult {
  readonly data: number[][];
}

/**
 * Minimal structural type for Workers AI binding.
 * Compatible with Cloudflare's `Ai` type from `wrangler types` — no cast needed.
 */
export interface AiBinding {
  run(model: string, input: { text: string[] }): Promise<AiEmbeddingsResult>;
}

/** Vectorize mutation result: ids processed plus count (Cloudflare Vectorize contract). */
export interface VectorizeMutationResult {
  readonly ids: string[];
  readonly count: number;
}

/** Vectorize query response: scored matches (Cloudflare Vectorize contract). */
export interface VectorizeQueryResult {
  readonly matches: ReadonlyArray<{
    readonly id: string;
    readonly score: number;
    readonly metadata?: Record<string, string>;
  }>;
}

/**
 * Minimal structural type for Vectorize binding.
 * Compatible with Cloudflare's `VectorizeIndex` type from `wrangler types` — no cast needed.
 */
export interface VectorizeBinding {
  upsert(vectors: Array<{ id: string; values: number[]; metadata?: Record<string, string> }>): Promise<VectorizeMutationResult>;
  deleteByIds(ids: string[]): Promise<VectorizeMutationResult>;
  query(vector: number[], options: { topK: number; returnMetadata?: "all" | "none" }): Promise<VectorizeQueryResult>;
}

export class VectorizeError extends Data.TaggedError("VectorizeError")<{
  readonly message: string;
}> {}

function describeUnknown(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (isString(cause)) return cause;
  return JSON.stringify(cause);
}

const EMBED_MODEL = "@cf/baai/bge-small-en-v1.5";

/**
 * Generate embeddings for text chunks using Workers AI.
 */
export function embedTexts(ai: AiBinding, texts: string[]) {
  if (texts.length === 0) return Effect.succeed<number[][]>([]);
  return Effect.tryPromise({
    try: () => ai.run(EMBED_MODEL, { text: texts }),
    catch: (error) => new VectorizeError({ message: `Embedding failed: ${describeUnknown(error)}` }),
  }).pipe(
    Effect.map((result) => result.data),
  );
}

/**
 * Index a record into Vectorize.
 */
export function vectorizeIndex(
  ai: AiBinding,
  vectorize: VectorizeBinding,
  modelApiKey: string,
  recordId: string,
  title: string,
  body: string
) {
  const text = [title, body].filter(Boolean).join(" — ");
  if (!text) return Effect.void;
  return Effect.gen(function* () {
    const embeddings = yield* embedTexts(ai, [text]);
    yield* Effect.tryPromise({
      try: () => vectorize.upsert([{
        id: `${modelApiKey}:${recordId}`,
        values: embeddings[0],
        metadata: { recordId, modelApiKey },
      }]),
      catch: (error) => new VectorizeError({ message: `Upsert failed: ${describeUnknown(error)}` }),
    });
  });
}

/**
 * Remove a record from Vectorize.
 */
export function vectorizeDeindex(
  vectorize: VectorizeBinding,
  modelApiKey: string,
  recordId: string
) {
  return Effect.tryPromise({
    try: () => vectorize.deleteByIds([`${modelApiKey}:${recordId}`]),
    catch: (error) => new VectorizeError({ message: `Deindex failed: ${describeUnknown(error)}` }),
  });
}

export interface VectorResult {
  recordId: string;
  modelApiKey: string;
  score: number;
}

/**
 * Semantic search via Vectorize.
 */
export function vectorizeSearch(
  ai: AiBinding,
  vectorize: VectorizeBinding,
  query: string,
  topK: number = 20
) {
  return Effect.gen(function* () {
    const embeddings = yield* embedTexts(ai, [query]);
    const raw = yield* Effect.tryPromise({
      try: () => vectorize.query(embeddings[0], { topK, returnMetadata: "all" }),
      catch: (error) => new VectorizeError({ message: `Search failed: ${describeUnknown(error)}` }),
    });
    return raw.matches.map((m) => ({
      recordId: m.metadata?.recordId ?? m.id.split(":")[1],
      modelApiKey: m.metadata?.modelApiKey ?? m.id.split(":")[0],
      score: m.score,
    }));
  });
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
