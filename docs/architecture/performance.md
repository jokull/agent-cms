# Performance

This document explains how GraphQL requests turn into SQL in this codebase, what performance properties the current design has, and where the main tradeoffs are.

It is not a claim that arbitrary GraphQL automatically compiles to optimal SQL. The system is fast on the paths we have designed and measured, and predictable where we have added batching, indexing, and materialization.

## Summary

Current behavior:

- published reads are usually cheap
- draft and preview reads are more expensive
- link-heavy list queries are now batched
- deep StructuredText preview queries are now batched per request, but still scale with total block volume

What changed recently:

- block ancestry lookups are indexed
- common content filter and order fields are indexed
- linked record resolution is request-batched
- preview StructuredText envelope materialization is request-batched
- schema/bootstrap overhead is cached instead of rebuilt every request
- system-table setup moved to an explicit setup step instead of the read path

The result is that many previously multiplicative resolver patterns now behave roughly linearly in the amount of returned data.

## Architecture

At a high level, a GraphQL request flows through these layers:

1. GraphQL Yoga parses and validates the request.
2. The schema builder provides field resolvers for content models, block models, assets, reverse refs, and query roots.
3. Query resolvers fetch top-level records from `content_<model>` tables.
4. Field resolvers fetch linked records, assets, and StructuredText payloads.
5. StructuredText resolution may fetch block rows from `block_<model>` tables or read pre-materialized published snapshots.

Relevant files:

- [`src/graphql/handler.ts`](/Users/jokull/Code/agent-cms/src/graphql/handler.ts)
- [`src/graphql/schema-builder.ts`](/Users/jokull/Code/agent-cms/src/graphql/schema-builder.ts)
- [`src/graphql/query-resolvers.ts`](/Users/jokull/Code/agent-cms/src/graphql/query-resolvers.ts)
- [`src/graphql/content-resolvers.ts`](/Users/jokull/Code/agent-cms/src/graphql/content-resolvers.ts)
- [`src/graphql/block-resolvers.ts`](/Users/jokull/Code/agent-cms/src/graphql/block-resolvers.ts)
- [`src/graphql/structured-text-resolver.ts`](/Users/jokull/Code/agent-cms/src/graphql/structured-text-resolver.ts)
- [`src/services/structured-text-service.ts`](/Users/jokull/Code/agent-cms/src/services/structured-text-service.ts)
- [`src/http/router.ts`](/Users/jokull/Code/agent-cms/src/http/router.ts)
- [`src/index.ts`](/Users/jokull/Code/agent-cms/src/index.ts)

## Runtime Boundary

The runtime now has three phases:

1. explicit setup
2. first schema initialization in a fresh isolate
3. warm read-path execution

That boundary is intentional.

System tables are created explicitly through `POST /api/setup` or a setup script that calls it. Normal reads should not discover or create system tables. After setup:

- reads stay read-only
- the Worker caches the handler and GraphQL schema at module scope
- the warm path is just GraphQL execution plus D1 access

A one-time setup command is a better DX tradeoff than hiding bootstrap work inside the first user request.

## Mental Model

The key idea is that GraphQL nesting is mostly an execution model, not a SQL model.

A query like:

