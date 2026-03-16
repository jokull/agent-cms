# agent-cms

**A library and CLI that helps developers set up an agent-first headless CMS on Cloudflare.** Not a hosted service — you own the Worker, D1 database, and R2 bucket in your own Cloudflare account.

`npx create-agent-cms` scaffolds a Worker project. You bring your package manager, configure via prompts (name, R2, observability), deploy with `wrangler deploy`. The MCP server runs inside the Worker at `/mcp` — point Claude Desktop or Claude Code at it, and the agent defines your schema, manages content, uploads assets. No admin UI needed.

Frontends consume the GraphQL CDA at `/graphql`. The entire DatoCMS rendering ecosystem (`datocms-structured-text-utils`, `react-datocms <StructuredText>`, etc.) works with our API output because we match the `{ value, blocks, links }` shape.

## Architecture

```
Developer runs: npx create-agent-cms
                    ↓
         Scaffolded Worker project
         (wrangler.jsonc, src/index.ts, package.json)
                    ↓
         wrangler deploy
                    ↓
    ┌───────────────────────────────────┐
    │  Cloudflare Worker                │
    │  ├─ /graphql  → GraphQL CDA      │
    │  ├─ /mcp      → MCP server       │
    │  ├─ /api/*    → REST admin API   │
    │  └─ /health   → health check     │
    │                                   │
    │  D1 (schema + content)            │
    │  R2 (asset files)                 │
    └───────────────────────────────────┘
                    ↓
    Agent (Claude) connects to /mcp
    → defines models, fields, content
    → uploads assets via wrangler r2 object put

    Frontend (Next.js etc.) queries /graphql
    → consumes content, renders with react-datocms
```

## Asset Upload Flow

```bash
# 1. Upload file to R2 via wrangler CLI
wrangler r2 object put my-cms/uploads/hero.jpg --file=./hero.jpg --content-type=image/jpeg

# 2. Register asset metadata via MCP or REST
# MCP: upload_asset tool with r2Key, dimensions, alt text
# REST: POST /api/assets { filename, mimeType, size, width, height, r2Key }

# 3. Use in content — reference asset ID in media fields
```

See [CHALLENGES.md](./CHALLENGES.md) for deep dives on technical challenges (referenced as [C1], [C2], etc.).
See [DECISIONS.md](./DECISIONS.md) for the full canonical record of all product and architecture decisions (40 items). The Key Decisions section below is an excerpt — DECISIONS.md is authoritative.

---

## Stack

| Layer | Choice |
|---|---|
| Runtime framework | **Effect** — the complete runtime (HTTP, SQL, validation, DI, errors) |
| HTTP | Hono (thin routing shell) + Effect pipelines (all logic) |
| System tables | Drizzle 1.0 beta (static, typed) |
| Dynamic tables | `@effect/sql` template literals (`@effect/sql-d1` prod, `@effect/sql-sqlite-node` test) |
| GraphQL | Yoga + SDL `createSchema()` (consumer API) |
| Hosting | Cloudflare Workers + D1 + R2 |
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
- **Effect is the runtime**: Not just a utility — Effect handles SQL (`@effect/sql` for dynamic tables), validation (`Schema`), DI (Layers), and typed errors. Hono stays as the thin HTTP routing shell (~14KB). The most important layers (dynamic schemas, content tables) have no static type safety, so Effect provides the runtime safety net. `@effect/platform` HttpRouter deferred to Effect 4.
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

`string`, `text`, `boolean`, `integer`, `float`, `date`, `date_time`, `slug`, `media` (single image), `media_gallery` (multiple images), `link` (single record ref), `links` (multiple record refs), `structured_text`, `seo` (title/description/image/twitterCard composite), `json` (arbitrary JSON), `color` ({red,green,blue,alpha} + computed hex), `lat_lon` ({latitude,longitude})

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
- [x] **P0.10a** @effect/sql migration *(done — Effect platform + @effect/sql fully integrated)*
- [x] **P0.11** GraphQL filtering + ordering *(done)*
- [x] **P0.12** Link fields with GraphQL resolution *(done)*
- [x] **P0.13** `[SCHEMA:blog]` integration test *(done — 100 tests passing)*

### Phase 1: Blocks & StructuredText

