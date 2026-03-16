# Schema Lifecycle Testing — Observations & TODOs

Stress-tested against the deployed blog example at `test-blog-cms.solberg.workers.dev` on 2026-03-16.

## What Works Well

- **Block type creation + whitelist update**: Creating a new block type, adding it to a structured_text field's whitelist, embedding it in DAST content, and publishing — all works correctly.
- **`remove_block_type` (MCP)**: Cleans DAST trees in draft AND published records, removes from whitelists, drops the block table and model.
- **`remove_block_from_whitelist` (MCP)**: Removes a block type from a field's whitelist without deleting the type itself. Cleans DAST in both draft and published records.
- **Reference protection on model delete**: Deleting a model that is referenced by link/links fields in other models correctly fails with `"Cannot delete model 'tag': referenced by fields: post.tags"`.
- **Model rename updates link validators AND block whitelists**: Renaming a model's `apiKey` automatically updates `item_item_type` / `items_item_type` validators and `structured_text_blocks` whitelists.
- **GraphQL schema regenerates on rename**: After renaming `category` to `topic`, GraphQL immediately exposes `allTopics` / `topic` queries and the old `allCategories` returns a validation error.
- **Field deletion cleans published snapshots**: Deleting a field strips the field's data from all `_published_snapshot` entries.
- **Field deletion blocks if slug depends on it**: Attempting to delete a field referenced by a slug's `slug_source` returns a 409 error.
- **Field deletion cleans up orphaned block rows**: Deleting a structured_text field also deletes associated block rows from block tables.
- **`remove_locale` (MCP)**: Locale creation and removal works. Strips locale keys from localized field values.
- **Unknown block fallback in frontend**: The Astro site renders "Unknown block: CalloutBoxRecord" instead of crashing when encountering an unrecognized block type in DAST. Graceful degradation.
- **Schema export after lifecycle ops**: `GET /api/schema` returns a clean, correct schema after all operations.
- **Model deletion reports record count**: `deleteModel` returns `recordsDestroyed` in the response indicating how many records were dropped.

## Fixed (2026-03-16)

### P1: Published snapshots now cleaned on block removal (FIXED)

`removeBlockType` and `removeBlockFromWhitelist` now scan and clean `_published_snapshot` JSON in all affected content tables, not just draft records.

### P2: Published snapshots now cleaned on field deletion (FIXED)

`deleteField` now strips the deleted field's key from `_published_snapshot` JSON in all records of that model.

### P4: Slug source field deletion now blocked (FIXED)

`deleteField` checks if any slug fields in the same model reference the field being deleted via `slug_source`. Returns a 409 ReferenceConflictError if so.

### P5: Model deletion now reports destroyed record count (FIXED)

`deleteModel` now counts records before dropping the table and returns `{ deleted: true, recordsDestroyed: N }`.

### Block type rename now updates structured_text whitelists (FIXED)

`updateModel` apiKey rename now also updates `structured_text_blocks` whitelists, not just `item_item_type` / `items_item_type` validators.

### ST field deletion cleans up orphaned block rows (FIXED)

`deleteField` on a structured_text field now deletes associated block rows from all referenced block tables.

## Remaining TODOs

### P3: Model rename breaks frontend without warning

**Renaming a model's `apiKey` is a breaking change for consumers with no guard rails.**

Renaming `category` to `topic` caused the Astro site's `/categories/[slug]` pages to return HTTP 500 because the hardcoded GraphQL queries reference `allCategories` / `category` which no longer exist. The CMS has no way to know about downstream consumers.

**TODO**: Consider one or more of:
- Warn in the `update_model` response when `apiKey` changes that this is a breaking change for GraphQL consumers
- Add a `deprecated` / `alias` mechanism so old query names still resolve during a migration period
- Document in PROMPT.md that model renames require frontend query updates

### P5b: No REST endpoints for schema lifecycle operations

**`remove_block_type`, `remove_block_from_whitelist`, and `remove_locale` are MCP-only.**

These are only accessible via the MCP protocol at `/mcp`. There are no REST API equivalents at `/api/*`. This means non-MCP clients (scripts, CI pipelines, direct HTTP) must craft MCP JSON-RPC calls with the correct `Accept` header, which is awkward.

**TODO**: Consider adding REST endpoints like `DELETE /api/blocks/:apiKey` and `DELETE /api/fields/:id/blocks/:blockApiKey` that map to the same service functions.

## Minor Observations

- **MCP HTTP transport requires `Accept: application/json, text/event-stream`** — without it you get a 406 error. Not obvious from docs.
- **Block IDs in DAST are user-provided** — the system accepts arbitrary IDs like `01HERO00000000000000000001` as block item IDs. This is fine for agent use but could cause collisions if not careful.
- **`allSiteSettingss` (double-s)** — the GraphQL pluralization produces `allSiteSettingss` for the `site_settings` model. Cosmetic but awkward.
