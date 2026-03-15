# agent-cms

An agent-first headless CMS you deploy to your own Cloudflare account. One Worker + D1 + R2 = one CMS instance. All schema and content editing via MCP tools — no admin UI. Mirrors DatoCMS concepts (models, blocks, StructuredText/DAST, GraphQL). The entire DatoCMS rendering ecosystem (`datocms-structured-text-utils`, `react-datocms <StructuredText>`, etc.) works with our API output because we match the `{ value, blocks, links }` shape.

See [CHALLENGES.md](./CHALLENGES.md) for deep dives on technical challenges (referenced as [C1], [C2], etc.).
See [DECISIONS.md](./DECISIONS.md) for the full canonical record of all product and architecture decisions (40 items). The Key Decisions section below is an excerpt — DECISIONS.md is authoritative.

---

## Stack

| Layer | Choice |
|---|---|
| Runtime framework | **Effect** — the complete runtime (HTTP, SQL, validation, DI, errors) |
| HTTP | `@effect/platform` HttpRouter → CF Worker `fetch` handler |
| System tables | Drizzle 1.0 beta (static, typed) |
| Dynamic tables | `@effect/sql` template literals (`@effect/sql-d1` prod, `@effect/sql-sqlite-node` test) |
| GraphQL | Yoga + SDL `createSchema()` (consumer API) |
| Hosting | Cloudflare Workers + D1 + R2 + KV |
| Assets | R2 storage + Cloudflare Images transforms |
| IDs | ULID via `ulidx` (time-sortable, 26 chars) |
| Validation | `Schema` from `effect` package |
| Tests | Vitest + `@effect/vitest` |
| Slugs | `slugify` (simov/slugify) |
| Rich text | StructuredText / DAST only (no separate modular content type) |

## Key Decisions

These are settled. Do not revisit without explicit instruction.

- **Table-per-model**: Each CMS model → real SQLite table (`content_{api_key}`). Each block type → `block_{api_key}` table, shared globally.
- **StructuredText is the only block-containing field type**. "Modular content" (page builder) = StructuredText with a block-only validator whitelist (no prose nodes).
- **Block ownership**: Blocks store `_root_record_id` FK (CASCADE) + `_root_field_api_key`. DAST JSON encodes the hierarchy — no polymorphic parent FK.
- **Effect is the runtime**: Not just a utility — Effect handles HTTP (`@effect/platform` HttpRouter, replaces Hono), SQL (`@effect/sql` for dynamic tables), validation (`Schema`), DI (Layers), and typed errors. The most important layers (dynamic schemas, content tables) have no static type safety, so Effect provides the runtime safety net.
- **Drizzle for system tables only**: Static, typed queries against `models`, `fields`, `locales`, `assets`. No Drizzle for dynamic content/block tables.
- **`@effect/sql` for dynamic tables**: `SqlClient` template literals for all content/block table operations (CREATE TABLE, INSERT, SELECT, etc.). `@effect/sql-d1` in production, `@effect/sql-sqlite-node` in tests — same interface, swapped via Layer.
- **Schema engine**: System tables read via Drizzle → DDL generated and executed via `@effect/sql` → GraphQL schema built via SDL + Yoga. → [C1, C5]
- **Draft/publish**: Single row per record. `_published_snapshot` JSON column holds the published state. Real columns = draft. `includeDrafts` toggles which the GraphQL resolver reads. → [C10]
- **Strict references**: Refuse to delete models/fields/blocks that are referenced elsewhere. Return clear error.
- **Client-generated ULIDs**: Agents provide block IDs in DAST + block payloads. Server validates they match.
- **DAST ecosystem compatible**: Our `{ value, blocks, links }` shape matches DatoCMS exactly.
- **No auth for v1**. No environments concept (one D1 = one instance).
- **Auto-migration**: Schema changes via REST trigger DDL automatically. → [C1, C11]

## Field Types (v1)

