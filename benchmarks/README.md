# Benchmarks

Primary goal:

- understand how GraphQL query shape maps to resolver and SQL cost
- measure optimizations one iteration at a time

## Local workflow

1. Start the blog example locally:

```bash
cd examples/blog/cms
rm -rf .wrangler/state
npx wrangler dev --local
```

2. Seed it from another shell:

```bash
EXTRA_POST_COUNT=24 CMS_URL=http://127.0.0.1:8787 npx tsx examples/blog/seed.ts
```

3. Run the benchmark suite:

```bash
BENCH_ITERATIONS=7 node scripts/bench-blog.mjs
```

Results are written to `benchmarks/results/`.

## What to compare

- published vs preview (`X-Include-Drafts`)
- shallow list vs deep nested StructuredText queries
- filtered queries vs full scans
- median and p95 latency after each optimization round

## Iteration discipline

- change one thing at a time
- record the before/after result file
- keep notes on why the change should help
- stop when deltas flatten out or move to a different bottleneck
