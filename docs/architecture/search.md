# Fulltext & Vector Search

Design document for content search in agent-cms. Two complementary layers: D1 FTS5 for keyword search and Cloudflare Vectorize for semantic search. Both edge-native, both essentially free at CMS scale.

## Architecture

```
Content mutation (create/update/publish/delete)
  │
  ├─ Record saved to D1 (existing path)
  │
  ├─ Text extraction
  │   └─ Walk DAST tree + text fields → plain text
  │
  ├─ FTS5 indexing (keyword search)
  │   └─ INSERT/UPDATE fts_{model} virtual table
  │
  └─ Vectorize indexing (semantic search)
      ├─ Chunk text (heading boundaries, 200-800 tokens)
      ├─ Embed via Workers AI bge-small-en-v1.5 (384 dims)
      └─ Upsert to Vectorize index

Search query
  │
  ├─ FTS5 MATCH → BM25-ranked record IDs
  ├─ Vectorize KNN → cosine-ranked record IDs
  ├─ Reciprocal rank fusion → merged ranking
  └─ Fetch full records from D1
```

## 1. Text Extraction

### DAST → Plain Text

The StructuredText field stores a DAST (Document Abstract Syntax Tree) document. Text lives in `span` nodes scattered throughout the tree. Blocks may contain nested StructuredText fields with their own DAST trees.

