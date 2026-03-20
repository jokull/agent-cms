# Autoresearch: GraphQL Resolver Performance

## Objective

Reduce wall-clock time of GraphQL queries by optimizing how resolvers traverse relationships and turn them into SQLite queries. Every GraphQL field that references another record — link fields, StructuredText with blocks, assets, reverse links — becomes one or more SQL lookups. The total query time is dominated by how many of these lookups happen and whether they run sequentially or batched.

### Baseline (local Miniflare, 30 posts with nested blocks)

| Query | Published | Preview | Gap |
|-------|-----------|---------|-----|
| posts_deep_12 | 13ms | 61ms | 4.7x |
| posts_deep_36 | 11ms | 107ms | 9.7x |
| posts_deep_72 | 10ms | 96ms | 9.6x |

The published path proves the data volume is fine — the preview overhead is entirely from the resolver/materialization code path.

## Metrics

- **Primary**: total_ms (milliseconds, lower is better) — sum of median durations across all 10 queries in the scale suite
- **Secondary**: preview_deep_ms (sum of preview deep query medians), sql_statements (total SQL statement count)

## How to Run

`./autoresearch.sh` — starts local wrangler if needed, seeds, runs benchmarks, outputs `METRIC` lines.

**Important**: after changing source files, run `npm run build` before the benchmark. The wrangler dev server uses the built output, not raw TypeScript. The `autoresearch.checks.sh` script runs `npm run build` as part of its checks.

## The Code Path (read these files before making changes)

### `src/services/structured-text-service.ts` — StructuredText materialization

`materializeStructuredTextValues()` — batched materialization. Groups requests by ancestry, collects all block IDs across roots, queries each block table once with wide `IN (...)`, then recurses for nested StructuredText. Uses direct D1 `prepare().bind().all()` for the hot block fetch loop, bypassing Effect SQL wrapper overhead.

### `src/graphql/structured-text-loader.ts` — Batch loader

Request-scoped microbatch loader. Collects pending materialization requests via `queueMicrotask`, flushes them through `materializeStructuredTextValues()` in one call with a shared `materializeContext`.

### `src/graphql/structured-text-resolver.ts` — Entry point

`resolveStructuredTextValue()`: checks if a pre-materialized envelope exists (published path), otherwise calls the loader/materializer (preview path).

### `src/graphql/content-resolvers.ts` and `block-resolvers.ts` — Field resolvers

Resolve all field types on content/block records: scalars, links, assets, StructuredText. Each relationship field triggers SQL lookups via the `runSql` helper.

### `src/graphql/linked-record-loader.ts` — Link field batch loader

Request-scoped microbatch loader for link fields (author, category). Batches `IN (...)` queries.

### `src/graphql/handler.ts` — GraphQL handler

Schema caching, query limit enforcement, Yoga setup. The `execute()` method is used by in-process callers (e.g. rvkfoodie) — no HTTP overhead.

### `src/graphql/schema-builder.ts` — Schema construction

Builds GraphQL SDL and resolvers from CMS model/field metadata. Cached after first build.

## Architecture invariants (don't break these)

- Published mode reads `_published_snapshot` JSON on the record. Don't change snapshot semantics.
- Block tables are named `block_<model_api_key>`, one per block type.
- Block rows have ancestry columns: `_root_record_id`, `_root_field_api_key`, `_parent_container_model_api_key`, `_parent_field_api_key`, `_parent_block_id`.
- The DAST document references block IDs. The resolver fetches only those IDs.
- GraphQL responses must be identical — same data, same shape.
- All code uses Effect patterns: `Effect.gen`, `SqlClient.SqlClient`, tagged errors.
- SQLite is the database (D1 in production, Miniflare locally). No Postgres-only features.

## Optimization directions

### Tier 1: AST-driven prefetch (most promising lateral move)

**Idea**: Before resolvers execute, walk the GraphQL selection set to predict what data will be needed, then prefetch it in bulk. This is what Hasura calls "query decomposition" — but without full GraphQL-to-SQL compilation.

Concretely:
1. After the root query returns N records, inspect the GraphQL AST for selected relationship fields
2. If StructuredText fields are selected, batch-prefetch ALL block rows for ALL N records in one query per block table
3. Seed the existing loader caches so resolvers find cache hits instead of triggering new SQL
4. Same pattern works for link fields — if `author` is selected, prefetch all authors for the batch

This works *with* the existing resolver/loader architecture, not against it. The resolvers still run, they just find warm caches instead of cold ones.

**Where to implement**: In `src/graphql/content-resolvers.ts` or as a Yoga plugin that runs after root query execution. The GraphQL `info` object (passed to every resolver) contains the full selection set — use it to predict child fetches.

