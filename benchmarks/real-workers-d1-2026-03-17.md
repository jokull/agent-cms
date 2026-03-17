# Real Workers + D1 Measurements

Date: 2026-03-17

Targets:
- CMS: `https://test-cms.solberg.is/graphql`
- Site: `https://test-blog-site.solberg.workers.dev/`

Setup:
- Deployed `examples/blog/cms` and `examples/blog/site` from the current repo state.
- Used `X-Bench-Trace: 1` and `X-Trace-Id` to enable detailed timing headers.
- Measured immediately after deploy to capture cold behavior, then repeated for warm behavior.

## Direct CMS: `AllPosts`

Query:
- `AllPosts(first: 6, skip: 0, orderBy: [publishedDate_DESC])`

Results:

| Hit | TTFB | CMS request | Schema | Cache | Yoga | SQL statements | SQL total |
|---|---:|---:|---:|---|---:|---:|---:|
| 1 | not captured | 976ms | 857ms | miss | 119ms | 4 | 234ms |
| 2 | not captured | 106ms | 0ms | hit | 106ms | 4 | 209ms |
| 3 | not captured | 99ms | 0ms | hit | 99ms | 4 | 194ms |

Takeaway:
- The first hit after deploy is dominated by schema build.
- Once warm, the same request is consistently about `100ms` inside the CMS worker.

## Site Through Service Binding: `/`

The homepage issues two parallel CMS queries:
- `SiteSettings`
- `AllPosts`

Results:

| Hit | TTFB | Total | Site total | CMS query count | CMS fetch total | CMS request total | CMS schema total |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1579ms | 1582ms | 1473ms | 2 | 2850ms | 1711ms | 1516ms |
| 2 | 1515ms | 1518ms | 1273ms | 2 | 1617ms | 875ms | 712ms |
| 3 | 193ms | 195ms | 109ms | 2 | 167ms | 167ms | 0ms |

Takeaway:
- The first homepage hit after deploy is a true cold path and pays for schema work inside CMS.
- The second hit still showed a schema wait/build on one CMS request, which suggests a fresh isolate or an immediately-following cold worker instance.
- By the third hit, the homepage stabilizes at about `190ms` TTFB with no schema cost.

## Warm One-Query Comparison

Target content:
- Post slug: `beyond-keyword-matching`

### Direct CMS: `PostBySlug`

Observed results:

| Hit | TTFB | CMS request | Schema | Cache | Yoga | SQL total |
|---|---:|---:|---:|---|---:|---:|
| 1 | 2686ms | 2634ms | 0ms | hit | 2634ms | 2678ms |
| 2 | 157ms | 97ms | 0ms | hit | 97ms | 146ms |

Notes:
- Hit 1 was a large outlier with no schema rebuild, so the slowness came from request execution / D1 access rather than schema construction.
- Hit 2 returned to the expected warm baseline.

### Site Through Service Binding: `/posts/beyond-keyword-matching`

Observed result:

| TTFB | Total | Site total | CMS query count | CMS fetch total | CMS request total | CMS schema total |
|---:|---:|---:|---:|---:|---:|---:|
| 161ms | 161ms | 96ms | 1 | 96ms | 96ms | 0ms |

Takeaway:
- On the warm path, service binding overhead is effectively negligible.
- The site request time closely matches the CMS internal request time.
- The remaining warm-path cost is in CMS execution / D1, not the worker-to-worker hop.

## Conclusions

1. The schema cache fix worked.
   - Warm direct CMS requests are about `100ms`, not `900ms+`.

2. The cold path has now been split further.
   - Before the latest cold-path work, a first cold `PostBySlug` hit was:
     - TTFB `1632ms`
     - `ensureSchema()` `293ms`
     - GraphQL schema build `726ms`
     - request execution `120ms`
   - After removing index backfill work from schema construction, the same first cold hit became:
     - TTFB `1058ms`
     - `ensureSchema()` `270ms`
     - GraphQL schema build `192ms`
     - request execution `122ms`
   - This cut about `570ms` out of the first cold request on real Workers + D1.

3. Service binding is not the bottleneck.
   - Warm site requests track CMS internal timings closely.

4. Cold starts can still appear on early follow-up requests.
   - The second homepage request still showed schema time, which points to multi-isolate cold behavior rather than per-request schema rebuilding.

5. Detailed timing headers are enough to separate:
   - site overhead
   - CMS request time
   - schema build/wait
   - `ensureSchema()` startup time
   - lazy GraphQL handler import/init
   - SQL statement count and SQL total time

## Repeatability Check: `PostBySlug`

Warm-path probe:
- `25` consecutive `PostBySlug` requests against `https://test-cms.solberg.is/graphql`
- All `25/25` were stable

Range:
- TTFB: `122ms` to `152ms`
- CMS request time: `88ms` to `99ms`
- SQL total: `130ms` to `149ms`
- Schema cache: always `hit`

Conclusion:
- The earlier `2.6s` `PostBySlug` spike is not currently reproducible on the blog fixture.
- It may have been an isolate/D1 outlier, or something more specific to another deployment and schema/data shape.

## New Repeatable Multi-Second Path

After the schema-build improvement, the blog homepage still produced a cold outlier through the site worker:

- `/` via service binding
  - TTFB `3256ms`
  - site total `3199ms`
  - CMS query count `2`
  - CMS schema total `0ms`
  - CMS SQL total `9430ms`

Immediate follow-ups:
- hit 2: TTFB `946ms`, schema total `220ms`
- hit 3: TTFB `209ms`, schema total `0ms`
- hit 4: TTFB `179ms`, schema total `0ms`

Conclusion:
- There is still a repeatable multi-second path, but it is no longer obviously schema-related.
- The remaining repeatable bad path is now a cold execution / D1 behavior on the homepage’s parallel CMS queries.

## Next Questions

- Can `ensureSchema()` be moved entirely off read traffic in deployed environments?
- Are the remaining cold homepage SQL spikes caused by D1 first-touch / replica / prepared statement setup?
- Can per-statement SQL timing be surfaced for traced requests so the multi-second homepage outlier can be broken down query-by-query?