- [x] **P1.1** Block type support *(done — already works from P0.5, verified with 3 new tests)*
- [x] **P1.2** DAST validation *(done — 22 tests)*
- [x] **P1.3** StructuredText write orchestration *(done — 5 tests)*
- [x] **P1.4** StructuredText update + orphan cleanup *(done — 3 tests)*
- [x] **P1.5** GraphQL StructuredText resolution *(done — { value, blocks, links }, 3 tests)*
- [x] **P1.6** Nested blocks *(done — page→feature_grid→feature_cards, 2 tests)*
- [x] **P1.7** StructuredText validators *(done — block whitelist tested in P1.3, blocks_only in P1.8)*
- [x] **P1.8** Block-only StructuredText / modular content *(done — 8 tests)*
- [x] **P1.9** Draft/publish lifecycle *(done — 6 tests)*
- [x] **P1.10** includeDrafts + GraphQL meta fields *(done — X-Include-Drafts header, published snapshot overlay, 7 tests)*
- [x] **P1.11** `[SCHEMA:marketing]` *(done — 110 tests total)*

### Phase 2: Media & Assets

- [x] **P2.1** Asset REST CRUD *(done — 10 tests)*
- [x] **P2.2** `media` field GraphQL resolution *(done — resolves to Asset object, 4 tests)*
- [x] **P2.3** `media_gallery` field GraphQL resolution *(done — resolves to [Asset!], included in P2.2 tests)*
- [x] **P2.4** responsiveImage + _site query *(done — srcSet generation, _site { locales }, 4 tests)*

### Phase 3: Localization

- [x] **P3.1** Locale management REST CRUD *(done — 6 tests)*
- [x] **P3.2+P3.3** Localized fields + GraphQL locale resolution *(done — 6 tests)*
- [x] **P3.4** `[SCHEMA:recipes]` *(done — 113 tests total, all 3 milestones complete!)*

### Phase 4: Schema Lifecycle

- [x] **P4.1** Field type change rejection *(done — 4 tests)*
- [x] **P4.2** Required field with default_value on existing records *(done — 4 tests)*
- [x] **P4.3** Model/field rename *(done — table rename, column rename, validator cascade, 4 tests)*
- [x] **P4.4** Block type removal *(done — DAST cleanup, block deletion, table drop, whitelist update, 1 test)*
- [x] **P4.5** Block whitelist removal *(done — DAST cleanup, keeps block type, 1 test)* → [C11]
- [x] **P4.6** Locale removal *(done — strips locale from all localized fields, 1 test)* → [C11]

### Phase 5: MCP Tools

- [x] **P5.1** MCP server scaffold *(done — 12 tools, 12 tests via InMemoryTransport)*
- [x] **P5.2** Schema tools *(done — create_model, create_field, delete_model, delete_field)*
- [x] **P5.3** Content tools *(done — create_record, update_record, delete_record, query_records, publish, unpublish)*
- [x] **P5.4** StructuredText helper tool *(done — build_structured_text MCP tool, 3 tests)*
- [x] **P5.5** Asset MCP tools *(done — upload_asset, list_assets)*
- [x] **P5.6** End-to-end MCP test *(done — full agent workflow: schema → content → publish → GraphQL query)*

### Future (not prioritized)

- [x] Webhooks on record/schema changes *(done — CRUD via MCP, fires on record create/update/delete/publish/unpublish, 5 tests)*
- [x] SEO composite field type *(done — `seo` field stores {title, description, image, twitterCard} as JSON, image resolves to Asset in GraphQL, 5 tests)*
- [x] Tree/sortable models *(done — _position auto-increment, _parent_id for tree hierarchy, _parent/_children GraphQL resolvers, reorder_records MCP tool + REST endpoint, 6 tests)*
- [x] `json` field type *(done — arbitrary JSON storage, GraphQL JSON scalar, 3 tests)*
- [x] `float` field type *(done — REAL column, Float GraphQL type, FloatFilter, ordering, 4 tests)*
- [x] `date` + `date_time` field types *(done — ISO string storage, filtering, ordering, 3 tests)*
- [x] `color` field type *(done — {red,green,blue,alpha} JSON with computed hex in GraphQL, Effect Schema validation, 4 tests)*
- [x] `lat_lon` field type *(done — {latitude,longitude} JSON, Effect Schema range validation, 4 tests)*
- [x] `_locales` GraphQL field *(done — returns locale codes where record has content, DatoCMS parity, 2 tests)*
- [x] `_all<Field>Locales` pattern *(done — returns [{locale, value}] for each localized field, DatoCMS parity, 3 tests)*
- [x] Enhanced GraphQL filters *(done — `in`/`notIn` on StringFilter, `isPresent`, `matchesObject` with caseSensitive, 3 tests)*
- [x] MCP `schema_info` power tool *(done — full schema in one call with filtering by name/type and compact mode, 4 tests)*
- [x] MCP `update_model` + `update_field` tools *(done — complete schema CRUD via MCP, 2 tests)*
- [x] Type assertion cleanup *(done — replaced `as` casts with type guards, runtime narrowing, Effect Schema validation)*

