# Autoresearch: GraphQL Resolver Performance

## Objective

Reduce wall-clock time of GraphQL queries by optimizing how resolvers traverse relationships and turn them into SQLite queries. Every GraphQL field that references another record — link fields, StructuredText with blocks, assets, reverse links — becomes one or more SQL lookups. The total query time is dominated by how many of these lookups happen and whether they run sequentially or batched.

The biggest bottleneck is **StructuredText preview materialization** (reconstructing nested block structures from relational block tables), but link resolution, asset fetching, and any other resolver → SQL path is fair game.

Current behavior for StructuredText: for each field, it loops over candidate block model tables sequentially, one SQL query per table, then recurses for nested StructuredText inside blocks. This creates a cascade of sequential SQLite queries proportional to (block types × nesting depth × record count).

### Baseline (local Miniflare, 30 posts with nested blocks)

| Query | Published | Preview | Gap |
|-------|-----------|---------|-----|
| posts_deep_12 | 13ms | 61ms | 4.7x |
| posts_deep_36 | 11ms | 107ms | 9.7x |
| posts_deep_72 | 10ms | 96ms | 9.6x |

The published path proves the data volume is fine — the preview overhead is entirely from the materialization code path.

## Metrics

- **Primary**: total_ms (milliseconds, lower is better) — sum of median durations across all 10 queries in the scale suite
- **Secondary**: preview_deep_ms (sum of preview deep query medians), sql_statements (total SQL statement count)

## How to Run

`./autoresearch.sh` — starts local wrangler if needed, seeds, runs benchmarks, outputs `METRIC` lines.

**Important**: after changing source files, run `npm run build` before the benchmark. The wrangler dev server uses the built output, not raw TypeScript. The `autoresearch.checks.sh` script runs `npm run build` as part of its checks.

## The Code Path (read these files before making changes)

### `src/services/structured-text-service.ts` — Core bottleneck

`materializeStructuredTextValue()` (line 467):
1. Parses DAST document, extracts referenced block IDs
2. Calls `fetchBlockModelsCached()` — SQL query for block model list (cached per materializeContext)
3. **Sequential loop** over candidate block model tables (line 499): one `SELECT * FROM "block_<model>" WHERE ... AND id IN (...)` per block type
4. For each found block, calls `materializeBlockPayload()` (line 436) which inspects each field
5. If a block field is `structured_text`, **recurses** back to `materializeStructuredTextValue()` (line 449)

This recursion × sequential loop is why preview scales poorly. With 3 block types, 12 posts with 3-level nesting, that's potentially 3×12×3 = 108+ sequential queries.

### `src/graphql/structured-text-loader.ts` — Batch loader

`scheduleFlush()` (line 85) collects pending materialization requests via `queueMicrotask`, then processes them in one Effect.gen. But inside the generator (line 97-101), it still calls `materializeStructuredTextValue()` **sequentially per pending entry**. The batching reduces request-level N+1, but doesn't batch the SQL within materializations.

### `src/graphql/structured-text-resolver.ts` — Entry point

`resolveStructuredTextValue()` (line 163): checks if an envelope exists, otherwise calls `materializeStructuredTextEnvelope()`. The fallback path (line 236-263) also has the sequential block model loop.

### `src/graphql/content-resolvers.ts` — Content model field resolvers

Resolves all field types on content records: scalar fields, link fields, asset fields, StructuredText. Each link or asset field triggers SQL lookups. The `runSql` helper bridges Effect to async.

### `src/graphql/block-resolvers.ts` — Block model field resolvers

Same as content resolvers but for block records inside StructuredText. Resolves nested links, assets, and recursive StructuredText within blocks.

### `src/graphql/linked-record-loader.ts` — Link field batch loader

Request-scoped microbatch loader for link fields (author, category, etc.). Already batches `IN (...)` queries — was a big win in prior rounds. May still have room for improvement in how batches are scheduled or how many round-trips happen.

## Architecture invariants (don't break these)

- Published mode reads `_published_snapshot` JSON on the record. Don't touch this path.
- Block tables are named `block_<model_api_key>`, one table per block type.
- Block rows have ancestry columns: `_root_record_id`, `_root_field_api_key`, `_parent_container_model_api_key`, `_parent_field_api_key`, `_parent_block_id`.
- The DAST document references block IDs. The resolver fetches only those IDs.
- Block model schemas (field definitions) are fetched from the `fields` table and cached per `materializeContext`.
- GraphQL responses must be identical — same data, same shape.
- All code uses Effect patterns: `Effect.gen`, `SqlClient.SqlClient`, tagged errors.

## Optimization directions

**Set-oriented block fetching**: Instead of querying each block table per-root-per-field, collect ALL block IDs across ALL pending roots, then query each block table ONCE with a wider `IN (...)` clause. Turns N×M queries into M queries.

**Flatten recursive materialization**: Instead of depth-first recursion (materialize block → find nested ST → recurse → query more blocks), collect all block IDs at all depths first in one pass over the DAST, then fetch everything, then assemble.

**Parallelize independent queries**: Queries to different `block_<model>` tables are independent. Could use `Promise.all` or D1's `batch()` API.

**Wider batch in the loader flush**: The `scheduleFlush` in `structured-text-loader.ts` could merge SQL across all pending materializations instead of running them sequentially.

## Constraints

- Tests must pass: `npx vitest run`
- TypeScript must compile: `npx tsc --noEmit`
- Build must succeed: `npm run build`
- No `as` casts, no `any` types
- Effect patterns only (consult `~/Forks/effect-solutions/` before writing Effect code)
- Published query performance must not regress
- No new npm dependencies
- GraphQL API must return identical responses

## What's Been Tried

### Prior rounds (2026-03-16)
1. Block ancestry indexes — composite index on lookup columns
2. Schema/handler caching — eliminated per-request schema rebuild
3. Block whitelist + metadata caching — fewer tables scanned
4. Linked record microbatch loader — batched author/category fetches (161 → 3 SQL calls)
5. StructuredText envelope batch loader — batched per-record materializations (39 → 4 SQL calls)

Current state: SQL statement count is near-flat per request, but each materialization still iterates block tables sequentially with recursive nesting.