`string`, `text`, `boolean`, `integer`, `slug`, `media` (single image), `media_gallery` (multiple images), `link` (single record ref), `links` (multiple record refs), `structured_text`

---

## Development

```bash
# Install
npm install

# Run locally (D1 local, no deploy)
npx wrangler dev

# Run tests
npx vitest

# Run tests in watch mode
npx vitest --watch
```

All development is local. Do not deploy to Cloudflare. Use `wrangler dev` with local D1 for the tightest possible loop.

---

## Loop Protocol

You are the builder of this application. Each iteration, follow this loop:

### 1. Orient
Read this file. Check the **In Progress** section — if there's unfinished work, resume it. If empty, pick the top item from **Backlog**.

### 2. Implement
Move the item to **In Progress**. Write the code. Follow these rules:
- Write tests alongside the implementation (unit tests for pure logic, integration tests for API endpoints)
- Run `npx vitest` before considering the item done. All tests must pass.
- If a test schema milestone is reached (marked with `[SCHEMA:blog]`, `[SCHEMA:marketing]`, or `[SCHEMA:recipes]`), exercise the system by creating that schema and sample content via the REST API in an integration test. The test should create the schema, insert records, and query them via GraphQL.

### 3. Verify
- All existing tests still pass
- New functionality works (verified by test, not by manual checking)
- No TypeScript errors (`npx tsc --noEmit`)

### 4. Commit
```bash
git add <specific files>
git commit -m "<concise description of what was built>"
```
One commit per completed backlog item. Move the item from **In Progress** to **Done** in this file and commit that too.

### 5. Next
If context budget allows, pick the next item and continue. If running low on context, ensure this file is up to date and stop — a fresh agent will pick up from here.

### When stuck
If blocked for more than 2 attempts at the same approach:
1. Document what you tried in a comment under the In Progress item
2. Check [CHALLENGES.md](./CHALLENGES.md) for guidance on the relevant challenge
3. Try an alternative approach
4. If still stuck, leave a `BLOCKED:` note on the item and move to the next item

---

## Test Schemas

These are real-world schemas used to validate the CMS at increasing complexity. Each is a milestone — when all backlog items up to that milestone are done, write an integration test that builds the full schema and exercises it.

### Schema 1: Personal Blog `[SCHEMA:blog]`
Milestone: after basic models, fields, records, slug, and GraphQL work.

**Models:**
- `author` (singleton) — `name: string`, `bio: text`, `avatar: media`
- `category` — `name: string`, `slug: slug(name)`
- `post` — `title: string`, `slug: slug(title)`, `body: text`, `excerpt: text`, `cover_image: media`, `author: link(author)`, `category: link(category)`, `published: boolean`

**Tests:** Create all models and fields via REST. Insert sample records. Query posts with filtering (`published: true`), ordering (`_createdAt DESC`), and linked author/category resolution via GraphQL. Test slug generation (including diacritics: "Íslensku bloggfærslurnar" → "islensku-bloggfaerslurnar").

### Schema 2: Marketing Site `[SCHEMA:marketing]`
Milestone: after blocks, StructuredText, and draft/publish work.

**Models:**
- `page` — `title: string`, `slug: slug(title)`, `content: structured_text` (blocks-only whitelist = page builder)

**Block types:**
- `hero_section` — `headline: string`, `subheadline: text`, `background_image: media`, `cta_text: string`, `cta_url: string`
- `feature_grid` — `heading: string`, `features: structured_text` (blocks-only, whitelist: `feature_card`)
- `feature_card` — `icon: string`, `title: string`, `description: text`
- `testimonial` — `quote: text`, `author_name: string`, `author_title: string`, `avatar: media`
- `cta_banner` — `heading: string`, `body: text`, `button_text: string`, `button_url: string`

**Tests:** Create schema via REST. Build a homepage with hero → feature_grid (containing 3 feature_cards) → testimonial → cta_banner. This tests nested blocks (feature_grid containing feature_cards). Query via GraphQL and verify the `{ value, blocks, links }` shape. Test draft/publish: create page as draft, verify it's hidden from default GraphQL, publish it, verify it appears, edit it (status → updated), verify `includeDrafts` shows edits while default still shows published snapshot.

