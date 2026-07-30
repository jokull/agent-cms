# Plan: StructuredText Projection in the Published Fast Path Compiler

## The Gap

The published fast path compiler (`src/graphql/published-fast-path.ts`) compiles simple published queries into single SQL statements, bypassing Yoga entirely. It handles scalars, single-target links, meta counts, filters, and multi-root page queries.

It explicitly **rejects** any query that selects StructuredText content:

```typescript
function isSupportedQueryText(query: string): boolean {
  return !query.includes("...")          // inline fragments (block unions)
    && !query.includes("content")        // structured text fields
    && !query.includes(" blocks ")       // block selections
    ...
}
```

This means the deepest, most expensive published queries — the ones that select nested block content — still fall through to Yoga's resolver tree. These are the `list_deep_12` and `list_deep_36` queries in the benchmark, each taking ~8-10ms through Yoga versus ~3-4ms for compiled queries.

## Why It Matters

The benchmark suite has 10 queries. The compiler handles ~6 of them. The 4 it can't handle (2 deep list queries, 1 single-by-slug with content, plus queries that trigger fragment/filter bailouts) account for roughly **40-50% of the total time**. Compiling them would bring total_ms from ~37ms toward ~20-25ms.

More importantly, in production (rvkfoodie), every real page query selects StructuredText content. The homepage fetches editorials with `content { value blocks { ... } }`. Guide pages fetch guides with deeply nested sections → venues → images. These are the queries real users wait for, and none of them hit the fast path today.

## What the Snapshot Contains

When a record is published, `_published_snapshot` stores the full record with all StructuredText fields replaced by materialized envelopes. For a post with nested blocks:

```json
{
  "title": "Computation at the Periphery",
  "slug": "computation-at-the-periphery",
  "author": "01KM667Z...",
  "content": {
    "value": { "schema": "dast", "document": { "type": "root", "children": [...] } },
    "blocks": {
      "post1-hero": { "_type": "hero_section", "headline": "Edge Computing", "subheadline": "..." },
      "post1-grid": {
        "_type": "feature_grid",
        "heading": "Key Concepts",
        "features": {
          "value": { "schema": "dast", "document": { ... } },
          "blocks": {
            "card1": {
              "_type": "feature_card",
              "title": "Workers",
              "description": "...",
              "details": {
                "value": { ... },
                "blocks": {
                  "code1": { "_type": "code_block", "language": "typescript", "code": "..." }
                }
              }
            }
          }
        }
      },
      "post1-lead-code": { "_type": "code_block", "language": "yaml", "code": "..." }
    }
  }
}
```

**Everything is already there.** The block tree, nested StructuredText envelopes, all field values at every depth — materialized at publish time. No SQL joins or block table lookups needed.

## The Problem: GraphQL Fragment Projection

The snapshot has ALL the data, but the GraphQL query asks for SPECIFIC fields at SPECIFIC depths through SPECIFIC type fragments:

```graphql
content {
  value
  blocks {
    __typename
    ... on HeroSectionRecord { id headline subheadline }
    ... on CodeBlockRecord { id language code }
    ... on FeatureGridRecord {
      id heading
      features {
        value
        blocks {
          __typename
          ... on FeatureCardRecord {
            id title description
            details {
              value
              blocks {
                __typename
                ... on CodeBlockRecord { id language code }
              }
            }
          }
        }
      }
    }
  }
}
```

The resolver currently walks the snapshot, matches each block's `_type` against the requested inline fragments, picks the selected fields, and recurses for nested StructuredText. This is an in-memory tree walk — no SQL — but it goes through the full Yoga resolver machinery (one function call per field per block per record).

## The Idea: Compile StructuredText Projection into SQL

Since `_published_snapshot` is a JSON column, SQLite's JSON functions can do the projection inside the database:

### Step 1: Extract the DAST value

```sql
json_extract(row_data."_published_snapshot", '$.content.value')
```

This gives us the `{ schema, document }` object directly.

### Step 2: Extract and project blocks

The blocks in the snapshot are keyed by block ID. Each block has a `_type` field. The GraphQL fragments tell us which fields to extract per type.

For each inline fragment `... on HeroSectionRecord { id headline subheadline }`, we know:
- Match blocks where `_type = 'hero_section'`
- Extract `id`, `headline`, `subheadline`
- Add `__typename: 'HeroSectionRecord'`

This can be done in SQL by iterating the blocks JSON object:

