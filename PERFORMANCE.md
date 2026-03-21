# Performance

This CMS is built around a simple performance principle:

GraphQL is a good way to describe a nested response shape, but it is usually a bad way to drive database execution one field at a time.

If a deep content query is resolved naively, two failure modes show up immediately:

- classic N+1 behavior from resolver-by-resolver fetching
- an attempt to "solve" that by compiling the whole graph into one giant SQL join, which quickly becomes unmaintainable and expensive

This codebase takes a middle path.

It plans the query as a series of frontiers:

1. fetch the root set
2. fetch each dependency frontier in batches
3. assemble the final JSON shape in memory

That is closer to map-reduce than to recursive resolver dispatch.

## Why Deep Graphs Are Hard

A simple relational query is easy:

- posts -> author
- posts -> category

But a real CMS delivery query is usually not just relations. It often includes:

- top-level records
- linked records
- StructuredText documents
- typed block unions
- nested StructuredText inside blocks
- more links inside those nested blocks

Trying to flatten all of that into one SQL statement creates the wrong shape:

- parent rows are duplicated for every child row
- unions across block tables become awkward
- nested StructuredText does not map cleanly to flat joins
- reconstructing the exact GraphQL response from the flattened rowset becomes its own expensive problem

Trying to leave it to GraphQL resolvers creates the opposite problem:

- work is discovered too late
- async boundaries multiply
- query count tends to scale with number of parents and nested fields

The architecture here is built to avoid both extremes.

## Execution Model

The deep-query read path works like this:

1. Inspect the whole GraphQL query up front.
2. Build a selection-aware plan for roots, links, and StructuredText subtrees.
3. Fetch one root frontier.
4. Materialize StructuredText breadth-first, one frontier at a time.
5. Batch linked-record fetches per frontier.
6. Project the final response in memory after fetch phases complete.

That means the important scaling property is:

- cost grows mainly with graph depth and dependency classes

not:

- number of parents times number of nested resolvers

## A Real Example

Consider a more representative content-delivery query.

This one includes:

- a normal link (`author`)
- a reverse relationship (`_allReferencingPosts`)
- a representative block with a link field (`CtaBlockRecord.target`)
- a real block with an asset field (`ImageBlockRecord.image`)
- an asset sub-selection using `responsiveImage`

```graphql
query CategoryLanding($slug: String!, $first: Int) {
  category(filter: { slug: { eq: $slug } }) {
    id
    name
    slug
    _allReferencingPosts(first: $first, orderBy: [publishedDate_DESC]) {
      id
      title
      slug
      author {
        id
        name
      }
      cover {
        responsiveImage(transforms: { width: 1200, height: 800, fit: cover }) {
          src
          srcSet
          width
          height
        }
      }
      content {
        value
        blocks {
          __typename
          ... on CtaBlockRecord {
            id
            label
            target {
              id
              slug
              title
            }
          }
          ... on ImageBlockRecord {
            id
            image {
              responsiveImage(transforms: { width: 1200, height: 800, fit: cover }) {
                src
                srcSet
                width
                height
              }
            }
          }
        }
      }
    }
  }
}
```

This is the kind of query that punishes a naive resolver model:

- the root record is a category
- the reverse-ref field has to discover posts that point at that category
- each post has a normal link to an author
- each post has an asset field
- each post also has StructuredText blocks, and some block types introduce another link or asset branch

If each layer discovers work independently, SQL and network hops multiply very quickly.

### Literal SQL And Pseudocode

This query is not one SQL statement. It is a sequence of frontiers.

The snippets below are split into:

- literal SQL taken from the current engine shape
- pseudocode explaining what that SQL is doing

#### Frontier 0: root category

Literal SQL:

```sql
SELECT id, name, slug
FROM "content_category"
WHERE "slug" = ?
LIMIT 1
```

Pseudocode:

```text
find the category page record for the requested slug
```

#### Frontier 1: reverse relationship into posts

Literal SQL from the reverse-ref loader:

```sql
SELECT *
FROM "content_post"
WHERE "category" = ?
ORDER BY "published_date" DESC
LIMIT ?
```

That comes from the reverse-ref path in:

- [`reverse-ref-loader.ts`](/Users/jokull/Code/agent-cms/src/graphql/reverse-ref-loader.ts)

Pseudocode:

```text
find all posts whose category field points at this category
return enough post columns for downstream field resolvers to keep working
```

This is the first point where a naive implementation can go wrong. Without reverse-ref batching, a page that loads many categories could turn this into one query per category.

#### Frontier 2: normal links on the returned posts

Literal SQL from linked-record batch resolution:

```sql
SELECT *
FROM "content_author"
WHERE id IN (?, ?, ...)
```

That comes from:

- [`structured-text-resolver.ts`](/Users/jokull/Code/agent-cms/src/graphql/structured-text-resolver.ts)
- [`linked-record-loader.ts`](/Users/jokull/Code/agent-cms/src/graphql/linked-record-loader.ts)

Pseudocode:

```text
scan the returned posts for author ids
load all needed authors in one batched lookup
```

