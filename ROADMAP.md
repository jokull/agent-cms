# Roadmap

Gaps verified against production DatoCMS usage (~/Code/trip — 81 models, 4 locales, 30+ query files).

## GraphQL parity

- [ ] **GraphQL `_search` query** — `_search(query: String!, mode: SearchMode, first: Int, skip: Int)` root query returning typed results with snippets. Currently search is REST-only (`POST /api/search`). GraphQL integration lets frontends use a single endpoint.

## Images

- [ ] **Blurhash → base64 LQIP** — `responsiveImage` has `base64` and `bgColor` fields but they return null. Accept blurhash at upload time, convert to a tiny base64 data URI for progressive loading placeholders. Trip uses this on every image.

- [ ] **Focal point in crops** — Asset has a `focal_point` column but `responsiveImage` crop ignores it. When `fit: "crop"` is requested, use focal point to control the crop center instead of defaulting to center.

## Content lifecycle

- [ ] **Scheduled publishing** — Set `_publishedAt` to a future date, record auto-publishes when the time arrives. Needs Cron Trigger or Durable Object timer.

- [ ] **Audit log** — System table tracking mutations (who, what, when). Useful for agent accountability — see what the AI changed.

## Scoped out

- **Webhooks** — Removed. Since you own the Worker, use lifecycle hooks (`onPublish`, `onRecordCreate`, etc.) passed to `createCMSHandler` instead. Direct code is simpler and more reliable than HTTP callbacks to yourself.
- **Cache tags / CDN invalidation** — D1 at the edge eliminates stale-cache. Lifecycle hooks + framework revalidation is sufficient.
- **GraphQL subscriptions** — Not used in production DatoCMS projects. Hooks cover it.
- **Per-field locale argument** — `title(locale: en)` override. Low demand, high complexity.