**Reference:** [`datocms-structured-text-to-plain-text`](https://github.com/datocms/structured-text/tree/main/packages/to-plain-text) — DatoCMS's own implementation. Recursive tree walk, span extraction, whitespace normalization.

**Our DAST types** are defined in [`src/dast/types.ts`](../../src/dast/types.ts):

```
RootNode
  └─ BlockLevelNode[]
       ├─ ParagraphNode → InlineNode[] → SpanNode.value (text here)
       ├─ HeadingNode (level 1-6) → InlineNode[]
       ├─ ListNode → ListItemNode[] → ParagraphNode[]
       ├─ BlockquoteNode → BlockLevelNode[]
       ├─ CodeNode (code content, not prose)
       ├─ BlockNode (reference to block record by ID)
       └─ ThematicBreakNode
```

**Existing tree-walk pattern** in [`src/dast/validate.ts`](../../src/dast/validate.ts) — `walkNodesForType()` recursively traverses all DAST nodes collecting IDs by type. The text extractor follows the same pattern but collects `span.value` strings instead.

**Implementation plan:**

New file: `src/search/extract-text.ts`

```typescript
// Extract plain text from a DAST document
function extractDastText(dast: unknown): string

// Extract searchable text from all fields of a record
function extractRecordText(
  record: Record<string, unknown>,
  fields: ParsedFieldRow[],
  blockData?: Map<string, Record<string, unknown>>
): { fullText: string; sections: TextSection[] }

interface TextSection {
  heading?: string;    // h2/h3 text (for chunk boundaries)
  text: string;        // section body text
  fieldApiKey: string; // which field this came from
}
```

### Searchable Field Types

From the field type registry in [`src/field-types.ts`](../../src/field-types.ts):

| Field Type | Text Extraction |
|---|---|
| `string` | Direct value |
| `text` | Direct value |
| `slug` | Skip (derived from other fields) |
| `structured_text` | Walk DAST tree, collect `span.value` from all nodes |
| `seo` | Extract `title` + `description` from JSON object |
| `json` | Skip (unstructured, not reliably searchable) |
| `boolean`, `integer`, `float`, `date`, `date_time` | Skip |
| `media`, `media_gallery` | Extract `alt` + `title` from linked assets |
| `link`, `links` | Skip (reference IDs, not text) |
| `color`, `lat_lon` | Skip |

For localized fields (`field.localized === true`), the value is a JSON object `{"en": "...", "is": "..."}`. Extract text for each locale separately and index per-locale.

### Block Text Resolution

Blocks referenced in DAST (`type: "block"`, `type: "inlineBlock"`) need their text extracted too. The block data lives in separate `block_{type}` tables — [`src/schema-engine/sql-records.ts`](../../src/schema-engine/sql-records.ts) handles fetching them.

Flow:
1. Extract block IDs from DAST using [`extractBlockIds()`](../../src/dast/index.ts)
2. Fetch block records from `block_{type}` tables
3. For each block, extract text from its fields (same field-type logic)
4. If a block has a `structured_text` field → recurse (blocks can nest)
5. Inline the extracted block text at the position where the block appears in the DAST

This recursive resolution already exists in the GraphQL StructuredText resolver in [`src/graphql/schema-builder.ts`](../../src/graphql/schema-builder.ts) (search for "recursive batch-fetch"). The text extractor follows the same pattern but returns plain text instead of resolved records.

## 2. Chunking

Split extracted text into segments suitable for embedding. Each chunk should be 200-800 tokens (~150-600 words).

**Strategy: heading-based splitting**

1. Walk the DAST and split at `HeadingNode` boundaries (h2, h3)
2. Each section under a heading becomes one chunk
3. Prepend context: `"{record title} > {section heading} > "` to each chunk
4. If a section exceeds 800 tokens, split further at paragraph boundaries
5. 10-20% overlap between chunks (repeat last 1-2 paragraphs of previous chunk)

```typescript
interface Chunk {
  text: string;          // chunk content with prepended context
  recordId: string;
  modelApiKey: string;
  fieldApiKey: string;
  chunkIndex: number;
  heading?: string;      // section heading (for display in results)
}

function chunkRecord(
  recordId: string,
  modelApiKey: string,
  sections: TextSection[],
  title: string
): Chunk[]
```

## 3. FTS5 (Keyword Search)

D1 supports SQLite FTS5 natively. Zero cost, zero external services.

### Virtual Tables

Create one FTS5 virtual table per content model:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS fts_post
USING fts5(
  record_id UNINDEXED,    -- for joining back to content table
  title,                   -- higher weight
  body,                    -- concatenated text fields
  content=''               -- contentless (we manage content ourselves)
);
```

Use `rank` for BM25 scoring. Columns listed first get implicit higher weight in FTS5 ranking.

### Index Lifecycle

Managed via Effect services, triggered from record mutation hooks in [`src/services/record-service.ts`](../../src/services/record-service.ts):

| Event | Action |
|---|---|
| `record.create` | Extract text → `INSERT INTO fts_{model}` |
| `record.update` | Delete old → insert new (FTS5 contentless tables don't support UPDATE) |
| `record.delete` | `DELETE FROM fts_{model} WHERE record_id = ?` |
| `record.publish` | No-op (FTS5 indexes draft content; filter by `_status` at query time) |
| `field.create` / `field.delete` | Rebuild FTS5 table (columns changed) |
| `model.delete` | `DROP TABLE IF EXISTS fts_{model}` |

The webhook system in [`src/services/webhook-service.ts`](../../src/services/webhook-service.ts) already fires on all these events. The search indexer hooks into the same points.

### Query API

```graphql
type Query {
  _search(query: String!, first: Int, skip: Int): [SearchResult!]!
}

type SearchResult {
  record: JSON!          # full record data
  modelApiKey: String!
  score: Float!          # BM25 rank
  snippet: String        # FTS5 snippet() with highlights
}
```

SQL under the hood:

```sql
SELECT record_id, rank, snippet(fts_post, 1, '<mark>', '</mark>', '...', 32)
FROM fts_post
WHERE fts_post MATCH ?
ORDER BY rank
LIMIT ? OFFSET ?
```

The `MATCH` operator supports:
- Phrase search: `"content management"`
- Prefix search: `agent*`
- Boolean: `agent AND cms`, `agent OR dashboard`
- Column-scoped: `title:agent`

## 4. Vectorize (Semantic Search)

Cloudflare Vectorize is a managed vector database that runs on the same edge network as D1.

**Docs:** [developers.cloudflare.com/vectorize](https://developers.cloudflare.com/vectorize/)

### Setup

Add bindings to `CmsEnv` in [`src/index.ts`](../../src/index.ts):

```typescript
export interface CmsEnv {
  DB: D1Database;
  ASSETS?: R2Bucket;
  AI?: Ai;              // Workers AI for embedding generation
  VECTORIZE?: VectorizeIndex;  // Cloudflare Vectorize index
  // ... existing fields
}
```

Wrangler config:

```jsonc
{
  "ai": { "binding": "AI" },
  "vectorize": [
    {
      "binding": "VECTORIZE",
      "index_name": "cms-content"
    }
  ]
}
```

Create the index:

```bash
npx wrangler vectorize create cms-content --dimensions=384 --metric=cosine
```

### Embedding Generation

Use Workers AI [`bge-small-en-v1.5`](https://developers.cloudflare.com/workers-ai/models/bge-small-en-v1.5/) — 384 dimensions, English, fast, cheap.

For multilingual CMS content, use [`bge-m3`](https://developers.cloudflare.com/workers-ai/models/bge-m3/) — 100+ languages, 1024 dimensions.

```typescript
async function embedText(ai: Ai, texts: string[]): Promise<number[][]> {
  const result = await ai.run("@cf/baai/bge-small-en-v1.5", { text: texts });
  return result.data; // number[][] — one embedding per input text
}
```

### Index Pipeline

On record create/update/publish:

```typescript
function indexRecord(
  vectorize: VectorizeIndex,
  ai: Ai,
  chunks: Chunk[]
): Effect<void> {
  // 1. Generate embeddings for all chunks in one call
  const embeddings = await embedText(ai, chunks.map(c => c.text));

  // 2. Upsert vectors with metadata
  await vectorize.upsert(
    chunks.map((chunk, i) => ({
      id: `${chunk.recordId}:${chunk.chunkIndex}`,
      values: embeddings[i],
      metadata: {
        recordId: chunk.recordId,
        modelApiKey: chunk.modelApiKey,
        fieldApiKey: chunk.fieldApiKey,
        heading: chunk.heading ?? "",
      },
    }))
  );
}
```

On record delete:

```typescript
// Vectorize supports deletion by ID prefix (via namespace) or individual IDs
// Store chunk count in metadata or query by recordId filter
await vectorize.deleteByIds(
  chunkIds.map(i => `${recordId}:${i}`)
);
```

### Query Pipeline

```typescript
async function semanticSearch(
  vectorize: VectorizeIndex,
  ai: Ai,
  query: string,
  topK: number = 20
): Promise<{ recordId: string; score: number }[]> {
  const [queryEmbedding] = await embedText(ai, [query]);
  const results = await vectorize.query(queryEmbedding, {
    topK,
    returnMetadata: "all",
  });
  return results.matches.map(m => ({
    recordId: m.metadata!.recordId as string,
    score: m.score,
  }));
}
```

## 5. Hybrid Search (FTS5 + Vectorize)

Neither keyword search nor semantic search is sufficient alone:
- FTS5 finds exact matches but misses paraphrases ("CMS" won't match "content management system")
- Vectorize finds semantic similarity but can miss exact keywords and proper nouns

Combine both using **reciprocal rank fusion (RRF)**.

**Reference:** [Contextual RAG on Cloudflare Workers](https://boristane.com/blog/cloudflare-contextual-rag/) — production implementation of this exact pattern.

### Reciprocal Rank Fusion

```typescript
function reciprocalRankFusion(
  fts5Results: { recordId: string; rank: number }[],
  vectorResults: { recordId: string; score: number }[],
  k: number = 60  // RRF constant (standard value)
): { recordId: string; score: number }[] {
  const scores = new Map<string, number>();

  // FTS5 results: rank is position (1 = best)
  fts5Results.forEach((r, i) => {
    const rrf = 1 / (k + i + 1);
    scores.set(r.recordId, (scores.get(r.recordId) ?? 0) + rrf);
  });

  // Vectorize results: already scored by cosine similarity
  vectorResults.forEach((r, i) => {
    const rrf = 1 / (k + i + 1);
    scores.set(r.recordId, (scores.get(r.recordId) ?? 0) + rrf);
  });

  return [...scores.entries()]
    .map(([recordId, score]) => ({ recordId, score }))
    .sort((a, b) => b.score - a.score);
}
```

Records appearing in both result sets get boosted. Records appearing in only one still surface.

### Search API

```
POST /api/search
{
  "query": "how to set up image resizing",
  "mode": "hybrid",     // "keyword" | "semantic" | "hybrid"
  "first": 10,
  "modelApiKey": "post" // optional: scope to model
}

→ {
  "results": [
    {
      "recordId": "01ABC...",
      "modelApiKey": "post",
      "title": "Why Cloudflare Workers",
      "score": 0.032,
      "snippet": "...set up <mark>image resizing</mark> with..."
    }
  ],
  "meta": { "count": 42, "mode": "hybrid" }
}
```

MCP tool: `search_content` with same parameters.

GraphQL: `_search(query: "...", mode: HYBRID, first: 10)` root query.

## 6. Implementation Plan

### Phase 1: Text Extraction + FTS5

No external services. Pure D1.

1. **`src/search/extract-text.ts`** — DAST→plaintext + field text extraction
2. **`src/search/fts5.ts`** — FTS5 virtual table management (create/drop/rebuild)
3. **`src/search/indexer.ts`** — Hook into record-service mutations, extract text, update FTS5
4. **`src/search/search-service.ts`** — FTS5 MATCH queries with BM25 ranking
5. **REST endpoint** — `POST /api/search` + MCP `search_content` tool
6. **Tests** — Index content, search, verify ranking

This gives keyword search immediately with zero infrastructure changes.

### Phase 2: Vectorize

Requires `AI` + `VECTORIZE` bindings (optional — FTS5 works without them).

7. **Chunking** in `src/search/chunker.ts`
8. **Embedding pipeline** in `src/search/embeddings.ts`
9. **Vectorize indexing** in `src/search/vector-indexer.ts`
10. **Hybrid search** — combine FTS5 + Vectorize in `search-service.ts`
11. **Graceful degradation** — if no `VECTORIZE` binding, fall back to FTS5-only

### File Structure

```
src/search/
  extract-text.ts      — DAST + field text extraction
  chunker.ts           — Heading-based text chunking
  fts5.ts              — FTS5 virtual table DDL + queries
  embeddings.ts        — Workers AI embedding generation
  vector-indexer.ts    — Vectorize upsert/delete
  indexer.ts           — Orchestrator: extract → chunk → index (FTS5 + Vectorize)
  search-service.ts    — Query: FTS5, semantic, hybrid + RRF
```

## 7. Cost & Performance

| Operation | Latency | Cost |
|---|---|---|
| Text extraction (in-Worker) | <1ms | Free |
| FTS5 index update (D1) | 1-5ms | Free |
| Embedding generation (Workers AI) | 10-50ms | ~free (10k Neurons/day) |
| Vectorize upsert | 5-20ms | ~free (<100k chunks) |
| FTS5 MATCH query | 1-5ms | Free |
| Vectorize KNN query | 10-30ms | ~free |
| D1 record fetch | 5-20ms | Free |
| **Total search (hybrid)** | **~50-100ms** | **~$1-5/month** |

Workers AI pricing: $0.011 per 1,000 Neurons. `bge-small-en-v1.5` uses ~1 Neuron per embedding call. Free tier: 10,000 Neurons/day = ~10,000 embedding operations per day.

Vectorize pricing: `(queried + stored vectors) × dimensions × $0.01/1M`. At 10k chunks × 384 dims = 3.84M dimension-values stored = $0.19/month.

## 8. References

### Codebase

- [`src/dast/types.ts`](../../src/dast/types.ts) — DAST node type definitions
- [`src/dast/index.ts`](../../src/dast/index.ts) — `extractBlockIds()`, `extractInlineBlockIds()`, `extractLinkIds()` tree walkers
- [`src/dast/validate.ts`](../../src/dast/validate.ts) — `walkNodesForType()` recursive traversal pattern
- [`src/field-types.ts`](../../src/field-types.ts) — `FIELD_TYPE_REGISTRY` with `localizable`, `jsonStored` flags
- [`src/services/record-service.ts`](../../src/services/record-service.ts) — Record CRUD with webhook hooks (lines ~173, ~272, ~300)
- [`src/services/webhook-service.ts`](../../src/services/webhook-service.ts) — Event types and `fireWebhooks()` pattern
- [`src/graphql/schema-builder.ts`](../../src/graphql/schema-builder.ts) — Recursive block resolution (reference for block text extraction)
- [`src/index.ts`](../../src/index.ts) — `CmsEnv` type (where `AI` and `VECTORIZE` bindings go)

### External

- [Cloudflare Vectorize docs](https://developers.cloudflare.com/vectorize/) — API, limits, pricing
- [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/)
- [Workers AI embedding models](https://developers.cloudflare.com/workers-ai/models/) — bge-small, bge-base, bge-m3
- [RAG tutorial (Cloudflare)](https://developers.cloudflare.com/workers-ai/guides/tutorials/build-a-retrieval-augmented-generation-ai/) — official D1 + Vectorize + Workers AI guide
- [Contextual RAG on Cloudflare Workers](https://boristane.com/blog/cloudflare-contextual-rag/) — hybrid FTS5 + Vectorize with reciprocal rank fusion
- [`datocms-structured-text-to-plain-text`](https://github.com/datocms/structured-text/tree/main/packages/to-plain-text) — DatoCMS DAST→plaintext implementation
- [SQLite FTS5 docs](https://www.sqlite.org/fts5.html) — MATCH syntax, ranking, snippets
- [cloudflare-rag](https://github.com/RafalWilinski/cloudflare-rag) — open-source RAG on Cloudflare
- [LangChain + Vectorize + D1](https://blog.cloudflare.com/langchain-support-for-workers-ai-vectorize-and-d1/) — LangChain.js integration

### Design decisions

- [DECISIONS.md](./DECISIONS.md) — Canonical decisions (D1-D48)