```graphql
query {
  allPosts {
    title
    author { name }
    category { name }
    content {
      blocks {
        ... on FeatureGridRecord {
          features {
            blocks {
              ... on FeatureCardRecord {
                details {
                  blocks {
                    ... on CodeBlockRecord { code }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

looks like one deeply nested query, but the server does not need to turn it into one giant SQL statement. In practice, this codebase treats GraphQL as:

1. a description of the response shape
2. a set of resolver fetch tasks
3. a plan for batching those tasks into simple SQL set lookups
4. an in-memory assembly step that rebuilds the nested JSON response

So the architecture is not:

- GraphQL tree -> one SQL tree

It is:

- GraphQL tree -> resolver work
- resolver work -> batched SQL sets
- SQL results -> assembled GraphQL tree

That is why batching matters so much. GraphQL makes it very easy to express N+1 behavior. SQLite makes it cheap to do set-oriented batched lookups like `IN (...)`, so the right compromise is usually many small, batched queries, not one huge join.

## Why Not One Giant Join

SQL absolutely can represent nesting, but not in the same way GraphQL does.

For simple relations, joins are a natural fit. For example:

- post -> author
- post -> category

But a real GraphQL query in this system mixes several different shapes:

- normal links
- lists of records
- StructuredText values
- unions across different block tables
- nested StructuredText inside blocks

Trying to flatten that into one joined SQL statement has real downsides:

- rows explode because parent data repeats for every child row
- unions across block types become awkward
- nested blocks recurse in a way that does not map cleanly to flat joins
- rebuilding the exact GraphQL shape from one huge rowset is expensive and messy

So this codebase prefers:

- one root query for top-level rows
- batched link fetches
- batched StructuredText materialization
- in-memory reconstruction of the nested response

This keeps SQL simple and indexable while still serving a nested GraphQL API.

## Service Binding vs D1

These are different latency domains.

### Worker-to-worker service binding

Service bindings are effectively internal calls. In our measurements, warm site requests track CMS internal timings closely, which is what you would expect if the binding overhead is negligible.

### D1

D1 uses SQLite semantics, but deployed D1 is not the same as opening a local SQLite file in-process.

The practical model is:

- local SQLite / local Miniflare: close to raw SQLite planner and index behavior
- deployed D1 binding: the fastest and correct production integration, but still a managed database service with real end-to-end request latency

So the answer to "is D1 basically SQLite query time?" is:

- locally: close enough for query-plan and index work
- deployed: no

Deployed D1 cost is better thought of as:

- SQL execution time
- plus service/request overhead
- plus cold/first-touch variance

That is why local SQLite measurements are useful for query-shape work, but real Workers + D1 measurements are still necessary.

## GraphQL To SQL

### Top-level record queries

A root query like:

```graphql
query {
  allPosts(first: 20, orderBy: [publishedDate_DESC]) {
    id
    title
    slug
  }
}
```

typically becomes one top-level SQL query against a content table, for example:

```sql
SELECT * FROM "content_post"
WHERE "_status" IN ('published', 'updated')
ORDER BY "published_date" DESC
LIMIT ?
OFFSET ?
```

Additional root metadata queries, such as `_allPostsMeta { count }`, add another SQL statement.

For a typical list query, the server then looks at which nested fields were selected and schedules follow-up batched fetches rather than joining everything into the root query.

### Link fields

A field like `author` or `category` used to resolve one record at a time, which created classic N+1 behavior in list queries.

Now, per request, link resolution is microbatched. Many sibling field resolutions are collapsed into one batched fetch per target model set:

```sql
SELECT * FROM "content_author" WHERE id IN (?, ?, ...)
SELECT * FROM "content_category" WHERE id IN (?, ?, ...)
```

That change is what made wide published list queries effectively flat in SQL statement count.

Relevant file:

- [`src/graphql/linked-record-loader.ts`](/Users/jokull/Code/agent-cms/src/graphql/linked-record-loader.ts)

### StructuredText fields

StructuredText is the most important performance-sensitive part of the system.

This is where the GraphQL-vs-SQL mismatch is most obvious. StructuredText is not one normal relation. It is:

- one DAST document stored on the parent
- block ids referenced from that document
- block payloads stored in relational block tables
- possibly more StructuredText fields nested inside those blocks

That is why StructuredText is handled as a materialization step rather than a SQL join problem.

There are two distinct modes.

#### Published mode

Published records store a materialized StructuredText envelope in `_published_snapshot`. That means GraphQL can often resolve blocks from a prebuilt JSON structure instead of querying block tables recursively at read time.

This is why published deep queries are relatively cheap.

Relevant file:

- [`src/services/publish-service.ts`](/Users/jokull/Code/agent-cms/src/services/publish-service.ts)

#### Draft and preview mode

Draft and preview reads work from the live relational block tables. A StructuredText field is resolved from:

- the raw DAST value stored on the parent record or block
- block rows under the current container and field
- recursively nested StructuredText inside child blocks

The core block lookup shape is:

```sql
SELECT * FROM "block_<block_model>"
WHERE _root_record_id = ?
  AND _root_field_api_key = ?
  AND _parent_container_model_api_key = ?
  AND _parent_field_api_key = ?
  AND _parent_block_id IS NULL | = ?
  AND id IN (?, ?, ...)