```sql
-- For each block in the snapshot, project based on _type
SELECT json_group_object(
  key,
  CASE json_extract(value, '$._type')
    WHEN 'hero_section' THEN json_object(
      '__typename', 'HeroSectionRecord',
      'id', key,
      'headline', json_extract(value, '$.headline'),
      'subheadline', json_extract(value, '$.subheadline')
    )
    WHEN 'code_block' THEN json_object(
      '__typename', 'CodeBlockRecord',
      'id', key,
      'language', json_extract(value, '$.language'),
      'code', json_extract(value, '$.code')
    )
    WHEN 'feature_grid' THEN json_object(
      '__typename', 'FeatureGridRecord',
      'id', key,
      'heading', json_extract(value, '$.heading'),
      'features', json_extract(value, '$.features')  -- nested ST, needs recursive projection
    )
  END
)
FROM json_each(json_extract(row_data."_published_snapshot", '$.content.blocks'))
```

### Step 3: Handle nested StructuredText (the hard part)

The `features` field on FeatureGridRecord is itself a StructuredText envelope with nested blocks. The query selects specific fields from those nested blocks too.

Two approaches:

**A) SQL-only (deep json_extract nesting):**
Compile nested StructuredText projections as nested CASE expressions with deeper `json_extract` paths. This gets verbose but stays in one SQL statement. SQLite's JSON functions handle arbitrary nesting.

**B) Hybrid (SQL extracts, JS projects):**
Have SQL return the raw StructuredText envelope for nested fields, then do the fragment projection in JS. This is simpler to compile but adds a post-processing step. Still much faster than Yoga resolvers because it's one pass over the data, not one function call per field.

### Step 4: Assemble the response shape

The GraphQL response needs `{ value, blocks: [...], inlineBlocks: [...], links: [...] }`. The current resolver walks the DAST `value` to determine which block IDs are block-level vs inline, and resolves link references.

For the compiled path:
- `value` — direct from `json_extract(snapshot, '$.content.value')`
- `blocks` — the block IDs referenced in `value.document.children` where `type === 'block'`, projected through the type-specific CASE expression
- `inlineBlocks` — block IDs referenced as `type === 'inlineItem'` in the DAST
- `links` — record IDs referenced as `type === 'itemLink'` in the DAST, resolved via correlated subqueries (same as the existing link compilation)

The blocks/inlineBlocks split requires knowing which IDs appear where in the DAST. This could be:
- Done in SQL with `json_each` over the DAST children
- Done in JS as a post-processing step (cheaper: just scan the DAST value, bucket the projected blocks)

## Recommended Approach

**Hybrid: SQL extracts the snapshot data, JS does the fragment projection and block bucketing.**

Why hybrid over pure SQL:
1. Pure SQL projection with nested CASE/json_extract for 3+ block types at 3 depth levels generates enormous SQL strings
2. The DAST walking (determining block vs inline vs link IDs) is tree traversal that's awkward in SQL
3. JS projection over pre-extracted JSON is fast — it's just object property access, no I/O

The compiler would:
1. Detect StructuredText fields in the selection plan
2. Instead of bailing out, emit `json_extract(row_data."_published_snapshot", '$.content')` to get the full envelope
3. Return the raw envelope in the SQL result
4. Post-process in JS: walk the DAST, project each block through the GraphQL fragment selection, split into blocks/inlineBlocks/links

This adds maybe 0.5-1ms of JS post-processing per query but saves 5-7ms of Yoga resolver overhead. Net win: ~4-6ms per deep query.

## Implementation Steps

1. **Extend `SelectionPlan` with a `structured_text` kind** that captures the nested fragment selections (which block types, which fields per type, which nested ST fields recurse)

2. **Remove the `isSupportedQueryText` bailouts** for `content`, `blocks`, `...` (inline fragments) — handle them in the plan builder instead

3. **In `buildSelectionPlan`**, when encountering a `structured_text` field:
   - Parse the inline fragments to build a type → selected fields map
   - For nested StructuredText within block types, recurse
   - Store this as a `StructuredTextProjectionPlan`

4. **In `buildJsonObjectSql`**, for `structured_text` selections:
   - Emit `json_extract(row_data."_published_snapshot", '$.{field_api_key}')` to get the raw envelope
   - Mark this field for JS post-processing

5. **Add a post-processing step** after SQL execution:
   - For each record with StructuredText fields, walk the DAST value
   - Project blocks through the fragment selection plan
   - Split into blocks/inlineBlocks/links arrays
   - Resolve link IDs via the existing correlated subquery mechanism (or batch them)

6. **Handle `__typename`** — add the type name based on `_type` → `toTypeName(apiKey) + "Record"`

## What This Unlocks

- `list_deep_12` and `list_deep_36` compiled: ~8-10ms → ~3-5ms each
- `single_by_slug` with content compiled: ~5ms → ~3ms
- Total suite: ~37ms → ~22-27ms
- Production rvkfoodie page queries: all major queries hit the fast path
