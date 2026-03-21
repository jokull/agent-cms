# STILL_SLOW.md

Tracking queries and query shapes that are still likely to be surprisingly slow when they miss the published fast path.

This file is about practical performance risk, not just unsupported features in the abstract.

## Why This Matters

The published fast path is now dramatically faster for supported page queries.

That means the worst user experience is no longer "all queries are kind of slow".
It is:

- one query on a page misses the published fast path
- the request falls into Yoga/resolver execution
- the response becomes much slower than expected
- because there is no streaming response, the whole page waits

The main optimization strategy from here should be:

1. Find "almost fast-path" queries.
2. Identify the one missing feature that ejects them.
3. Either compile that feature into the published path, or support partial lowering so one unsupported leaf does not poison the whole root.

## Current High-Level Status

Recently completed:

- published StructuredText support, including nested typed blocks
- `lat_lon` support
- per-root fallback in `execute()`
- global asset batching across fast-path roots
- one root SQL statement for multi-root published requests
- whole-request dependency collection for recursive roots
- published list/meta filter compilation for common scalar operators and logical `AND`/`OR`
- per-root fallback reasons in `_trace` for common misses like unsupported filters and `responsiveImage`
- localized published projection with `locale` / `fallbackLocales` for common fast-path query shapes
- `responsiveImage` leaf projection on the published fast path

Still incomplete:

- narrower recursive root projections and fewer snapshot decodes
- deeper polymorphic linked-record batching
- leaf-level fallback inside otherwise compiled roots
- wider published filter support beyond the common subset
- deeper and more authoritative trace visibility for every compile miss

## Classes Of Surprisingly Slow Queries

### 1. Filtered Deep Published Lists

Example:

```graphql
query SlowPublishedPage {
  allGuides(filter: { price: { gt: 20 } }, orderBy: [price_DESC]) {
    id
    title
    price
    content {
      value
      blocks {
        __typename
        ... on SectionRecord {
          title
          venues {
            value
            blocks {
              __typename
              ... on VenueRecord {
                name
                image { id url alt width height }
                location { latitude longitude }
              }
            }
          }
        }
      }
    }
  }
}
```

Why it is risky:

- looks very close to a supported fast-path query
- the expensive part is already publish-fast-pathable
- a missing list filter shape can eject the entire root

Suggested improvement:

- compile a broader published filter subset for list/meta roots
- prioritize `eq`, `neq`, `in`, `exists`, simple `AND`
- treat `meta` and `list` filter compilation as one family

### 2. One Unsupported Leaf Poisons A Large Root

Example:

```graphql
query SlowBecauseOfOneField {
  allGuides {
    id
    title
    content {
      blocks {
        ... on VenueRecord {
          image {
            responsiveImage { src }
          }
        }
      }
    }
  }
}
```

Why it is risky:

- the query is almost entirely supported
- one nested resolver-only field can eject the whole root
- this is exactly the kind of thing a frontend team adds casually

Status:

- Partly mitigated.
- `responsiveImage` is now handled on the published fast path instead of ejecting the whole root.
- The larger architectural problem remains for other unsupported nested leafs.

Suggested improvement:

- introduce generalized leaf fallback inside compiled roots
- keep root fetch and most projection compiled
- delegate only the unsupported leaf or subtree to resolver-style completion

### 3. Polymorphic StructuredText Links Hidden Inside Content

Example:

```graphql
query SlowPolymorphicContent {
  allArticles {
    body {
      value
      links {
        id
        __typename
      }
      blocks {
        ... on RelatedContentRecord {
          items {
            id
            title
          }
        }
      }
    }
  }
}
```

Why it is risky:

- looks like "just content"
- actually needs polymorphic linked-record loading in multiple places
- easy to end up with extra hops or a fallback

Suggested improvement:

- stronger whole-request linked-record dependency graph
- better polymorphic batching by target table
- consider union-all or grouped side fetches

### 4. Meta + Deep List Pages

Example:

```graphql
query SlowListAndMeta {
  _allGuidesMeta(filter: { price: { gt: 20 } }) {
    count
  }
  allGuides(filter: { price: { gt: 20 } }) {
    id
    title
    content { value }
  }
}
```

Why it is risky:

- very common page shape
- count and list often share the same unsupported filter
- if the filter misses the fast path, both roots become expensive together

Suggested improvement:

- compile the filter once
- lower into both `meta` and `list`
- keep them in the same request-level plan

### 5. Reverse Reference Queries

Example:

```graphql
query SlowReverseRefs {
  venue(filter: { slug: { eq: "grillid" } }) {
    name
    _allReferencingGuides {
      id
      title
    }
  }
}
```

Why it is risky:

- reverse references are page-critical in many CMS-driven apps
- they are easy to leave in resolver land
- they can become expensive even when the rest of the page is publish-fast-pathable

Suggested improvement:

- add reverse-reference support to the published planner
- start with incoming single-target `link`/`links` cases

