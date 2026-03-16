# Roadmap

Gaps verified against production DatoCMS usage (~/Code/trip — 81 models, 4 locales, 30+ query files).

## GraphQL parity

- [ ] **Typed block unions** — StructuredText `blocks` returns `[JSON!]!`. Should return a per-field union type: `[PostContentBlock!]!` where `PostContentBlock = HeroSectionRecord | CodeBlockRecord | ...`. Frontends use inline fragments (`... on CodeBlockRecord { code language }`) instead of parsing raw JSON. Each block type gets a GraphQL object type with its fields + `__typename`. Same treatment for `inlineBlocks` and `links`. This is the #1 DatoCMS parity gap — every `react-datocms` `<StructuredText>` usage depends on typed blocks.

- [ ] **Reverse reference queries** — For every `link`/`links` field pointing at model X, model X gets `_allReferencing{SourceModel}` fields. Example: Category gets `_allReferencingPosts` returning all posts that link to it. DatoCMS generates these automatically. Eliminates "find all records where category = this ID" filter queries from frontends.

- [ ] **GraphQL `_search` query** — `_search(query: String!, mode: SearchMode, first: Int, skip: Int)` root query returning typed results with snippets. Currently search is REST-only (`POST /api/search`). GraphQL integration lets frontends use a single endpoint.

## Images

- [ ] **Blurhash → base64 LQIP** — `responsiveImage` has `base64` and `bgColor` fields but they return null. Accept blurhash at upload time, convert to a tiny base64 data URI for progressive loading placeholders. Trip uses this on every image.

- [ ] **Focal point in crops** — Asset has a `focal_point` column but `responsiveImage` crop ignores it. When `fit: "crop"` is requested, use focal point to control the crop center instead of defaulting to center.

## Search

- [ ] **Rebuild index endpoint** — MCP tool + REST to rebuild FTS5 and Vectorize indexes for all models. Needed after deploying search to a CMS with existing content.

## Content lifecycle

- [ ] **Scheduled publishing** — Set `_publishedAt` to a future date, record auto-publishes when the time arrives. Needs Cron Trigger or Durable Object timer.

- [ ] **Audit log** — System table tracking mutations (who, what, when). Useful for agent accountability — see what the AI changed.

## DX

- [ ] **`create-agent-cms` automated setup** — CLI should run `wrangler d1 create`, `wrangler r2 bucket create`, patch IDs into wrangler.jsonc, and apply migrations. Currently just prints instructions.

## Scoped out

- **Cache tags / CDN invalidation** — D1 at the edge eliminates stale-cache. Webhooks + framework revalidation is sufficient.
- **GraphQL subscriptions** — Not used in production DatoCMS projects. Webhooks cover it.
- **Per-field locale argument** — `title(locale: en)` override. Low demand, high complexity.