```

The important detail is `id IN (...)`. The resolver no longer fetches every block row for a container and filters later; it narrows to the block ids actually referenced by the current DAST fragment.

The practical sequence is:

1. parse the DAST value
2. collect referenced block ids
3. fetch the matching block rows from the relevant block tables
4. recursively materialize nested StructuredText inside those blocks
5. assemble the final GraphQL field payload in memory

Relevant files:

- [`src/graphql/structured-text-loader.ts`](/Users/jokull/Code/agent-cms/src/graphql/structured-text-loader.ts)
- [`src/services/structured-text-service.ts`](/Users/jokull/Code/agent-cms/src/services/structured-text-service.ts)

## Indexing Strategy

### Block tables

Every block table gets a composite lookup index on the ancestry columns used by StructuredText resolution:

```sql
(_root_record_id,
 _root_field_api_key,
 _parent_container_model_api_key,
 _parent_field_api_key,
 _parent_block_id)
```

Without this, preview StructuredText resolution degenerates into repeated scans across block tables.

### Content tables

Content tables get indexes for common read patterns:

- `slug`
- `link`
- `date`
- `date_time`
- `integer`

They also get composite indexes for `link + date/date_time` pairs to support queries like:

```graphql
allPosts(filter: { category: { eq: $id } }, orderBy: [publishedDate_DESC])
```

which maps well to:

```sql
WHERE category = ?
ORDER BY published_date DESC
```

Relevant file:

- [`src/schema-engine/sql-ddl.ts`](/Users/jokull/Code/agent-cms/src/schema-engine/sql-ddl.ts)

## What Is Fast

Usually fast:

- published list queries
- published deep StructuredText queries
- single-record lookups by indexed fields such as `slug`
- filtered lists aligned with indexed predicates and sort order

Fast because:

- published StructuredText is pre-materialized
- link resolution is batched
- top-level queries hit indexed content tables
- GraphQL schema work is cached
- setup/bootstrap is explicit and kept off the read path

## What Is Expensive

Still relatively expensive:

- preview list queries with deep StructuredText
- queries that return a lot of block payload
- query shapes that request many large JSON/text fields

Expensive because:

- preview must reconstruct StructuredText from relational block rows
- nested block payloads still need to be materialized
- total work scales with returned content volume, even when statement count is low

This is no longer primarily an N+1 statement-count problem. It is mostly a total-data-and-materialization-cost problem.

## Complexity Model

The current system does not expose a formal complexity score that accurately predicts SQL cost for arbitrary queries.

What we can say from measurement:

- published paths are close to flat in SQL statement count
- preview deep paths are now also close to flat in SQL statement count
- preview deep paths still scale roughly linearly with total StructuredText volume

So the dominant complexity drivers are now:

1. number of top-level records returned
2. number of linked records selected
3. total StructuredText block payload selected
4. whether the request is published or preview

What we did not observe in the measured paths:

- exponential SQL statement growth

What we still have not proven:

- a global upper bound for arbitrary GraphQL depth and breadth combinations

So the honest claim is not "GraphQL becomes optimal SQL automatically." The honest claim is:

- the common query families in this codebase are engineered to batch well
- the resulting SQL is simple and index-friendly
- the measured cost curve is much more predictable than naive resolver recursion
- preview StructuredText still scales with content volume because some work is fundamentally materialization work, not just lookup work

## Guardrails

The GraphQL handler currently enforces simple query limits:

- max depth
- max selection count

This is a coarse guardrail, not a precise cost model.

Relevant file:

- [`src/graphql/query-limits.ts`](/Users/jokull/Code/agent-cms/src/graphql/query-limits.ts)

## Tradeoffs

### Pre-materialized published snapshots

Pros:

- very fast published reads
- avoids recursive block-table traversal at read time

Cons:

- publish path does more work
- storage overhead increases
- read behavior differs between published and preview modes

### Request-scoped batching

Pros:

- removes classic GraphQL N+1 behavior
- makes SQL statement count predictable for common query families
- lets SQLite do what it is good at: indexed set lookups such as `IN (...)`

Cons:

- more complexity in resolver infrastructure
- batching helps statement count more than raw payload size

### Relational block storage

Pros:

- draft editing model is normalized and explicit
- nested blocks can be addressed and validated structurally

Cons:

- preview reads are more expensive than reading a single JSON blob
- recursive materialization still costs real time as content volume grows

This is the central tradeoff in the architecture. Normalized relational block storage is excellent for validation, schema awareness, and draft editing. It is not as cheap to read as a fully precomputed JSON document. Published snapshots exist to bridge that gap for the delivery path.

### Automatic indexing

Pros:

- common query shapes perform well without manual tuning each time
- reduces full scans and temp B-trees

Cons:

- more indexes increase write cost
- generic indexing can still miss workload-specific combinations

## Measured Plateau

On the current local Miniflare-backed D1 benchmark fixture:

- published list and deep queries are close to flat in top-level SQL call count
- preview deep queries were reduced from many per-record operations to one batched materialization pass
- remaining preview cost grows roughly linearly with the amount of StructuredText returned

Iteration notes and benchmark files are recorded in:

- [`benchmarks/iterations-2026-03-16.md`](/Users/jokull/Code/agent-cms/benchmarks/iterations-2026-03-16.md)

## Preview Optimization Results (2026-03-20)

An automated autoresearch loop ran 57 experiments against the blog benchmark suite (30 posts, nested StructuredText with 3-level block nesting). Results on a sum-of-medians metric across 10 queries (published + preview, multiple scales):

**325ms → 197.8ms (39% reduction)**

Key wins:

1. **Batched ancestry-group materialization** — one loader flush fetches block rows across all pending roots together instead of materializing each request sequentially (325→220ms)
2. **AST-driven link prefetch** — root query resolvers walk the GraphQL selection set and inline linked record rows via SQLite JSON subqueries, so link field resolvers return prefetched data (→216ms)
3. **AST-driven StructuredText bulk pre-materialization** — root query resolvers batch one `materializeStructuredTextValues()` call across all result records, caching ready envelopes so child resolvers skip per-record materialization (→212ms)
4. **Direct D1 hot path** — the innermost block fetch loop uses `prepare().bind().all()` directly, bypassing the Effect SQL wrapper overhead (→208ms)
5. **Cached block model whitelists** — block model schema's structured_text field whitelists are cached per materialization context (→207ms)
6. **Flat AST scan for prefetch** — cheaper selected-field-name scan replaces full nested selection-map construction (→200ms)
7. **Eager payload resolution** — prefetch resolves final `{ value, blocks, inlineBlocks, links }` payloads once per record so content field resolvers return cached objects (→197.8ms)

Explored and discarded (47 experiments):

- Concurrent Effect.forEach for block table queries — D1 contention regressed
- D1 batch() API — unstable, regressed when type checks passed
- Breadth-first iterative materialization — bookkeeping overhead regressed
- Extending direct-D1 beyond the hot block fetch loop — always regressed
- Module-level prepared statement reuse — D1's own cache is better
- Various caching strategies (WeakMap validators, null-prototype objects, precomputed whitelists) — all regressed
- LEFT JOIN-based JSON projection for links — broke on self-referential cases

**Key insight**: The remaining preview bottleneck is not individual query cost — it's the number of sequential resolver round-trips. Further micro-optimization yields diminishing returns. The next win requires either (a) full SQLite JSON compilation that bypasses the resolver layer, or (b) accepting that preview materialization scales linearly with content volume by design.

## What To Optimize Next

The published read path is the primary delivery path for end users. Published queries currently take ~8-13ms locally (55ms+ on deployed Workers), even though the SQL is trivial — one root query, one batched link fetch, and a pre-materialized snapshot read.

The overhead is in the GraphQL execution pipeline: Yoga parse/validate/execute, resolver-per-field dispatch, Effect runtime, DataLoader scheduling.

The next optimization target is **published read latency**, potentially via:

- **SQLite JSON compilation**: compile GraphQL queries into single SQL statements with correlated subqueries and `json_group_array()`, bypassing the resolver layer entirely. This is the approach used by Drizzle ORM's relational query system and Hasura's query engine.
- **Handler overhead reduction**: eliminate double query parsing, skip schema cache Effect.runPromise calls, short-circuit auth for unauthenticated reads.