### Phase 6: Real-World Parity (informed by ~/Code/trip DatoCMS usage)

- [x] **P6.1** Meta field filtering + ordering *(done — DateTimeFilter on _createdAt/_updatedAt/_publishedAt/_firstPublishedAt, camelCase→snake_case column mapping in filter compiler, 6 tests)*
- [x] **P6.2** N+1 query batching *(done — links/media_gallery use IN queries instead of per-item SELECT, batchFetchAssets/batchFetchRecords/batchResolveLinkedRecords helpers, StructuredText links use same batch path)*
- [x] **P6.3** `_seoMetaTags` auto-generation *(done — generates title, og:title, og:description, og:image, twitter:card, article:modified_time from seo field or heuristic fallback to first string/text/media fields, 4 tests)*
- [x] **P6.5** `_modelApiKey` meta field *(done — exposed on every content type, tested)*
- [x] **P6.6** responsiveImage transforms *(done — accepts `transforms`/`cfImagesParams` with width/height/fit/quality/format/gravity, generates srcSet + webpSrcSet, aspectRatio computed, 4 tests)*
- [x] **P6.7** StructuredText links resolution *(done — itemLink/inlineItem references resolved across all content tables, returned with __typename in links array, 4 tests)*

### Phase 7: Library & CLI (the product)

agent-cms is **not a standalone Worker** — it's a library + CLI that scaffolds a Worker project. The developer owns the Worker, D1, and R2 in their own Cloudflare account.

#### `create-agent-cms` CLI

- [ ] **Scaffolding CLI** — `npx create-agent-cms` interactive setup:
  - Prompts: project name, package manager, R2 bucket name, observability (y/n)
  - Waits for `wrangler` auth if needed
  - Generates: `wrangler.jsonc`, `src/index.ts`, `package.json`, `migrations/`
  - Runs: `wrangler d1 create`, `wrangler d1 migrations apply`, `wrangler r2 bucket create`
  - Verifies: D1 accessible, R2 accessible, Worker deploys
  - Outputs: MCP server URL for Claude Desktop/Code config

- [x] **Library export** *(done — `createCMSHandler(env)` exported, `CmsEnv` type, default export for direct wrangler dev)*

- [x] **MCP HTTP transport** *(done — `/mcp` endpoint using `WebStandardStreamableHTTPServerTransport` from official MCP SDK, stateless mode, verified on wrangler dev with D1: initialize, tools/list, tools/call all work)*

- [x] **MCP config output** *(done — scaffolding CLI prints Claude Desktop/Code config JSON)*

#### Asset Upload (wrangler CLI flow)

- [x] **R2 binding in scaffolded project** *(done — wrangler.jsonc includes R2 bucket, CmsEnv accepts ASSETS R2Bucket)*
- [x] **`upload_asset` MCP tool** *(done — tool description guides agent through wrangler CLI upload flow, accepts r2Key for metadata registration)*
- [x] **Production Cloudflare Image Resizing URLs** *(done — in production: `/cdn-cgi/image/width=W,fit=F,format=auto/<path>`, in dev: query params. Configurable via ASSET_BASE_URL env var.)*

#### Done (DX)

- [x] **TypeScript compiles** — zero `tsc --noEmit` errors
- [x] **GraphiQL playground** — at `GET /graphql`
- [x] **CORS** — all responses, preflight handled
- [x] **Async resolvers** — D1 compatible, verified on `wrangler dev`
- [x] **Wrangler migrations** — `migrations/` dir, `wrangler d1 migrations apply` works
- [x] **Singleton queries** — `homepage { title }` without id/filter
- [x] **`wrangler dev` verified** — full e2e: migrations → REST → GraphQL → GraphiQL

#### Still needed

- [ ] **API key auth** — optional `Authorization: Bearer <key>`. Keys in Workers secrets.
- [ ] **Audit log** — system table tracking schema + content mutations
- [ ] **Error messages with guidance** — suggest next action (e.g. "use `list_models`")

