# Autoresearch: Published Read Latency

## Objective

Minimize wall-clock time for published (non-draft) GraphQL queries. These are the queries real users hit on every page load. Published reads have simple SQL needs — the data is already pre-materialized — but the current GraphQL execution pipeline adds significant overhead.

Current published query times on local Miniflare: **8-13ms per query**. On deployed Workers (co-located with D1): **55-60ms per trivial query, 100-300ms for deep queries**.

Target: **3-5ms per query locally**, which would translate to ~15-25ms on deployed Workers.

## Metrics

- **Primary**: total_ms (milliseconds, lower is better) — sum of median durations across all queries in the published benchmark suite
- **Secondary**: sql_statements (total SQL statement count)

## How to Run

`./autoresearch.sh` — builds, starts wrangler if needed, seeds, runs published-only benchmarks, outputs `METRIC` lines.

## Why Published Reads Are Special

Published records store a `_published_snapshot` column containing the full pre-materialized StructuredText envelope as JSON. This means:

- **No block table traversal** — the nested block structure is already in the snapshot
- **No recursive materialization** — blocks, inline blocks, links are pre-resolved
- **Simple SQL** — one `SELECT` for root rows, one `IN (...)` for linked records, done

The overhead is NOT in the database. It's in the layers between the SQL result and the HTTP response:

1. **GraphQL Yoga** — parse query, validate, build execution plan, resolve field-by-field
2. **Resolver dispatch** — one function call per field per record, even for trivial reads
3. **Effect runtime** — `Effect.runPromise()` for schema cache lookup
4. **DataLoader scheduling** — microtask-based batching for link fields (queueMicrotask overhead)
5. **Response assembly** — building the nested JSON response from flat resolver results

## The Benchmark Suite

10 published-only queries testing realistic patterns:

- `singleton_minimal` — site settings, 2 fields (pure overhead floor)
- `singleton_with_seo` — site settings with nested SEO object
- `list_summary_12/40` — post listings with linked author/category (homepage-style)
- `list_deep_12/36` — posts with full nested StructuredText blocks (article pages)
- `single_by_slug` — single post lookup by slug with deep content
- `filter_by_category` — filtered list + meta count (category page)
- `page_simulation` — multi-root query: site settings + posts + categories + meta (full page)
- `meta_count` — just record counts (absolute minimum query)

## The Code Path

### `src/graphql/handler.ts` — Entry point

`handle()`:
- Line 178: `getSchemaTiming()` — 2x `Effect.runPromise()` per request for schema cache hit check
- Line 117: `schema` function called by Yoga — another `getSchema()` → `Effect.runPromise()`
- Lines 120-128: `enforceQueryLimits()` plugin — `parse(query)` before Yoga's own parse (double parse)
- Lines 160-231: wraps everything in `withSqlMetrics()` AsyncLocalStorage context

`execute()` (in-process path, used by rvkfoodie):
- Lines 233-254: `getSchema()` → `parse()` → `validate()` → `gqlExecute()` — leaner than HTTP but still runs full resolver tree

### `src/graphql/query-resolvers.ts` — Root resolvers

Fetches top-level records. For published reads, also does AST-driven prefetch of linked records and StructuredText. The prefetch is good but still feeds into the resolver-per-field pattern.

### `src/graphql/content-resolvers.ts` — Field resolvers

One resolver function per field per record. For published reads, StructuredText resolvers read from `_published_snapshot` (fast), link resolvers read from the prefetched cache or DataLoader (fast). But the overhead is the resolver dispatch itself × (fields × records).

### `src/graphql/schema-builder.ts` — Schema construction

Builds GraphQL SDL and resolvers from CMS metadata. Cached after first build. The schema is correct but generates one resolver per field — no query compilation.

### `src/http/router.ts` — Request routing

Lines 855-867: runs `getCredentialType()` on every `/graphql` request even without auth header.
Lines 777-781: clones request with new headers.
Lines 962-998: lazy-loads GraphQL module, routes to Yoga.

## Architecture invariants

- Published records have `_published_snapshot` with pre-materialized StructuredText
- Block tables (`block_<model>`) are NOT queried for published reads
- GraphQL responses must be byte-identical — same data, same shape
- All code uses Effect patterns
- The `execute()` method (in-process) must also benefit from optimizations

## Optimization Directions

### Primary: SQLite JSON compilation (Drizzle-style)

Compile GraphQL queries into single SQL statements that return nested JSON directly. Bypass the resolver layer entirely for published reads.

**How it works** (proven by Drizzle ORM, Hasura, PostGraphile):
- Walk the GraphQL AST + CMS schema metadata
- For each selected field: add column to SELECT
- For each link field: add correlated subquery `(SELECT json_array(col1, col2) FROM content_<target> WHERE id = parent.link_col)`
- For StructuredText: read `_published_snapshot` column directly
- For lists: `json_group_array()` wraps child rows
- Result: one SQL statement → one `JSON.parse()` → done

**Example — list with links:**
```sql
SELECT json_group_array(json_array(
  p.id, p.title, p.slug, p.excerpt, p.published_date,
  (SELECT json_array(a.id, a.name) FROM content_author a WHERE a.id = p.author),
  (SELECT json_array(c.id, c.name, c.slug) FROM content_category c WHERE c.id = p.category)
))
FROM (SELECT * FROM content_post WHERE _status IN ('published','updated') ORDER BY published_date DESC LIMIT 12) p
```

**Example — singleton:**
```sql
SELECT json_array(s.site_name, s.tagline)
FROM content_site_settings s
WHERE _status IN ('published','updated')
LIMIT 1
```

**Where to implement**: New module `src/graphql/query-compiler.ts` that takes `(graphqlQuery, schema, cmsMetadata) → SQL string`. Wire into `handler.ts` or `query-resolvers.ts` as a fast path that short-circuits Yoga's resolver execution when the query can be compiled.

**Reference implementations**:
- Drizzle ORM `buildRelationalQuery()` in `drizzle-orm/src/sqlite-core/dialect.ts`
- Join Monster (github.com/join-monster/join-monster) — AST-to-SQL with batch fetching
- Hasura — compiles GraphQL to single SQL with LATERAL JOINs + JSON aggregation

### Secondary: Handler overhead reduction

- Replace Effect.Cache for schema with a plain JS variable
- Eliminate double query parse (move limit checking into Yoga plugin with pre-parsed AST)
- Skip auth check when no Authorization header
- Skip `getSchemaTiming()` when tracing is off

### Tertiary: execute() fast path

For in-process callers (like rvkfoodie), the HTTP layer is already skipped. But `execute()` still runs full `parse() → validate() → gqlExecute()`. If the query is compiled to SQL, `execute()` could skip all of that and just run the SQL directly.

## Constraints

- Tests must pass: `npx vitest run`
- TypeScript must compile: `npx tsc --noEmit`
- Build must succeed: `npm run build`
- No `as` casts, no `any` types
- Effect patterns (consult `~/Forks/effect-solutions/` before writing Effect code)
- No new npm dependencies
- GraphQL API must return identical responses for identical queries

## What's Been Tried

### Preview optimization (prior session, 57 experiments)

Reduced total suite time from 325ms to 197.8ms via batched materialization, AST-driven prefetch, and direct D1 hot paths. These changes are committed and help both published and preview paths. See `docs/architecture/performance.md` for details.

This session starts fresh, focused exclusively on published read latency.
