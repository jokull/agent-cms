# Benchmark Iterations

Target:

- local Miniflare-backed D1 via `wrangler dev --local`
- local SQLite planner inspection for `EXPLAIN QUERY PLAN`

Primary result files:

- `benchmarks/results/blog-bench-2026-03-16T22-34-26-873Z.json`
- `benchmarks/results/blog-bench-2026-03-16T22-35-33-564Z.json`
- `benchmarks/results/blog-bench-2026-03-16T22-42-06-296Z.json`
- `benchmarks/results/blog-bench-2026-03-16T22-43-04-616Z.json`
- `benchmarks/results/blog-bench-2026-03-16T22-45-52-495Z.json`
- `benchmarks/results/blog-bench-2026-03-16T22-47-11-432Z.json`
- `benchmarks/results/blog-bench-2026-03-16T22-48-16-344Z.json`
- `benchmarks/results/blog-bench-2026-03-16T22-49-41-615Z.json`
- `benchmarks/results/blog-bench-2026-03-16T22-50-15-376Z.json`

## Round 1

Baseline on nested 30-post fixture after initial block lookup indexes:

- `posts_deep_preview`: `74.779ms` median
- `posts_deep_published`: `32.253ms` median

Observation:

- published path already benefits from `_published_snapshot`
- preview path is the real resolver bottleneck

## Round 2

Preview envelope materialization landed, but before deeper tuning:

- `posts_deep_preview`: `78.628ms` median in `22-35-33`

Observation:

- no meaningful win yet
- resolver still doing too much work inside each preview StructuredText resolution

## Round 3

Added request-scoped SQL metrics headers:

- `22-42-06` showed deep preview at `173.754ms` median with `37` top-level `runSql` invocations
- summary query showed `42` invocations

Observation:

- a lot of apparent latency was fixed per-request overhead
- metrics made it obvious list queries still had strong N+1 behavior

## Round 4

Cached GraphQL schema in the handler and memoized the example app handler:

- `posts_filter_category_published`: `39.694ms` -> `19.593ms`
- `post_by_slug_deep_published`: `17.098ms` -> `4.433ms`

Observation:

- benchmark noise from rebuilding schema/handler every request was removed
- this was prerequisite cleanup to measure resolver complexity honestly

## Round 5

Optimized StructuredText materialization internals:

- cached block model metadata during one materialization run
- applied block whitelists recursively
- fetched only referenced block ids

Result in `22-45-52`:

- `posts_deep_preview`: `155.372ms` -> `97.926ms`
- `post_by_slug_deep_preview`: `18.986ms` -> `11.310ms`

Observation:

- preview complexity dropped substantially without changing query shape
- remaining cost was still one preview materialization per record

## Round 6

Added a request-scoped microbatch loader for linked records:

Result on large 246-post fixture in `22-48-16`:

- `posts_summary_80_published`: `118.682ms`, `161` `runSql` calls -> `11.318ms`, `3` `runSql` calls
- `posts_deep_36_published`: `49.203ms`, `73` calls -> `9.251ms`, `3` calls

Observation:

- author/category link N+1 was a major multiplicative cost
- after batching, published list complexity became almost flat with respect to record count

## Round 7

Added a request-scoped StructuredText envelope batch loader for preview list queries:

Result in `22-49-41`:

- `posts_deep_12_preview`: `83.066ms`, `15` calls -> `47.901ms`, `4` calls
- `posts_deep_36_preview`: `216.548ms`, `39` calls -> `136.793ms`, `4` calls

Observation:

- preview list complexity is now dominated by one batched StructuredText pass, not one pass per record

## Round 8

Scale validation on the large fixture in `22-50-15`:

- `posts_deep_12_preview`: `50.658ms`
- `posts_deep_36_preview`: `139.668ms`
- `posts_deep_72_preview`: `239.749ms`

Observation:

- growth is now roughly linear in returned record count
- no sign of exponential resolver blow-up in the tested shapes
- remaining preview cost is mostly proportional to total block payload materialized

## Plateau

Current plateau:

- published queries are near-flat after batching and indexing
- preview deep queries still scale with total StructuredText volume, but now with a flat `runSql` count

Most likely next win, if needed:

- reduce total SQL inside the batched preview materialization itself
- likely by fetching child block rows for many roots in larger set-oriented queries instead of per-root recursive traversal
