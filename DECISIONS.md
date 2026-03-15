# Product & Architecture Decisions

Canonical record of all settled decisions for agent-cms. ROADMAP.md references a subset of these — this file is the complete list. Do not change these without explicit instruction from the project owner.

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
| D12 | Editor/Management API | REST | CRUD operations for MCP tools/agents. Simpler than GraphQL for writes — single endpoint per operation, clear semantics, easy to make idempotent. No over/under-fetching concern for mutations. |
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
| D20 | Schema engine | "Table of tables" → runtime Drizzle codegen | System tables (`models`, `fields`) are the meta-schema. On startup: read system tables → generate Drizzle `sqliteTable()` definitions programmatically → build GraphQL schema from those. Cache schema descriptor in KV for fast cold starts. |
| D21 | Auto-migration | Runtime DDL diffing on every schema change | Core DX feature. REST mutation → update system tables → schema engine diffs current vs desired → emits DDL → executes transactionally. SQLite supports transactional DDL (advantage over Postgres). |
| D22 | Schema lifecycle | Every schema mutation cascades to content | Block type removal scans DAST trees. Field removal cleans block rows. Model removal is strict (refuse if referenced). See CHALLENGES.md [C11] for full matrix. |
| D23 | Field type change (v1) | Reject if field has existing data | Simplest safe approach. Require field to be empty before type change. Can add coercion later. |
| D24 | Required field on existing records | Require `default_value` in field config | DatoCMS approach. Auto-populate existing records with the default. |

## GraphQL Generation

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D25 | GraphQL schema builder | Pothos (`@pothos/core`) — evaluate, not committed | Strong candidate for code-first schema building (plugin ecosystem: Relay, dataloader, validation, errors). Drizzle plugin maps tables to GraphQL types. However, fit with dynamic runtime schemas + Effect is unproven. **Try Pothos first; if it fights the dynamic/Effect pattern, fall back to raw `graphql-js` constructors or our own generator using `drizzle-graphql` as reference.** |
| D26 | GraphQL StructuredText resolution | Recursive batch-fetch, not JOIN tree | Walk DAST → collect block IDs by type → batch-fetch from `block_*` tables → check fetched blocks for nested StructuredText fields → recurse until no more block references. Leverages our knowledge of the data shape. |
| D41 | Pothos plugins (if adopted) | Core, Drizzle, Relay, Dataloader, Validation, Errors | Relay for cursor connections. Dataloader for N+1 prevention on link/block resolution. Validation with `@effect/schema`. Skip: Auth (no auth v1), Prisma (not applicable). |
| D42 | GraphQL fallback plan | Raw `graphql-js` or own generator from `drizzle-graphql` reference | If Pothos doesn't fit the dynamic schema + Effect pattern, build our own. The `drizzle-graphql` repo remains useful reference code for query/mutation generation from Drizzle tables. |

## Infrastructure & Stack

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D27 | Runtime | Cloudflare Workers | Edge-native, integrated with D1/R2/KV/Images |
| D28 | Database | D1 (SQLite) | Managed SQLite on Cloudflare. One D1 = one CMS instance. No environments concept — staging is a separate deployment. |
| D29 | ORM | Drizzle 1.0 beta with Effect integration | Best TypeScript ORM, native D1 support, relational queries, programmatic schema definition API. Drizzle 1.0 has first-class Effect support — database operations return Effect types natively, composing cleanly with the rest of the Effect stack. |
| D30 | Asset storage | R2 | Cloudflare-native object storage |
| D31 | Image transforms | Cloudflare Images | Fully managed, no self-hosted infra (replaced earlier imgproxy decision). For local dev, serve originals without transforms. |
| D32 | Schema cache | KV | Store serialized schema descriptor. Version counter for invalidation. Cold start fast path. |
| D33 | Slug generation | `slugify` (simov/slugify) | Django-parity Unicode→ASCII transliteration. NFKD decomposition + explicit charmap for non-decomposable chars (ð→d, þ→th, æ→ae, etc.). Zero deps, Workers-compatible. |
| D34 | Tests | Vitest | Fast, TypeScript-native, good Workers/D1 testing story |
| D35 | Validation | `@effect/schema` (replaces Zod) | Runtime schema validation integrated with Effect's typed error channel. DAST document validation, record field validation, REST API input validation — all compose naturally with Effect pipelines. Errors are typed and recoverable, not thrown exceptions. |

## Effect.js

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D43 | Application framework | Effect | Typed errors, dependency injection (Layer/Context), structured concurrency, `@effect/schema` for validation — all in the type system. Particularly strong fit for: schema engine (multi-step transactional operations with typed failure modes), block write orchestration (atomic create/update/delete with rollback), dynamic service composition (Drizzle schema + GraphQL schema rebuilt on changes, injected via Layers). |
| D44 | Error handling | Effect typed errors throughout | Every operation declares what can fail: `SchemaEngineError`, `ValidationError`, `ReferenceConflictError`, etc. REST API maps these to precise HTTP responses. No untyped exceptions. The strict reference checking (D19) becomes a typed error the agent can act on. |
| D45 | Dependency injection | Effect Layers for runtime services | Dynamic Drizzle schema, GraphQL schema, D1 binding, KV cache — all provided as Effect services via Layers. On schema change: rebuild the Drizzle layer → rebuild GraphQL layer → swap. Clean, testable, no global mutable state. |
| D46 | Database operations | Drizzle 1.0 Effect integration | Drizzle 1.0 returns Effect types natively. Database queries compose with schema engine operations, validation, and error handling in a single Effect pipeline. Transactions use Effect's resource management (`acquireUseRelease`). |
| D47 | Validation | `@effect/schema` | Replaces Zod. Runtime validation + TypeScript type inference, integrated with Effect's error channel. DAST validation, record field validation, REST input validation all produce typed, recoverable errors. |

## Scope

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D36 | Auth | None for v1 | Easy to add later. Rely on Worker access controls. |
| D37 | Environments | None — one D1 = one CMS instance | Staging/preview = separate Worker + D1 deployment. Not our concern. |
| D38 | Video support | None for v1 | Media fields are image-only. |
| D39 | Generic file uploads | None for v1 | Media fields reference images in R2. No arbitrary file type support. |
| D40 | Field types not in v1 | `float`, `date`, `date_time`, `json`, `color`, `seo` | Can add later. v1 set: `string`, `text`, `boolean`, `integer`, `slug`, `media`, `media_gallery`, `link`, `links`, `structured_text` |

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
