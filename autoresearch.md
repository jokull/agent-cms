# Autoresearch: Yoga Fallback Path — Batched Relation Resolution

## Objective

Make GraphQL queries that miss the published fast path compiler materially faster. The published fast path handles simple scalar/link queries in ~3-5ms. When a query falls back to Yoga (reverse refs, deep StructuredText, unsupported filters), it hits the full resolver tree and becomes 3-10x slower.

The goal is to reduce that gap by batching relation resolution in the Yoga path: reverse refs, linked records, assets, and StructuredText dependencies.

See GitHub issue #27 for full context.

## Metrics

- **Primary**: total_ms (milliseconds, lower is better) — sum of median durations across all queries in the yoga-fallback benchmark suite
- **Secondary**: sql_statements (total SQL statement count)

## How to Run

`./autoresearch.sh` — builds, starts wrangler if needed, seeds, runs yoga-fallback benchmarks, outputs `METRIC` lines.

## The Benchmark Suite

8 queries targeting Yoga fallback patterns:

- `reverse_ref_single` — one category's `_allReferencingPosts` (the clearest hotspot, 3x slower than equivalent fast-path query)
- `reverse_ref_wide` — same but 80 posts with linked author
- `reverse_ref_all_categories` — all categories each with their referencing posts (N+1 if not batched)
- `deep_with_links` — 12 posts with full nested StructuredText + author + category
- `page_with_reverse_refs` — mixed page: fast-path siteSettings + Yoga reverse ref + meta
- `multi_category_reverse_refs` — all categories with reverse refs + nested author links
- `single_post_deep_yoga` — single post by slug with deep content (tests single-record resolver path)
- `list_summary_with_meta` — basic list + meta (partly fast-pathable, tests fallback overhead)

## The Main Bottleneck: Reverse Reference N+1

`src/graphql/reverse-ref-resolvers.ts` — every `_allReferencing*` field runs its own SQL query per parent record. When you query `allCategories { _allReferencingPosts { ... } }` with 3 categories, that's 3 separate SQL queries, one per category.

The resolver at line 102-171:
- Builds a WHERE clause matching the parent record's ID against link/links fields
- Runs a full `SELECT * FROM "content_<source>"` per parent
- No batching, no request-scoped caching, no microtask scheduling

This is the same N+1 pattern that linked-record-loader solved for link fields. The fix is the same: a request-scoped batch loader that collects parent IDs via microtask scheduling, runs one SQL query with `IN (...)`, and buckets results back.

## Other Relation Resolution Hotspots

### Link/links field resolvers (`src/graphql/content-resolvers.ts`)

Link fields already use `linked-record-loader.ts` for microbatch loading. But links fields (multi-link, JSON array of IDs) may still resolve individually. Check if multi-link fields batch properly.

### Asset resolvers (`src/graphql/asset-resolvers.ts`)

Asset fields (images) resolve by fetching from the `assets` table. If multiple records each have an image field, these should batch via `IN (...)`. Check if there's a request-scoped asset loader.

### StructuredText link resolution (`src/graphql/structured-text-resolver.ts`)

StructuredText `links` (inline record references in DAST) are resolved via `batchResolveLinkedRecordsCached()`. This is already batched within one ST field, but across multiple ST fields on different records, each field may trigger its own batch.

## Architecture Reference

### GraphQL Yoga

We use GraphQL Yoga as the execution engine. Yoga calls resolvers in the standard GraphQL.js field-by-field model. Our resolvers are regular async functions — Yoga imposes no constraints on how we fetch data inside them. The batching patterns (microtask-scheduled loaders, request-scoped caches) work naturally within Yoga's execution model. Yoga is not a constraint here.

### Request-scoped batching pattern (already proven)

`src/graphql/linked-record-loader.ts` and `src/graphql/structured-text-loader.ts` both use the same pattern:
1. Resolver calls loader with a request key
2. Loader stores a deferred promise + pending params
3. `queueMicrotask()` schedules a flush
4. Flush collects all pending requests, runs one SQL, distributes results