### Schema 3: Recipe Site `[SCHEMA:recipes]`
Milestone: after localization and media gallery work.

**Models:**
- `cuisine` — `name: string` (localized), `slug: slug(name)`
- `dietary_tag` — `name: string` (localized), `icon: string`
- `recipe` — `title: string` (localized), `slug: slug(title)`, `intro: structured_text` (prose + inline images), `steps: structured_text` (blocks-only, whitelist: `recipe_step`), `prep_time: integer`, `cook_time: integer`, `servings: integer`, `cuisine: link(cuisine)`, `dietary_tags: links(dietary_tag)`, `photos: media_gallery`, `cover: media`

**Block types:**
- `recipe_step` — `instruction: structured_text` (prose, may contain inline block `ingredient_callout`), `step_image: media`
- `ingredient_callout` — `name: string` (localized), `amount: string`, `unit: string`

**Tests:** Create schema. Insert a recipe in two locales (en + is). Query with `locale: "en"` and `locale: "is"`, verify correct values returned. Test fallback locale chain. Test nested block resolution: recipe → steps (StructuredText with recipe_step blocks) → recipe_step.instruction (StructuredText with ingredient_callout inline blocks). Verify full recursive `{ value, blocks, links }` resolution to arbitrary depth.

---

## In Progress

(empty — pick from backlog)

---

## Backlog

Items are in dependency order. Pick from the top. Each item should be completable in one iteration.

### Phase 0: Foundation

- [x] **P0.1** Scaffold project *(done)*
- [x] **P0.2** System tables + tests *(done)*
- [x] **P0.3** Schema engine core + DDL creation *(done)*
- [x] **P0.4** Schema engine DDL diffing + migration *(done)*
- [x] **P0.5** REST models CRUD *(done)*
- [x] **P0.6** REST fields CRUD *(done)*
- [x] **P0.7** Strict model deletion reference checking *(done)*
- [x] **P0.8** Record CRUD *(done)*
- [x] **P0.9** Slug field with diacritics and uniqueness *(done)*
- [x] **P0.10** GraphQL foundation *(done — SDL-based, working)*
- [x] **P0.10** GraphQL foundation *(done)*
- [ ] **P0.10a** **Effect platform migration**: Replace Hono with `@effect/platform` HttpRouter. Replace Drizzle for dynamic tables with `@effect/sql` template literals. Keep Drizzle for system tables only. Use `@effect/sql-sqlite-node` for tests. All HTTP routes become Effect pipelines. Typed errors map to HTTP responses via `Effect.catchTags`. `SqlClient.SqlClient` injected via Layer (D1 prod, sqlite-node test). This is the foundational refactor — everything after this builds on Effect-native patterns. See D43-D48.
- [x] **P0.11** GraphQL filtering + ordering *(done)*
- [x] **P0.12** Link fields with GraphQL resolution *(done)*
- [x] **P0.13** `[SCHEMA:blog]` integration test *(done — 100 tests passing)*

### Phase 1: Blocks & StructuredText