**Reference**: Hasura's architecture blog describes this as the key insight — metadata about the data model enables proactive query planning. Join Monster (github.com/join-monster/join-monster) does similar AST walking to generate SQL plans before execution.

### Tier 2: SQLite JSON compilation (Drizzle-style correlated subqueries)

**Idea**: Compile GraphQL queries into a single SQL statement that returns nested JSON directly, using SQLite's `json_group_array()`, `json_array()`, and correlated subqueries. This is exactly what Drizzle ORM does for its relational query system — it generates one SQL statement regardless of nesting depth.

**How Drizzle does it** (study `drizzle-orm/src/sqlite-core/dialect.ts` `buildRelationalQuery()`):
- Each nested relation becomes a correlated subquery: `(SELECT coalesce(json_group_array(json_array(col1, col2, ...)), json_array()) FROM related_table WHERE related_table.fk = parent.id)`
- For many-to-one (link fields): subquery returns one row
- For one-to-many (blocks): subquery wraps in `json_group_array()`
- Recursion: nested relations generate nested correlated subqueries
- Result: one SQL statement, flat result, JSON parsed in JS

**Applied to this CMS — published reads:**
```sql
SELECT p.id, p.title, p.slug,
  (SELECT json_array(a.id, a.name) FROM content_author a WHERE a.id = p.author) as author,
  (SELECT json_array(c.id, c.name, c.slug) FROM content_category c WHERE c.id = p.category) as category,
  p._published_snapshot as content
FROM content_post p ORDER BY p.published_date DESC LIMIT 12
```

**Applied to this CMS — preview reads (the harder case):**
```sql
SELECT p.id, p.title, p.slug, p.content as content_dast,
  (SELECT coalesce(json_group_array(json_array(b.id, b.headline, b.subheadline)), json_array())
   FROM block_hero_section b
   WHERE b._root_record_id = p.id AND b._root_field_api_key = 'content'
     AND b._parent_block_id IS NULL
     AND b.id IN (/* block IDs from DAST */)) as hero_blocks,
  (SELECT coalesce(json_group_array(json_array(b.id, b.language, b.code)), json_array())
   FROM block_code_block b
   WHERE b._root_record_id = p.id AND b._root_field_api_key = 'content'
     AND b._parent_block_id IS NULL) as code_blocks
FROM content_post p ORDER BY p.published_date DESC LIMIT 12
```

This eliminates resolver overhead completely — no Effect.gen, no microtask batching, no sequential loops. The SQL engine does all the work. The resolver just parses the JSON result.

**Where to implement**: Build a query compiler in `src/graphql/` that walks the GraphQL AST + CMS schema metadata to generate SQL. Wire it into the query resolvers as an alternative execution path. Start with published list queries (simplest case, biggest volume), extend to preview.

**Reference**: Study Drizzle's `buildRelationalQuery()` in the SQLite dialect and Join Monster's AST-to-SQL approach. Both prove this pattern works at scale with SQLite.

### Tier 3: Micro-optimizations in current path

- Reduce Effect.runPromise overhead on the handler hot path (schema cache, query parsing)
- Short-circuit auth check when no Authorization header present
- Eliminate double query parse (enforceQueryLimits + Yoga both parse)
- Cache query limit results by query string

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

### Autoresearch segment 1 (40 runs, 325ms → 208ms)

**Kept (4 wins):**
1. Batch ST materialization by ancestry group — one flush fetches across all pending roots (325→220ms)
2. Cache candidate block-model table lists in materialization context (→215ms)
3. Precompute block-id Sets once per parsed request (→210ms)
4. Direct D1 `prepare().bind().all()` for hot block fetch, bypassing Effect SQL wrapper (→208ms)

**Explored and discarded:**
- Concurrent Effect.forEach for block table queries — D1 contention regressed
- Breadth-first iterative materialization — bookkeeping overhead regressed
- D1 batch() API — unstable, regressed when checks passed
- SELECT specific columns instead of * — no measurable win
- Extending direct-D1 beyond hot block fetch loop — always regressed
- Module-level prepared statement reuse — D1's own cache is better
- Various caching (WeakMap validators, null-prototype objects, precomputed whitelists) — all regressed
- Sharing materialization contexts across flushes/fields — regressed

**Key insight from segment 1**: The remaining bottleneck is not individual query cost — it's the number of sequential round-trips. Further micro-optimization of each query yields diminishing returns. The next win requires reducing total round-trips, which means predicting what data resolvers will need *before* they ask for it.

### Prior rounds (2026-03-16)
1. Block ancestry indexes — composite index on lookup columns
2. Schema/handler caching — eliminated per-request schema rebuild
3. Block whitelist + metadata caching — fewer tables scanned
4. Linked record microbatch loader — batched author/category fetches (161 → 3 SQL calls)
5. StructuredText envelope batch loader — batched per-record materializations (39 → 4 SQL calls)
