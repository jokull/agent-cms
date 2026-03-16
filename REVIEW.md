# Code Review

Automated review via OpenAI Codex (gpt-5.4), 2026-03-16.

## P1 — Must fix

### 1. Required field addition leaves half-applied schema on validation failure
**`src/services/field-service.ts:78-107`**

When `validators.required` is set on a new field and the model has records, the code inserts the field row and alters the content table BEFORE checking whether `defaultValue` was provided. If it fails with 400, the column/metadata are already persisted. A retry then fails as a duplicate.

**Fix:** Validate `defaultValue` presence before any DB mutations.

### 2. Deleting a block model skips DAST cleanup
**`src/services/model-service.ts:167-195`**

`DELETE /api/models/:id` on a block type drops the block table immediately without removing block nodes from stored DAST documents or field whitelists. Existing records keep stale block references that no longer resolve.

**Fix:** Reject deletion if block type is referenced, or delegate to `removeBlockType()`.

### 3. Whitelist cleanup scopes by field api_key only, not model
**`src/services/schema-lifecycle.ts:130-158`**

The cleanup query keys only on `_root_field_api_key`. If another model has a structured-text field with the same API key, removing a block from one whitelist deletes block rows belonging to the other model.

**Fix:** Add `_root_record_id` or model-level scoping to the cleanup queries.

### 4. GraphQL SQL filters ignore locale for localized fields
**`src/graphql/schema-builder.ts:739-750`**

`compileFilterToSql()` and `compileOrderBy()` are called without `fieldIsLocalized` or `locale`. For localized fields, filtering/ordering compares the raw JSON blob instead of the selected locale value. `allPosts(locale:"is", filter:{title:{eq:"Halló"}})` returns wrong rows.

**Fix:** Pass `fieldIsLocalized` callback and `locale` from context to filter/order compilation.

### 5. Shared mutable context for locale selection causes cross-query contamination
**`src/graphql/schema-builder.ts:809-820`**

Query resolvers store `args.locale` by mutating the shared request context. If a single GraphQL operation has two root fields with different locales, nested resolvers read whichever locale was written last.

**Fix:** Pass locale via the parent record or a per-branch context, not shared mutation.

## P2 — Should fix

### 6. catchAll collapses all REST errors into 404
**`src/http/router.ts:287-289`**

The top-level `catchAll` converts any handler failure into `404 Not found`, not just missing routes. Malformed JSON bodies show as "Not found" and real server issues are masked.

**Fix:** Only return 404 for route-not-found. Let other errors propagate to the error handler.

### 7. REST locale deletion skips field value cleanup
**`src/services/locale-service.ts:40-45`**

`DELETE /api/locales/:id` only removes the locale row. The schema-lifecycle `removeLocale` tool also strips that locale key from every localized field value. REST users get orphaned locale entries.

**Fix:** Call the lifecycle cleanup from the REST endpoint too.

### 8. `hasDraft: false` models still create records as draft
**`src/services/record-service.ts:77-82`**

New records always get `_status = 'draft'` regardless of `hasDraft`. For models where drafts are disabled, content is hidden until explicitly published.

**Fix:** When `hasDraft` is false, set initial status to `'published'`.