### 6. Localized Published Queries

Example:

```graphql
query SlowLocalized {
  allGuides(locale: en) {
    title
    content { value }
  }
}
```

Why it is risky:

- the data is published and present
- locale-aware extraction often falls back if not explicitly modeled in the compiler

Status:

- Partly done.
- Common localized published queries now stay on the fast path with `locale` / `fallbackLocales`.
- Remaining work is the long tail: broader localized field categories, more localized filter shapes, and deeper localized nested content.

Suggested improvement:

- continue explicit locale-aware lowering in the published compiler
- expand beyond the common localized scalar/query cases

## Query Shapes To Watch In Production

These are the most dangerous query patterns because they feel normal to product/frontend teams:

- deep list query plus one unsupported filter operator
- published page with one tiny unsupported media field
- page with count + list using the same unsupported filter
- query that mixes otherwise supported roots with one unsupported root
- deep StructuredText plus polymorphic links
- reverse-reference pages

These are the queries most likely to create "why is this one page suddenly slow?" incidents.

## Recommended Next Optimizations

### Priority 1. Broader Published Filter Compilation

Target:

- list roots
- meta roots
- high-value operators only

Reason:

- this removes a large class of page-level fallbacks
- filtered lists are among the most common real-world queries

Status:

- Partly done.
- Common scalar operators and logical `AND`/`OR` are now supported on the published path for list/meta roots.
- Remaining work is the long tail: localized filters, more exotic operators, and any shapes that still need fallback.

### Priority 2. Trace Fallback Reasons

Current trace tells us path shape, but not enough about why a root fell back.

Add per-root fallback reasons such as:

- `list_filter_neq`
- `list_filter_and`
- `field_responsiveImage`
- `reverse_ref`
- `localized_arg`
- `unsupported_directive`

This should be exposed in `_trace` so production pages can be diagnosed quickly.

Status:

- Partly done.
- `_trace` now carries per-root fallback reasons for common misses.
- Remaining work is to make the reasons more exhaustive and more directly tied to the actual compiler failure point instead of heuristics.

### Priority 3. Reverse-Reference Support

These are likely to be costly and common enough to justify first-class compilation support.

### Priority 4. Leaf Fallback Inside Compiled Roots

This is the biggest architectural step still missing.

Target execution modes per root or subtree:

- `sql_json`
- `sql_rows_plus_js_projection`
- `resolver_leafs`
- `yoga_full`

The key goal is to stop one unsupported nested field from poisoning an otherwise compilable root.

### Priority 5. Narrower Recursive Projections

Current recursive roots are improved, but still not ideal.

Further wins:

- fetch fewer columns
- avoid unnecessary snapshot decodes
- reuse parsed JSON more aggressively
- precompile field accessors for block projection

Notes:

- Multi-root recursive queries now fetch much less than the old `SELECT *` shape by carrying `{ id, _published_snapshot }` payloads through the wrapper query.
- That is a meaningful improvement, but not the end state.
- We still decode entire snapshots for recursive roots even when only a small subset of fields is needed.

### Priority 6. Better Polymorphic Linked-Record Lowering

Current behavior is improved, but not finished.

Focus areas:

- better grouping by target model
- fewer side fetches
- better shared dependency planning across roots

## Newly Confirmed Wins

- `rvkfoodie` homepage is fully on the published fast path.
- The live query dropped from `5` SQL statements to `2`:
  - `root = 1`
  - `asset = 1`
- This confirms that request-level root recombination and global asset batching are materially helping real traffic.

## Current Plateau

The easy structural wins are mostly gone.

What remains is more expensive work:

- keeping compiled roots alive when one leaf is unsupported
- compiling more of the remaining filter surface
- improving polymorphic linked-record loading
- reducing snapshot decoding overhead inside recursive projection

Those are still worth doing, but they are no longer small tactical fixes.

## Longer-Term Internal Rethinks

### Unified Query IR

Separate:

- GraphQL shape compilation
- capability analysis
- execution lowering

Do not bind compiler capability too tightly to the current executor shape.

One normalized IR should support multiple lowerers:

- pure SQL JSON
- SQL rows + JS projection
- resolver bridge
- full Yoga

### Dependency Graph As A First-Class Planning Output

The plan should know:

- referenced models
- link target buckets
- asset requirements
- reverse-ref requirements
- locale requirements
- unsupported leafs

This makes whole-request batching much easier and makes partial lowering realistic.

### Published Dependency Index

For future correctness and speed:

- incoming `link`
- incoming `links`
- StructuredText `links`
- maybe asset refs

This could support:

- ancestor invalidation on delete/unpublish
- targeted republish or cleanup jobs
- faster prefetch planning

## Practical Heuristic

When deciding what to optimize next, prefer:

- a query that is already common on real pages
- a query that is almost fast-pathable
- a query where one missing feature causes a large slowdown

Avoid over-prioritizing rare exotic GraphQL features before fixing these near-miss cases.
