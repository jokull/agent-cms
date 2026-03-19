# Product & Architecture Decisions

Canonical record of all settled decisions for agent-cms. This file is the complete list. Do not change these without explicit instruction from the project owner.

## Storage & Data Model

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | Content storage | Dynamic tables per model (`content_{api_key}`) | Enables natural Drizzle → GraphQL generation, real SQL types and indexes, proper FK constraints |
| D2 | Block storage | Dynamic tables per block type (`block_{api_key}`), shared globally | Matches DatoCMS block library concept. One table per block type, reusable across any model's StructuredText fields. Fewer tables than scoping per-field. |
| D3 | Block ownership | `_root_record_id` FK (CASCADE) + `_root_field_api_key` only | DAST JSON encodes block hierarchy — no polymorphic parent FK needed. Cascade delete by root record. Trade-off: can't query "children of block X" in SQL, but DAST handles that. |
| D4 | Block nesting | Unbounded depth | Drizzle supports recursive `with` clauses. Limit at query time (GraphQL depth), not storage time. |
| D5 | StructuredText storage | DAST JSON in TEXT column + block rows in `block_*` tables (hybrid) | Matches DatoCMS. Blocks are independently queryable. DAST tree + separate block rows = best of both worlds. |
| D6 | StructuredText is the only block-containing field type | No separate `rich_text` / `modular_content` type | Major simplification. "Modular content" (page builder) = StructuredText with a block-only validator whitelist (no prose nodes). One storage model, one resolution path, one set of GraphQL types. |
| D7 | Draft storage | `_published_snapshot` JSON column on each content row | Single row per record. Real columns = draft state. Snapshot = published state. `includeDrafts` toggles which the GraphQL resolver reads. Simpler than dual-row/shadow table. On field add, snapshot doesn't need updating (new field absent = null). On field remove, snapshots lazily cleaned. |
| D8 | Localization | JSON columns for localized fields | A localized field `title` stores `{"en": "Hello", "is": "Halló"}`. Non-localized fields store plain values. No column explosion, no DDL changes on locale add/remove, works with SQLite `json_extract()`. |
| D9 | All IDs | ULID via `ulidx` | Time-sortable = sequential B-tree inserts = no page fragmentation on SQLite. 26 chars (vs UUID's 36). Works in Workers/browser/Node. |
| D10 | Block IDs | Client-generated ULIDs | Agent provides ULIDs in DAST `block`/`inlineBlock` nodes + block payloads. Server validates all IDs in DAST match provided block data. No server-side ID rewriting needed. |

## API Design

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D11 | Consumer API | GraphQL via Yoga | Flexible queries, relations, filtering, localization, StructuredText resolution. Consumers pick exactly what they need. Matches DatoCMS CDA patterns. |
| D12 | Editor/Management API | REST via Hono (thin shell) + Effect pipelines (all logic) | Hono handles HTTP routing (14KB, zero-dep, Workers-native). All business logic runs as Effect pipelines inside handlers. Typed errors map to HTTP responses via `runEffect()`. `@effect/platform` HttpRouter migration deferred until Effect 4 stabilizes — current version (0.94.5) has `HttpRouter.toWebHandler` issues. |
| D13 | Schema introspection | REST | List models, fields, validators. Agents need predictable structure for planning — REST is more natural than GraphQL introspection for this. |
| D14 | GraphQL StructuredText shape | `{ value, blocks, links }` matching DatoCMS exactly | Enables reuse of entire DatoCMS rendering ecosystem: `datocms-structured-text-utils` (types, guards, validate), `datocms-structured-text-to-html-string`, `react-datocms <StructuredText>`, `datocms-structured-text-to-plain-text`, `datocms-html-to-structured-text`. All are purely DAST-format-based with zero DatoCMS API dependency. |
| D15 | Draft/published in GraphQL | `includeDrafts` argument or header | Default (`false`): only published records, read from `_published_snapshot`. `true`: includes draft/updated records, reads from real columns. Matches DatoCMS pattern. |
| D16 | GraphQL meta fields | `_createdAt`, `_updatedAt`, `_publishedAt`, `_firstPublishedAt`, `_status`, `_isValid` | Standard metadata on all record types, matching DatoCMS conventions. |
| D17 | GraphQL filtering | `eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `matches`, `isBlank`, `exists`, `AND`, `OR` | Comprehensive filter set matching DatoCMS CDA patterns. |
| D18 | GraphQL pagination | Offset-based (`first`, `skip`), max 500 per page | Simple. `_all{Model}Meta { count }` for total. |
| D19 | Dangling references | Strict — refuse deletion if referenced | Refuse to delete models/fields/blocks that are referenced by other models' link fields or StructuredText validators. Return clear error telling the agent what references must be cleaned up first. Safer for agent-only workflows. |

## Schema & Migration

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D20 | Schema engine | "Table of tables" → runtime DDL via `@effect/sql` | System tables (`models`, `fields`) are the meta-schema queried via Drizzle (static). Dynamic content/block tables are managed via `@effect/sql` raw SQL (CREATE TABLE, ALTER TABLE, INSERT, SELECT). No Drizzle codegen for dynamic tables — runtime safety comes from Effect, not static types. |
| D21 | Auto-migration | Runtime DDL diffing on every schema change | Core DX feature. REST mutation → update system tables → schema engine diffs current vs desired → emits DDL → executes transactionally. SQLite supports transactional DDL (advantage over Postgres). |
| D22 | Schema lifecycle | Every schema mutation cascades to content | Block type removal scans DAST trees. Field removal cleans block rows. Model removal is strict (refuse if referenced). |
| D23 | Field type change (v1) | Reject if field has existing data | Simplest safe approach. Require field to be empty before type change. Can add coercion later. |
| D24 | Required field on existing records | Require `default_value` in field config | DatoCMS approach. Auto-populate existing records with the default. |

## GraphQL Generation

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D25 | GraphQL schema builder | SDL + Yoga `createSchema()` for now; Pothos to evaluate later | Current approach: generate SDL strings from CMS metadata, use Yoga's `createSchema()`. Works, avoids graphql module duplication. Pothos remains a candidate if we need its plugin ecosystem (Relay, dataloader). |
| D26 | GraphQL StructuredText resolution | Recursive batch-fetch, not JOIN tree | Walk DAST → collect block IDs by type → batch-fetch from `block_*` tables → check fetched blocks for nested StructuredText fields → recurse until no more block references. Leverages our knowledge of the data shape. |
| D41 | Pothos plugins (if adopted) | Core, Drizzle, Relay, Dataloader, Validation, Errors | Relay for cursor connections. Dataloader for N+1 prevention on link/block resolution. Validation with `@effect/schema`. Skip: Auth (no auth v1), Prisma (not applicable). |
| D42 | GraphQL fallback plan | Raw `graphql-js` or own generator from `drizzle-graphql` reference | If Pothos doesn't fit the dynamic schema + Effect pattern, build our own. The `drizzle-graphql` repo remains useful reference code for query/mutation generation from Drizzle tables. |

## Infrastructure & Stack

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D27 | Runtime | Cloudflare Workers | Edge-native, integrated with D1/R2/Images |
| D28 | Database | D1 (SQLite) | Managed SQLite on Cloudflare. One D1 = one CMS instance. No environments concept — staging is a separate deployment. |
| D29 | Database access | **Drizzle for system tables** (static, typed) + **`@effect/sql` for dynamic tables** (runtime SQL) | Drizzle gives real type safety for the static system tables (models, fields, locales, assets). Dynamic content/block tables use `@effect/sql` (`SqlClient` template literals) — no static types possible, so runtime safety via Effect is the right tool. `@effect/sql-d1` in production, `@effect/sql-sqlite-node` in tests. Both share the `SqlClient.SqlClient` interface — application code is portable. |
| D30 | Asset storage | R2 | Cloudflare-native object storage |
| D31 | Image transforms | Cloudflare Images | Fully managed, no self-hosted infra (replaced earlier imgproxy decision). For local dev, serve originals without transforms. |
| D32 | Schema cache | ~~KV~~ **None** | ~~Store serialized schema descriptor.~~ **Scoped out.** D1 edge colocation makes reads fast enough. No KV, no cache tags, no invalidation protocol. D1 is always fresh. Frontend frameworks handle their own caching (Next.js revalidate, SWR). Lifecycle hooks notify frontends or trigger rebuilds when needed. |
| D33 | Slug generation | `slugify` (simov/slugify) | Django-parity Unicode→ASCII transliteration. NFKD decomposition + explicit charmap for non-decomposable chars (ð→d, þ→th, æ→ae, etc.). Zero deps, Workers-compatible. |
| D34 | Tests | Vitest | Fast, TypeScript-native, good Workers/D1 testing story |
| D35 | Validation | `@effect/schema` (replaces Zod) | Runtime schema validation integrated with Effect's typed error channel. DAST document validation, record field validation, REST API input validation — all compose naturally with Effect pipelines. Errors are typed and recoverable, not thrown exceptions. |

## Effect.js

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D43 | Application framework | Effect as the **complete runtime** | Effect is not just a utility — it's the runtime. HTTP (`@effect/platform` HttpRouter), SQL (`@effect/sql`), validation (`Schema`), error handling, DI (Layers) — all Effect. This is critical because the most important layers (dynamic schemas, content tables) have no static type safety. Effect provides the runtime safety net: typed errors, structured concurrency, resource management. |
| D44 | HTTP layer | Hono (routing) + Effect (all logic) | Hono stays as the thin HTTP shell — routing, request parsing, response formatting. All business logic is Effect pipelines with typed errors. `runEffect()` bridges Effect → Hono HTTP responses. `@effect/platform` HttpRouter deferred to Effect 4 — current version (0.94.5) `HttpRouter` doesn't convert to web handlers reliably. Hono is ~14KB and battle-tested on Workers. |
| D45 | Dependency injection | Effect Layers for runtime services | `SqlClient.SqlClient` (D1 or sqlite-node), schema engine, GraphQL schema — all provided as Effect services via Layers. Tests swap D1 for sqlite-node via a different Layer. On schema change: rebuild GraphQL layer. |
| D46 | Database operations | `@effect/sql` template literals for dynamic tables | `sql\`SELECT * FROM ${sql(tableName)} WHERE id = ${id}\`` — parameterized, safe, composable with Effect pipelines. `sql.insert()`, `sql.update()`, `sql.and()`, `sql.or()` for query building. Drizzle only for system tables. |
| D47 | Validation | `Schema` from `effect` package | Runtime validation + TypeScript type inference. `HttpServerRequest.schemaBodyJson(schema)` validates request bodies. `Schema.decodeUnknown` for DAST validation, record field validation. All produce typed `ParseError` that maps to 400 responses. |
| D48 | Test database | `@effect/sql-sqlite-node` with `:memory:` | Same `SqlClient.SqlClient` interface as D1. Tests use in-memory SQLite via `SqliteClient.layer({ filename: ":memory:" })`. Application code is identical between test and production — only the Layer differs. |

## Scope

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D36 | Auth | Write-only Bearer token (CMS_WRITE_KEY) | GraphQL is open (no auth). Write key required for REST/MCP. Set via `wrangler secret put`. Unauthenticated writes allowed when key is not configured (local dev). |
| D37 | Environments | None — one D1 = one CMS instance | Staging/preview = separate Worker + D1 deployment. Not our concern. |
| D38 | Video support | None for v1 | Media fields are image-only. |
| D39 | Generic file uploads | None for v1 | Media fields reference images in R2. No arbitrary file type support. |
| D40 | Field types in v1 | `string`, `text`, `boolean`, `integer`, `float`, `date`, `date_time`, `slug`, `media`, `media_gallery`, `link`, `links`, `structured_text`, `seo`, `json`, `color`, `lat_lon` | All 17 field types implemented. Registry pattern in `src/field-types.ts` enforces completeness. |
| D49 | Webhooks | None | Scoped out. Since the CMS runs in your own Worker, use lifecycle hooks (`onPublish`, `onRecordCreate`, etc.) or Cloudflare-native primitives directly instead of HTTP callbacks to yourself. |
| D50 | Cache tags / CDN invalidation | None | Scoped out. D1 edge locality plus frontend-framework revalidation and lifecycle hooks are sufficient. No application-level cache tag system. |
| D51 | GraphQL subscriptions | None | Scoped out. Not needed for the intended workflow. Lifecycle hooks cover mutation-driven integrations without maintaining a subscription protocol. |
| D52 | Per-field locale argument | None | Scoped out. Locale selection happens at the query level; per-field locale overrides add complexity for limited value. |
| D53 | Asset binary ingestion | Direct to R2, not through the Worker | Original binaries should be uploaded straight to object storage. agent-cms owns asset metadata and delivery, not the binary upload stream. Local imports should target Miniflare R2 directly; deployed tooling should use the R2 S3 API or signed direct uploads. |

## System Table Schemas

These are the static Drizzle tables (not auto-generated).

- **`models`** — id (ULID), name, api_key, is_block, singleton, sortable, tree, has_draft, ordering, created_at, updated_at
- **`fields`** — id (ULID), model_id FK, label, api_key, field_type (enum), position, localized, validators (JSON), default_value (JSON), appearance (JSON), hint, fieldset_id FK
- **`fieldsets`** — id (ULID), model_id FK, title, position
- **`locales`** — id (ULID), code (e.g. "en", "is"), position, fallback_locale_id FK
- **`assets`** — id (ULID), filename, mime_type, size, width, height, alt, title, r2_key, blurhash, colors (JSON), focal_point (JSON), tags (JSON), created_at

## Dynamic Table Schemas

Generated by the schema engine from system table metadata.

- **`content_{model_api_key}`** — id (ULID), `_status` (draft/published/updated), `_published_at`, `_first_published_at`, `_published_snapshot` (JSON), `_created_at`, `_updated_at`, plus one column per field (column name = field api_key, type mapped from field_type)
- **`block_{block_api_key}`** — id (ULID), `_root_record_id` (FK CASCADE), `_root_field_api_key`, plus one column per block field