This pattern should be applied to:
- Reverse ref resolution (collect parent IDs, run one query per source model)
- Asset resolution (collect asset IDs, run one `SELECT * FROM assets WHERE id IN (...)`)
- StructuredText link resolution across multiple fields

### GqlContext (`src/graphql/gql-types.ts`)

The GraphQL context is request-scoped and available to all resolvers. It already carries `structuredTextEnvelopeLoaders`. New loaders (reverse-ref loader, asset loader) should be added here.

## Files in Scope

- `src/graphql/reverse-ref-resolvers.ts` — **primary target**, N+1 reverse refs
- `src/graphql/content-resolvers.ts` — field resolvers, link/asset dispatch
- `src/graphql/asset-resolvers.ts` — asset field resolution
- `src/graphql/structured-text-resolver.ts` — ST link resolution
- `src/graphql/linked-record-loader.ts` — existing batch loader (reference implementation)
- `src/graphql/structured-text-loader.ts` — existing batch loader (reference implementation)
- `src/graphql/gql-types.ts` — GqlContext type, loader storage
- `src/graphql/schema-builder.ts` — wires resolvers, builds context
- `src/graphql/handler.ts` — GraphQL handler

## Off Limits

- `src/graphql/published-fast-path.ts` — the compiler is separate, don't modify it
- `src/graphql/filter-compiler.ts` — filter compilation logic
- Published snapshot format/semantics
- `src/mcp/`, `src/dast/`, `src/db/`, `src/errors.ts`

## Constraints

- Tests must pass: `npx vitest run`
- TypeScript must compile: `npx tsc --noEmit`
- Build must succeed: `npm run build`
- No `as` casts, no `any` types
- Effect patterns (consult `~/Forks/effect-solutions/` before writing Effect code)
- No new npm dependencies
- GraphQL API must return identical responses

## Optimization Directions (ranked by expected impact)

### 1. Reverse-ref batch loader

Create a request-scoped loader (same pattern as linked-record-loader) that:
- Collects `(sourceTableName, refConditions, parentId)` tuples via microtask scheduling
- Groups by source table + field set + args shape
- Runs one SQL per group: `SELECT * FROM "content_<source>" WHERE <link_field> IN (?, ?, ...) AND _status IN ('published', 'updated')`
- Buckets results back to each parent by matching the link field value
- Store the loader on GqlContext so it's request-scoped

### 2. Asset batch loader

Create a request-scoped asset loader that:
- Collects asset IDs from all media/image field resolvers
- Runs one `SELECT * FROM assets WHERE id IN (...)` per flush
- Returns cached results for subsequent lookups
- Handles `responsiveImage` subfield resolution from the cached asset row

### 3. Cross-field StructuredText link batching

The existing `batchResolveLinkedRecordsCached` batches within one ST field. But if 12 posts each have a `content` field with link references, each field's link resolution is independent. A request-scoped linked-record cache (already partially there via `linkedRecordCache` on the resolver) could be shared more broadly.

### 4. Shared request dependency cache

Add a general-purpose request-scoped cache to GqlContext:
- `recordsById: Map<string, DynamicRow>` — any fetched record, reusable across resolvers
- `assetsById: Map<string, DynamicRow>` — fetched assets
- `reverseRefBuckets: Map<string, DynamicRow[]>` — reverse ref results

This prevents sibling resolvers from fetching the same data independently.

## What's Been Tried

### Prior sessions

1. Preview resolver optimization (57 experiments): batched materialization, AST-driven prefetch, direct D1 hot paths. 325ms → 198ms.
2. Published fast path compiler (47 experiments): SQLite JSON compilation bypassing Yoga. 75.6ms → 37.5ms.

This session targets the Yoga fallback path specifically — the code that runs when the fast path compiler can't handle the query.