This is the classic N+1 win: one set query instead of one resolver query per post.

#### Frontier 3: top-level StructuredText blocks

Literal SQL shape from StructuredText materialization:

```sql
SELECT id, _root_record_id, _root_field_api_key, _parent_block_id,
       'cta_block' AS __block_api_key,
       json_object(...) AS __payload
FROM "block_cta_block"
WHERE _root_record_id IN (?, ?, ...)
  AND _root_field_api_key = ?
  AND _parent_block_id IS NULL
  AND id IN (?, ?, ...)

SELECT id, _root_record_id, _root_field_api_key, _parent_block_id,
       'image_block' AS __block_api_key,
       json_object(...) AS __payload
FROM "block_image_block"
WHERE _root_record_id IN (?, ?, ...)
  AND _root_field_api_key = ?
  AND _parent_block_id IS NULL
  AND id IN (?, ?, ...)
```

That comes from:

- [`structured-text-service.ts`](/Users/jokull/Code/agent-cms/src/services/structured-text-service.ts)

Pseudocode:

```text
scan each post's DAST document for referenced top-level block ids
group those ids by block table
fetch matching block rows in one batched frontier
attach block payloads back to the correct posts
```

These statements are executed as one frontier batch.

#### Frontier 4: links inside blocks

Representative literal SQL shape for a block-level link field:

```sql
SELECT *
FROM "content_post"
WHERE id IN (?, ?, ...)
```

The same linked-record batch machinery is used here. The difference is just where the ids came from:

- root rows for normal links
- block payloads for block-level links

Pseudocode:

```text
scan fetched block payloads for target ids
load all linked targets in one batched lookup
attach them during final response projection
```

Again, this is where naive resolver dispatch would explode: one block field at a time, one linked post at a time.

#### Frontier 5: assets and `responsiveImage`

Literal SQL from asset resolution:

```sql
SELECT id, filename, width, height, alt, title, focal_point_x, focal_point_y
FROM "assets"
WHERE id IN (?, ?, ...)
```

The generic resolver path often expresses this one asset at a time as:

```sql
SELECT * FROM assets WHERE id = ?
```

That exact string appears in the asset and content resolver paths in:

- [`asset-resolvers.ts`](/Users/jokull/Code/agent-cms/src/graphql/asset-resolvers.ts)
- [`content-resolvers.ts`](/Users/jokull/Code/agent-cms/src/graphql/content-resolvers.ts)

Pseudocode:

```text
collect asset ids from post cover fields and image blocks
load the asset metadata rows
derive responsiveImage in memory from asset metadata plus transform args
```

`responsiveImage` itself does not issue more SQL. Once the asset row is loaded, the response object is derived in memory from the asset metadata plus transform args.

That distinction matters: `responsiveImage` looks visually deep in GraphQL, but its cost is mostly a projection cost, not another database frontier.

After these frontiers complete, the nested GraphQL response is assembled in memory.

## Why This Matters For Resolver Performance

The impact is not just "fewer SQL statements." The real impact is:

- fewer times the runtime has to discover new work late
- fewer Worker-to-D1 round trips
- fewer repeated deserializations of full rows
- fewer resolver re-entries as depth increases

For deep preview queries, the system exposes hop metrics directly in response headers.

For a warmed deep query, the important distinction is between:

- planned frontiers such as `root`, `st_frontier`, or `link_frontier`
- resolver-driven work that shows up as generic `resolver` time

The custom path is designed to concentrate work in planned frontiers.

The legacy Yoga path still shows more time outside those frontiers because more work is being discovered and executed through resolver dispatch.

Format is:

- `phase:hops/statements/time`

That tells the important story immediately:

- both paths share the same batched StructuredText frontier work
- the custom executor removes extra resolver-driven hops outside that frontier
- the remaining cost is no longer "deep GraphQL is exploding everywhere"
- it is isolated to a small number of planned frontiers

## Network Hops Matter As Much As SQL Time

Local development can understate the benefit of this design.

If the Worker and D1 are effectively colocated, a one-hop improvement may look small. If they are not perfectly colocated, every extra hop adds network latency on top of SQL execution.

That is why this project tracks:

- total SQL statements
- total SQL hops
- batched frontier hops
- per-phase breakdowns

The goal is not only to make SQL fast. The goal is to make deep graph execution predictable under real network conditions.

## Design Rules

The performance model in this codebase follows a few simple rules:

- Do not compile arbitrary deep GraphQL into one giant SQL join.
- Do not let resolver recursion control the fetch plan for deep content trees.
- Prefer one query per frontier over one query per parent.
- Prefer `IN (...)` and batched statements over ad hoc repeated lookups.
- Make fetches selection-aware so unused fields are not loaded.
- Assemble nested JSON in memory after the required frontiers have been fetched.

## Practical Result

For deep content delivery, the intended shape is:

- one root frontier
- a small number of breadth-first dependency frontiers
- in-memory projection of the response tree

That is the architecture that keeps deep GraphQL useful without letting SQL complexity or resolver fanout spiral out of control.