### Scoped out

- **Cache tags / CDN invalidation** — DatoCMS needs this because their API is centralized and every query crosses the internet. With D1 at the edge, queries are colocated and fast (single-digit ms). No CDN layer, no stale data problem, no invalidation protocol needed. Frontend frameworks (Next.js `revalidate`, SWR) handle their own caching. Webhooks on content changes (already implemented) let frontends trigger rebuilds. This entire class of complexity is eliminated by D1's architecture.
- **Schema descriptor KV caching** — same rationale. D1 reads are fast enough; no need for a separate KV cache of the schema descriptor.
- **Blurhash / dominant color extraction** — needs compute Cloudflare doesn't provide natively. Fields exist in schema as nullable for future use.

### Architecture: Typed Field Type Registry

The codebase has a "type sandwich" — top (system tables) and bottom (individual field shapes) are statically known, but field type behavior is scattered across 5+ files with `any` types. A registry would collapse this:

```typescript
// One definition per field type — SQL, GraphQL, Schema, resolver, filter
const ColorFieldType = {
  name: "color",
  sqlType: "TEXT",
  graphqlType: "ColorField",
  schema: ColorInput,        // Effect Schema — validates writes
  resolve: (raw) => ...,     // typed resolver
  filterType: null,           // not filterable
} satisfies FieldTypeDefinition;
```

This is a refactor, not a feature — no user-facing changes. Benefits: exhaustive compile-time checks when adding field types, eliminates scattered if/switch/any patterns, reuses Effect Schemas for both validation and resolver narrowing.

### Future (not prioritized)

- [ ] GraphQL subscriptions for real-time updates
- [ ] Per-field locale argument (`title(locale: en)` override)
- [ ] `_isValid` meta field on records

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
- **P0.10** GraphQL: SDL-based dynamic schema via Yoga `createSchema()`, auto-generated from CMS metadata.
- **P0.10a** MILESTONE: Full Effect migration. Dropped Hono. @effect/platform HttpRouter for HTTP. @effect/sql for all dynamic table operations. Service layer (model/field/record services) as Effect.gen pipelines. Drizzle only for migration SQL generation. 68 tests, -1977/+547 lines. Key pattern: `Effect.flatten(HttpRouter.toHttpApp(router))` for web handler.
- **P0.11** GraphQL filtering, ordering, link resolution, meta fields.
- **P0.12** Link fields with nested GraphQL resolution.
- **P0.13** `[SCHEMA:blog]` Full integration test passing.

---

## Architecture Reference

```
MCP Tools → REST (Hono shell) → Effect pipelines → D1 (SQLite)
                                                                        ↓
                                                    System tables: Drizzle (static, typed)
                                                    Dynamic tables: @effect/sql (runtime SQL)
                                                                        ↓
                                                    GraphQL schema (SDL + Yoga createSchema)
                                                                        ↓
                                                    Yoga (GraphQL Content Delivery API)

Storage: R2 (assets) · D1 (everything else) · No KV needed (D1 edge colocation eliminates caching layer)
Tables:  system (Drizzle) + dynamic content_*/block_* (@effect/sql)
Runtime: Effect (SQL, validation, DI, typed errors) + Hono (HTTP routing)
Test:    @effect/sql-sqlite-node ":memory:" (same SqlClient interface as D1)
```

**API split:** GraphQL for consumers (read), REST for editors/agents (write). Mirrors DatoCMS CDA vs CMA.

**Effect is the runtime:** All business logic runs as Effect pipelines inside Hono handlers. `SqlClient.SqlClient` is the database service for dynamic tables (D1 or sqlite-node, swapped via Layer). `Schema` validates inputs. Typed errors map to HTTP responses via `runEffect()`. Hono is the thin HTTP shell (~14KB, battle-tested on Workers).

**Schema lifecycle:** REST mutation → update system tables (Drizzle) → schema engine diffs → DDL via `@effect/sql` → rebuild GraphQL schema (SDL + Yoga) → serve. → [C11]

**StructuredText storage:** DAST JSON in TEXT column + block rows in `block_*` tables. Blocks store `_root_record_id` (CASCADE) for cleanup. DAST encodes the tree; SQL doesn't track nesting hierarchy. → [C3]

**Draft/publish:** Single row, `_published_snapshot` JSON column. Edit = write to real columns (draft). Publish = copy columns to snapshot. GraphQL `includeDrafts` toggles source. → [C10]