- [ ] **P1.1** Block type support in system tables: `is_block` flag on models. Block types go through the same REST model CRUD but create `block_{api_key}` tables instead of `content_{api_key}`. Block tables always get `_root_record_id` and `_root_field_api_key` columns. Test: create a block type, verify table structure.
- [ ] **P1.2** StructuredText field type — storage: `structured_text` field creates a TEXT column. DAST `@effect/schema` validator (match the DatoCMS DAST spec — use `datocms-structured-text-utils` as reference for node types and allowed children). Test: validate well-formed and malformed DAST documents.
- [ ] **P1.3** StructuredText write orchestration: REST accepts `{ value: <DAST>, blocks: { <ulid>: { type: "hero_section", fields: {...} }, ... } }`. Server validates DAST, validates block data against block type fields, writes block rows to `block_*` tables, writes DAST JSON to content table column. All in one transaction. Test with a simple block.
- [ ] **P1.4** StructuredText update + orphan cleanup: On update, diff old vs new DAST, identify removed block IDs, delete them (recursively if nested). Test: create record with 3 blocks, update to 2 blocks, verify orphan deleted.
- [ ] **P1.5** GraphQL StructuredText resolution: Return `{ value, blocks, links }`. Walk DAST, collect block IDs by type, batch-fetch from `block_*` tables, return as typed union. Test with a field containing two different block types.
- [ ] **P1.6** Nested blocks: A block type with a StructuredText field that itself allows blocks. Test recursive resolution: content record → block A (has ST field) → block B (inside A's ST). Verify GraphQL returns the full nested `{ value, blocks }` structure.
- [ ] **P1.7** StructuredText validators: `structured_text_blocks` (whitelist block types), `structured_text_links` (whitelist linkable model types). Reject writes with block types or link targets not in the whitelist. Test both acceptance and rejection.
- [ ] **P1.8** Block-only StructuredText (modular content): A StructuredText field where the validator only allows `block` nodes at root level (no paragraph, heading, etc.). The DAST root.children should only contain `block` nodes. Test that prose is rejected.
- [ ] **P1.9** Draft/publish lifecycle: Add `_status`, `_published_at`, `_first_published_at`, `_published_snapshot` columns to all content tables (via schema engine). Implement `POST /records/:id/publish` and `POST /records/:id/unpublish`. On edit of published record: status → `updated`, real columns change, snapshot stays. GraphQL: `includeDrafts: false` reads from snapshot, `true` reads real columns. Test the full lifecycle. → [C10]
- [ ] **P1.10** GraphQL meta fields: `_createdAt`, `_updatedAt`, `_publishedAt`, `_firstPublishedAt`, `_status`, `_isValid` on all record types.
- [ ] **P1.11** `[SCHEMA:marketing]` Marketing site integration test. Full schema with nested blocks (feature_grid → feature_card). Draft/publish cycle. Verify `{ value, blocks, links }` output is compatible with `datocms-structured-text-utils` `isBlock()`, `isStructuredText()` type guards.

### Phase 2: Media & Assets

- [ ] **P2.1** Asset system table + REST CRUD: `POST /assets` (upload to R2), `GET /assets`, `GET /assets/:id`, `DELETE /assets/:id`. Store metadata in `assets` table. For local dev, store files on local filesystem (wrangler R2 emulation). Test upload + retrieval.
- [ ] **P2.2** `media` field type: FK column to `assets` table. GraphQL resolves to asset metadata (url, width, height, alt, mime_type). Test: create model with media field, create record with asset reference, query via GraphQL.
- [ ] **P2.3** `media_gallery` field type: JSON array of asset IDs in a TEXT column, or junction table. GraphQL resolves to array of asset objects. Test ordering preservation.
- [ ] **P2.4** Responsive image metadata in GraphQL: `responsiveImage` field on media assets returning `src`, `srcSet`, `width`, `height`, `alt`. For local dev, generate basic srcSet from stored dimensions. Cloudflare Images integration is deployment-time only.

### Phase 3: Localization

- [ ] **P3.1** Locale management: REST CRUD for `locales` table. `POST /locales`, `DELETE /locales/:id`. Test add/remove.
- [ ] **P3.2** Localized fields: `localized: true` flag on field definitions. Schema engine creates TEXT columns that store JSON `{"en": "Hello", "is": "Halló"}` for localized fields. Non-localized fields store plain values. Test: create localized string field, write values in two locales, read back.
- [ ] **P3.3** GraphQL locale resolution: `locale` argument on queries extracts the correct locale from JSON columns. `fallbackLocales` array for fallback chain. Test: query with primary locale (hit), query with missing locale (fallback), query with no fallback (null).
- [ ] **P3.4** `[SCHEMA:recipes]` Recipe site integration test. Full schema with localized fields (en + is), nested blocks (recipe → steps → ingredient_callout), media gallery, link fields, dietary tags. Test locale querying, recursive block resolution, and the full `{ value, blocks, links }` shape at every nesting level.

### Phase 4: Schema Lifecycle

- [ ] **P4.1** Field type change: Reject if field has data (v1 simplification). Test: try changing a string field with existing records → error. Change on empty model → success. → [C11]
- [ ] **P4.2** Required field with existing records: Require `default_value` in field config. Apply default to all existing records on migration. Test. → [C11]
- [ ] **P4.3** Model/field rename (`api_key` change): Rename table/column, update `_root_field_api_key` in block rows, invalidate schema cache. Test. → [C11]
- [ ] **P4.4** Block type removal: Scan all StructuredText fields, clean DAST trees, delete block rows, drop table. Test with a block type used across multiple models. → [C11]
- [ ] **P4.5** Block whitelist removal: Remove a block type from a field's whitelist (without deleting the type). Clean affected DAST trees. Test. → [C11]
- [ ] **P4.6** Locale removal: Strip locale key from all localized field values across all models. Test. → [C11]

### Phase 5: MCP Tools

- [ ] **P5.1** MCP server scaffold: `@modelcontextprotocol/sdk` package. MCP server that calls the local REST API. Discovery tool: `list_models` (returns all models with fields).
- [ ] **P5.2** Schema tools: `create_model`, `create_field`, `update_model`, `update_field`, `delete_model`, `delete_field`. Each calls the REST API and returns the result. Test via MCP protocol.
- [ ] **P5.3** Content tools: `create_record`, `update_record`, `delete_record`, `query_records`, `publish_record`, `unpublish_record`.
- [ ] **P5.4** StructuredText tools: Helper tool for building DAST documents — agent provides prose and block data, tool assembles valid DAST with ULIDs assigned.
- [ ] **P5.5** Asset tools: `upload_asset`, `list_assets`.
- [ ] **P5.6** End-to-end MCP test: Use the MCP tools to create the blog schema, insert content, and query via GraphQL. Verify the full loop works.

### Future (not prioritized)

- [ ] Webhooks on record/schema changes
- [ ] SEO composite field type
- [ ] Tree/sortable models (position column, parent_id)
- [ ] GraphQL subscriptions for real-time updates
- [ ] Schema descriptor KV caching for production cold starts
- [ ] Cloudflare Images integration (production only, not local dev)
- [ ] Blurhash / dominant color extraction on asset upload

---

## Done

- **P0.1** Scaffold project: Hono + Effect + Drizzle 1.0 beta + Yoga + Vitest + ulidx + slugify. `wrangler.toml` with local D1. Health check endpoint + test passing. `wrangler dev` confirmed working.
- **P0.2** System tables (models, fields, fieldsets, locales, assets) in Drizzle. Migration generated. 10 tests: CRUD, cascade deletes, JSON columns, unique constraints, locale fallback chains.
- **P0.3** Schema engine: `generateSchema()` reads model/field metadata → produces Drizzle `sqliteTable()` definitions. `createTableFromSchema()` generates DDL and creates tables. All v1 field types mapped. 12 tests: content tables, block tables, JSON roundtrips, multi-table isolation.
- **P0.4** Schema engine migration: `migrateTable()` diffs Drizzle table vs SQLite state → CREATE TABLE if missing, ALTER TABLE ADD/DROP COLUMN for changes. `dropTable()` for model removal. 8 tests: create, add columns, drop columns, data preservation, idempotency, block tables.
- **P0.5** REST Models API: full CRUD (POST/GET/GET/:id/PATCH/DELETE) on `/api/models`. POST creates model + dynamic table via schema engine. DELETE does strict reference checking + drops table. 12 tests: creation, block models, duplicates, validation, listing, detail, update, deletion.
- **P0.6** REST Fields API: full CRUD on `/api/models/:id/fields`. POST adds field + column to dynamic table. DELETE removes field + drops column. All v1 field types supported. Validators stored as JSON. 11 tests.
- **P0.7** Strict model deletion: refuse DELETE if other models have link/links fields referencing this model. Tested with cross-model link reference.
- **P0.8** Record CRUD: POST/GET/GET/:id/PATCH/DELETE on `/api/records`. Writes to dynamic content tables. Validates required fields. Singleton enforcement. Draft status on create. Status transitions on edit. 12 tests.
- **P0.9** Slug field: `generateSlug()` using slugify with Django-parity transliteration. Auto-generate from source field (via `slug_source` validator). Uniqueness enforcement with numeric suffix. Tests: Icelandic chars (Þ→th, ð→d, æ→ae), uniqueness, explicit override. 11 tests.
- **P0.10** GraphQL: SDL-based dynamic schema via Yoga `createSchema()`. Auto-generates query types from CMS models. `all{Model}s`, `{model}(id)`, `_all{Model}sMeta { count }`. Pagination via first/skip. Meta fields. 7 tests.
- **P0.10a** Effect refactor: all REST APIs use Effect.gen with typed errors (NotFoundError, ValidationError, DuplicateError, ReferenceConflictError). runEffect() bridges Effect → Hono.
- **P0.11** GraphQL filtering (eq, neq, gt, lt, gte, lte, matches, isBlank, exists, AND, OR) + ordering (field_ASC/DESC) + per-model filter/orderBy input types. Meta respects filters. 9 new tests.
- **P0.12** Link fields: `link` resolves to nested object (target model type from item_item_type validator). `links` resolves to array of nested objects. SDL types generated dynamically from link targets. 2 new tests.
- **P0.13** `[SCHEMA:blog]` Full integration test: author (singleton) + category + post models. Fields: string, text, slug, media, link, boolean. Slug auto-generation with diacritics. GraphQL queries with filtering, ordering, link resolution, meta counts. Singleton/required field enforcement. Strict deletion refusal. 5 tests.

---

## Architecture Reference

```
MCP Tools → REST (@effect/platform HttpRouter) → Effect pipelines → D1 (SQLite)
                                                                        ↓
                                                    System tables: Drizzle (static, typed)
                                                    Dynamic tables: @effect/sql (runtime SQL)
                                                                        ↓
                                                    GraphQL schema (SDL + Yoga createSchema)
                                                                        ↓
                                                    Yoga (GraphQL Content Delivery API)

Storage: R2 (assets) · KV (schema cache) · D1 (everything else)
Tables:  system (Drizzle) + dynamic content_*/block_* (@effect/sql)
Runtime: Effect everywhere — HTTP, SQL, validation, DI, typed errors
Test:    @effect/sql-sqlite-node ":memory:" (same SqlClient interface as D1)
```

**API split:** GraphQL for consumers (read), REST for editors/agents (write). Mirrors DatoCMS CDA vs CMA.

**Effect is the runtime:** HTTP routes are Effect pipelines via `@effect/platform` HttpRouter. `SqlClient.SqlClient` is the database service (D1 or sqlite-node, swapped via Layer). `Schema` validates all inputs. Typed errors (`NotFoundError`, `ValidationError`, etc.) automatically map to HTTP responses.

**Schema lifecycle:** REST mutation → update system tables (Drizzle) → schema engine diffs → DDL via `@effect/sql` → rebuild GraphQL schema (SDL + Yoga) → serve. → [C11]

**StructuredText storage:** DAST JSON in TEXT column + block rows in `block_*` tables. Blocks store `_root_record_id` (CASCADE) for cleanup. DAST encodes the tree; SQL doesn't track nesting hierarchy. → [C3]

**Draft/publish:** Single row, `_published_snapshot` JSON column. Edit = write to real columns (draft). Publish = copy columns to snapshot. GraphQL `includeDrafts` toggles source. → [C10]
