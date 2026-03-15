# Challenges

Foreseen technical challenges for agent-cms. Referenced from [ROADMAP.md](./ROADMAP.md).

## C1: Auto-Migration on Schema Changes

DatoCMS auto-migrates when you add/remove/change fields — no manual migration files. Replicating this on D1 (SQLite) means we need to:

- Diff the current schema state against the desired state and emit DDL
- SQLite has extremely limited `ALTER TABLE` — no `DROP COLUMN` (pre-3.35.0), no `ALTER COLUMN`, no `ADD CONSTRAINT`. D1 runs SQLite 3.42+ so `DROP COLUMN` works, but renaming columns and changing types still requires the [12-step recreate](https://www.sqlite.org/lang_altertable.html#otheralter): create new table → copy data → drop old → rename.
- Drizzle has `drizzle-kit` for generating migrations, but we need **runtime diffing**, not CLI-time. Investigate whether `drizzle-kit`'s diff logic can be used programmatically or if we need our own.
- Must handle destructive changes safely: dropping a field that has data, changing field type (e.g., string → integer), removing a model with existing records.
- Transactional DDL: SQLite supports transactional DDL (unlike PostgreSQL for some operations), which is an advantage — wrap multi-step recreates in a transaction.

**Risk:** High — this is the hardest infrastructure piece. Bugs here lose data.

## C2: D1 / SQLite Limitations

- **No ENUM type** — use CHECK constraints or a separate lookup table.
- **No native JSON column type** — SQLite stores JSON as TEXT. Can use `json_extract()`, `json_each()` for queries but no schema-level validation.
- **No ARRAY type** — must use junction tables or JSON arrays in TEXT columns.
- **Row size limits** — D1 has a 1MB row size limit. StructuredText documents with many embedded blocks could hit this if stored inline.
- **No full-text search built-in on D1** — would need to build FTS5 indexes or use a separate search service.
- **Single-writer model** — D1 has one write leader; high-write workloads may bottleneck.
- **No lateral joins / CTEs with DML** — limits some complex query patterns for nested block fetching.
- **Max 10MB database per D1 database on free tier**, 10GB on paid. Large media-heavy CMS projects may need sharding strategy.

## C3: StructuredText / DAST Data Modeling in SQLite

**Decision: Hybrid storage.** DAST tree as JSON in a TEXT column; block instances in their own `block_{type}` tables referenced by ID from the DAST. This mirrors DatoCMS.

**Decision: No separate `rich_text` field type.** Everything is StructuredText. A "modular content" / page-builder field is just a StructuredText field where the validator whitelist restricts to `block` nodes only (no prose). This is a major simplification — one storage model, one resolution path, one set of GraphQL types.

**Block ownership: DAST-as-tree, `_root_record_id` for cascade.** Block rows store `_root_record_id` (FK to the top-level content record with `ON DELETE CASCADE`) and `_root_field_api_key`. They do NOT store their immediate parent — the DAST document itself encodes where each block lives in the tree. This means:
- Deleting a record cascades to all its blocks (any depth) via a single FK
- No polymorphic parent FK needed
- Block nesting structure lives in the DAST JSON, not in SQL columns
- Trade-off: you can't query "blocks that are direct children of block X" in SQL. But we don't need to — the DAST tree handles that.

**Remaining challenges:**
- **DAST validation at write time**: `@effect/schema` matching the DAST spec. Must validate that all `block` and `inlineBlock` node `item` IDs reference real block rows, and that those block types are in the field's whitelist. Validation errors are typed and recoverable via Effect.
- **Block write orchestration**: When writing a StructuredText field, we need to atomically create/update/delete block rows AND update the DAST JSON. The REST API should accept the full StructuredText payload (DAST + block data) and handle the transactional write.
- **GraphQL resolution depth**: Unbounded recursion. A block with a StructuredText field containing more blocks containing more StructuredText... The resolver must walk the DAST, collect all block IDs, fetch them, check if those blocks have StructuredText fields, collect *their* block IDs, and so on until exhausted. This is a recursive batch-fetch pattern, not a JOIN tree.
- **Type safety**: The GraphQL schema must expose `{ value, blocks, links }` where `blocks` is a union of all block types allowed by the field's whitelist. Each block type in the union has its own typed fields — including potentially another StructuredText field with its own `{ value, blocks, links }`.

## C4: Relational Modeling for CMS Primitives

**Decision: Dynamic tables per model.** Each CMS model becomes a real SQLite table (`content_{api_key}`). Each block type also becomes a table (`block_{api_key}`), shared globally (a block type is defined once, reusable across any model's StructuredText field — matches DatoCMS's block library concept).

**Decision: Block rows use `_root_record_id` FK only.** No polymorphic parent tracking. The DAST tree encodes the hierarchy. See [C3] for details.

Remaining challenges:
- **Orphan block cleanup**: If a StructuredText field is updated and a block is removed from the DAST, the block row becomes orphaned. The write path must diff old vs new DAST, identify removed block IDs, and delete them. Recursive — removed blocks might themselves have StructuredText fields with sub-blocks.
- **Block ID assignment**: When creating a record with StructuredText, the agent provides block data inline. We need to assign IDs to blocks before writing, then inject those IDs into the DAST JSON. Or: accept the DAST with temporary/client-generated IDs and remap them server-side.

## C5: Runtime Schema Generation — "Table of Tables"

The core architectural challenge. The system tables (`models`, `fields`) are a **meta-schema** — a "table of tables" that describes all dynamic content/block tables. On every cold start (or schema change), we must:

1. **Read** system tables → get the full CMS schema definition
2. **Generate** Drizzle table definitions in memory (programmatic `sqliteTable()` calls)
3. **Build** GraphQL schema via Pothos (`builder.drizzleObject()` for each model, `builder.unionType()` for block unions, custom StructuredText types)
4. **Serve** via Yoga's dynamic schema support (`schema: () => currentSchema`)

This is essentially a **DDL generator that runs at runtime** — reading metadata and producing SQL to manage content/block tables.

### The approach (updated):

- **Drizzle for system tables only**: The `models`, `fields`, `locales`, `assets` tables use Drizzle's static schema. Type-safe, standard ORM usage.
- **`@effect/sql` for dynamic tables**: Content and block tables are created, altered, and queried via `SqlClient` template literals. No Drizzle codegen for dynamic tables — runtime safety comes from Effect's typed errors and `Schema` validation, not static types. This is the right tool because the schema is unknown at compile time.
- **DDL generation**: Schema engine reads system tables (via Drizzle) → generates CREATE TABLE / ALTER TABLE SQL → executes via `@effect/sql`. Field type → SQL type mapping is a simple function.
- **GraphQL generation**: Schema engine reads system tables → generates SDL strings → feeds to Yoga's `createSchema()`. Resolvers use `@effect/sql` to query dynamic tables.
- **Caching in KV**: Schema descriptor (JSON representation of models + fields) cached in KV. On cold start: check KV → if hit, rebuild GraphQL schema from descriptor. If miss, read system tables and regenerate. Schema version counter for invalidation.
- **`SqlClient.SqlClient` interface**: Same interface for D1 (production) and better-sqlite3 (tests). Application code is portable — only the Layer changes.
- **No eval, no Drizzle codegen for dynamic tables**: Just SQL template literals. Safe, testable, composable with Effect.

### Performance budget:
- Cold start with KV cache hit: ~5-10ms (deserialize descriptor → build Drizzle objects → build GraphQL schema)
- Cold start with KV miss: ~50-100ms (D1 read of system tables → generate → cache → serve)
- Hot path (schema already in memory): 0ms additional cost

**Risk:** Medium-high. The mapping layer between system tables and Drizzle's runtime API is the most novel code in the project. Needs comprehensive tests covering all field types, relations, and edge cases.

## C6: Block Lifecycle and Cascading Deletes

Blocks in DatoCMS are not standalone — they die with their parent record. In SQL:

- FK with `ON DELETE CASCADE` handles this for direct children.
- Nested blocks (block containing a modular content field containing more blocks) need recursive cascade. SQLite supports `PRAGMA foreign_keys = ON` but recursive cascades through JSON references (DAST → block ID) won't trigger FK cascades.
- Need application-level cascade logic for blocks referenced inside DAST documents.

## C7: Localization Without Column Explosion

DatoCMS does field-level localization. For a model with 10 fields and 5 locales, that's potentially 50 values per record.

Options:
- **Column-per-locale**: `title_en`, `title_is`, `title_de` — simple but DDL changes on locale add/remove.
- **Separate localization table**: `record_localizations(record_id, field_api_key, locale, value)` — EAV-like, flexible but slow.
- **JSON column per localized field**: `title: {"en": "Hello", "is": "Halló"}` — reasonable for SQLite, queryable via `json_extract`.
- **Locale-specific rows**: One row per locale per record, with a `locale` column — clean but multiplies row count.

**Recommendation:** For dynamic tables, use JSON columns for localized fields. A field `title` that is localized stores `{"en": "...", "is": "..."}` while a non-localized field stores the raw value directly. This keeps the table structure clean and works with SQLite's JSON functions.

## C8: MCP Tool Design

DatoCMS's MCP uses a clever 3-layer architecture (discover → plan → execute) with only 10 tools. Challenges:

- We need to design tools that are expressive enough for an agent to do everything but constrained enough to prevent destructive mistakes.
- Schema changes trigger auto-migration (C1) — the MCP tool for "add field" must handle DDL generation internally.
- Validation: MCP tools must validate inputs thoroughly since there's no UI safety net.
- Idempotency: Agents may retry operations — schema and content operations should be idempotent where possible.

## C9: Cloudflare Images Integration

Using Cloudflare Images instead of imgix/imgproxy simplifies infra but still needs:

- Generating responsive image metadata (srcSet, sizes) from Cloudflare Image variants or flexible mode URLs.
- Computing blur-up placeholders (base64 LQIP / blurhash) at upload time — Cloudflare Images doesn't do this natively. Need a Worker or queue job to generate on upload.
- Extracting dominant colors at upload time (same — needs compute at ingest).
- Focal point cropping — Cloudflare Images supports `fit=crop` with `gravity` but not arbitrary focal point coordinates. May need to map focal point (x,y) → gravity or use trim/crop parameters.

## C10: Draft/Published Workflow

Every content table has `_status` (`draft`, `published`, `updated`), `_published_at`, `_first_published_at`.

**The "updated" state problem:** When a published record is edited, it enters `updated` state — the published version should still be served to consumers, but the draft changes should be visible with `includeDrafts`. Two storage approaches:

1. **Single row, status flag:** One row per record. `_status = updated` means the current row IS the draft. But then: what do non-draft consumers see? The published version is gone (overwritten). This doesn't work.

2. **Dual row / shadow table:** When a published record is edited, we keep the published row intact and create a draft shadow row. The `_status` on the original stays `updated` (signals "has unpublished changes"). The draft row stores the pending edits. Publishing = replace the original with the shadow, delete the shadow. This requires either:
   - A `_draft_of` FK column pointing to the published record's ID
   - Or a separate `content_{model}_drafts` table

   The dual-row approach adds complexity to every query (filter out drafts unless `includeDrafts`), every write (check if draft shadow exists), and every schema migration (shadow tables must mirror content tables).

3. **JSON snapshot:** Store the published version as a JSON snapshot column (`_published_snapshot JSON`) on the single row. Editing writes to the real columns (the "draft"), publishing copies current columns into the snapshot. Non-draft consumers read from the snapshot column. Simpler than dual rows, but:
   - Requires custom GraphQL resolution (read from snapshot vs columns based on `includeDrafts`)
   - Snapshot must be kept in sync with schema changes (adding a field means updating all snapshots)

**Recommendation for v1:** Option 3 (JSON snapshot) is simplest to implement. The trade-off (schema sync for snapshots) is manageable — on field addition, snapshots don't need updating (new field is absent = null). On field removal, snapshots can be lazily cleaned. Publishing rewrites the snapshot from current columns.

## C11: Schema Lifecycle — Cascading Effects of Schema Changes

Schema changes aren't just DDL. Every model/field/block-type mutation has ripple effects across existing content. These must be handled atomically or the CMS ends up in an inconsistent state.

### Block type removal

When deleting a block type:
1. Scan all `fields` where `field_type = 'structured_text'` and the block type is in the `structured_text_blocks` validator whitelist
2. For each affected field, scan all records — walk their DAST to find `block`/`inlineBlock` nodes referencing this block type
3. Remove those nodes from the DAST (and recursively remove any sub-blocks they contained)
4. Update the DAST JSON on each affected record
5. Remove the block type from all field whitelists
6. Drop the `block_{type}` table
7. Remove the model row from `models`

This is a multi-table, multi-record write. Must be transactional or at least idempotent/resumable.

### Field removal from a model

When deleting a field:
- **Simple field** (string, integer, etc.): drop the column from `content_{model}` table. Straightforward.
- **StructuredText field**: drop the column AND delete all block rows where `_root_field_api_key` matches this field across all records of this model. Must scan block tables for `_root_record_id IN (SELECT id FROM content_{model})` AND `_root_field_api_key = '{field}'`.
- **Link field**: drop the column. But also: any *other* model's StructuredText that uses `itemLink`/`inlineItem` nodes pointing to records of *this* model via `structured_text_links` validator — those references become dangling. Do we cascade-clean them or just let them 404 at query time?

### Model removal

When deleting a model:
1. All records in `content_{model}` are deleted (CASCADE handles blocks via `_root_record_id`)
2. But: other models may have `link`/`links` fields pointing to this model. Those FKs become invalid. Must either:
   - Prevent deletion if references exist (safe but annoying)
   - Nullify link fields in other models that reference this model (data loss but clean)
   - Remove the model from `items_item_type` validators on link fields in other models
3. StructuredText `itemLink`/`inlineItem` nodes across the entire CMS may reference records of this model. Same problem — dangling references in DAST JSON across unrelated models.
4. Drop the `content_{model}` table
5. Remove all `fields` rows for this model
6. Remove the `models` row

### Field type change

Changing a field's type (e.g., `string` → `integer`, or `string` → `structured_text`):
- Requires the 12-step SQLite table recreate (new column type)
- Data coercion: what happens to existing values? Options:
  - Reject if data can't be coerced (safe)
  - Coerce with best effort, null on failure
  - Require the field be empty before type change (simplest — good for v1)
- Changing TO `structured_text`: new column is TEXT, existing data is lost or must be wrapped in a minimal DAST document
- Changing FROM `structured_text`: must delete all associated block rows first

### Adding a required field to a model with existing records

- New column needs a default value, or all existing records fail validation
- Options: reject (require default_value in field config), auto-populate with default, or allow null temporarily and mark records as invalid
- DatoCMS approach: adding a required field to a model with records requires providing a default value

### Renaming a model or field `api_key`

- Model rename: `content_{old_key}` table must be renamed to `content_{new_key}`. SQLite supports `ALTER TABLE ... RENAME TO`. But:
  - All block rows with `_root_field_api_key` referencing fields of this model still use the old table for their `_root_record_id` FK — FK targets change if the table name changes
  - Other models' link fields may store the model api_key in validators — must update `items_item_type` validators
- Field rename: column rename in the content table. SQLite 3.25+ supports `ALTER TABLE ... RENAME COLUMN`. But:
  - If this is a StructuredText field, block rows reference it via `_root_field_api_key` — must update all matching block rows across all block tables
  - Schema descriptor in KV must be invalidated

### Locale addition/removal

- Adding a locale: localized fields (stored as JSON `{"en": "..."}`) don't need schema changes (JSON is flexible). But: should all existing records get a null entry for the new locale, or is absence-of-key acceptable? Absence is simpler.
- Removing a locale: must strip that locale's key from all localized field values across all records of all models. This is a full table scan + JSON rewrite for every model with localized fields.

### Adding a block type to a StructuredText field's whitelist

- No data migration needed — existing DAST documents don't reference the new type yet. Just update the validator.
- But: must regenerate the GraphQL schema (the block union type for this field now has a new member).

### Removing a block type from a whitelist (without deleting the block type)

- Must scan all records of the model, walk DAST for this field, find and remove block/inlineBlock nodes of the removed type
- Recursively delete sub-blocks of removed blocks
- Update DAST JSON
- Regenerate GraphQL schema (union type shrinks)
