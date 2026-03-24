# Autoresearch: Admin MCP Full-Stack Optimization

## Objective

Optimize the full agent-cms MCP experience — from empty database to designed schema to published content to verifiable preview. Each tick starts with a **completely empty CMS** and uses the **admin MCP** (full access). The agent must design models, create fields, create content, publish, and verify its work on the live site.

This tests what actually matters: can an AI agent build a CMS, populate it, preview its work, and verify the result — using only MCP tools?

**What gets optimized:**
- Tool descriptions and input schemas in `src/mcp/server.ts`
- The `agent-cms://guide` resource
- Error messages in services and tools
- Structured text authoring: markdown mode adoption, sentinel format discovery, block format handling
- Content editing: targeted edits via patch_blocks vs full document rewrites
- Schema creation workflow (field ordering, validator UX, dependency handling)

**Constraint: do NOT add new tools without strong evidence.** The 33-tool surface was consolidated after analysis. Prefer improving errors, descriptions, and validation over adding tools.

**Constraint: do NOT modify seed.ts or blog example schema.** There is no seed — each run starts empty. Fixes must be in the CMS code itself (tools, errors, validation, guide).

## Metrics

- **Primary**: `friction_count` (integer, lower is better) — friction points in the dialog
- **Secondary**:
  - `success` (0 or 1)
  - `num_turns` (integer, lower is better)
  - `total_tokens` (integer, lower is better)
  - `cost_usd` (float, lower is better)

## How to Run

```bash
dotenvx run -f examples/blog/cms/.dev.vars -- ./autoresearch.sh "Design a blog with posts. Set canonicalPathTemplate to /posts/{slug}. Create a draft post, get its preview URL, then fetch the live site to verify the draft is visible via the preview token. Publish the post and verify it's visible without the token."
```

The CMS starts **empty** each run — no models, no fields, no content. The agent does everything.

## Deployment

- **CMS URL**: `https://test-cms.solberg.is`
- **Admin MCP**: `https://test-cms.solberg.is/mcp` (full access)
- **GraphQL**: `https://test-cms.solberg.is/graphql`
- **Blog site**: `https://test-blog-site.solberg.workers.dev` (Astro SSR with preview support)

To redeploy after code changes:
```bash
pnpm run build && cd examples/blog/cms && npx wrangler deploy
cd ../site && npx wrangler deploy
```

## Files in Scope

- `src/mcp/server.ts` — tool definitions, descriptions, input schemas, guide resource
- `src/services/*.ts` — business logic and error messages
- `src/errors.ts` — error types and messages
- `src/field-types.ts` — field type registry and validation

## Off Limits

- `src/graphql/` — GraphQL layer
- `src/db/` — database layer
- `src/schema-engine/` — DDL generation
- `examples/blog/seed.ts` — no seed modifications (the point is testing from empty)

## Constraints

- Tests must pass: `npx vitest run`
- TypeScript must compile: `npx tsc --noEmit`
- Build must succeed: `pnpm run build`
- No `as` casts, no `any` types
- Do NOT add new MCP tools without proving existing tools cannot handle the workflow
- Do NOT modify seed.ts or example schemas
- After code changes, redeploy: `pnpm run build && cd examples/blog/cms && npx wrangler deploy`

## Admin MCP Tools (33 tools)

**Schema**: schema_info, create_model, update_model, create_field, update_field, delete_model, delete_field, remove_block, remove_locale, schema_io

**Content**: create_record, update_record, patch_blocks, delete_record, get_record, query_records, bulk_create_records

**Lifecycle**: publish_records, unpublish_records, schedule, record_versions, reorder_records

**Assets**: upload_asset, import_asset_from_url, list_assets, replace_asset

**Structured Text**: markdown mode and typed nodes via create_record/update_record, patch_blocks for partial edits

**Preview**: get_preview_url (returns preview path + token for draft viewing)

**Search**: search_content, reindex_search

**Site Settings**: get_site_settings, update_site_settings

**Tokens**: editor_tokens

**Resources**: agent-cms://guide, agent-cms://schema

## Task Categories

### Structured text + blocks via markdown mode (primary focus)
The agent should use markdown mode for structured_text fields — not hand-assembled DAST. These prompts test whether agents discover and correctly use markdown mode with block sentinels, inline links, and record links.

- "Design a blog with posts (title, slug, body as structured_text). Create an image_block block type with image (media) and caption (string) fields. Create a post with body content that includes 2 paragraphs of prose, a heading, a [link to an external site](https://example.com), and an embedded image_block between paragraphs. Publish and verify via GraphQL."
- "Design a blog post model with structured_text body. Create a 'code_snippet' block type with code (text) and language (string). Write a tutorial post using markdown with **bold**, *italic*, `inline code`, a code_snippet block placed between paragraphs using a sentinel, and a numbered list of steps. Publish and verify."
- "Create a post model and an author model. Create an author record. Write a blog post with structured_text body that includes a [record link to the author](itemLink:AUTHOR_ID) inline in the text, plus a heading and 3 paragraphs. Publish both and verify via GraphQL."
- "Create a blog post with structured_text body containing 3 image_block blocks placed between paragraphs of text. After publishing, use patch_blocks to update one image's caption and delete another block. Publish again and verify."
- "Create a long blog post with 5+ paragraphs, headings, bold/italic text, an external link, and 2 image blocks. Then make a targeted edit: change one link URL and fix a typo in one paragraph. Use markdown mode for the update — do NOT hand-build DAST JSON."

### Structured text with blocks — map vs array format
Test that the agent can pass blocks in any format (array with _type, array with type+data, or map keyed by ID).

- "Design a page model with structured_text content. Create a 'hero' block type with headline (string) and subtitle (string). Create a page record using {markdown, blocks} format where blocks is an object map keyed by block ID (e.g. {\"hero_1\": {\"_type\": \"hero\", \"headline\": \"Welcome\"}}). Verify the content renders correctly via GraphQL."
- "Create the same page using blocks as an array with _type format: [{\"id\": \"hero_1\", \"_type\": \"hero\", \"headline\": \"Welcome\"}]. Verify identical output."

### Draft preview workflows
- "Design a blog with posts (title, slug, body, cover_image). Set canonicalPathTemplate to /posts/{slug}. Create a draft post, get a preview URL, then use the preview token to fetch the GraphQL API and confirm the draft is visible. Publish it and fetch again without the token to confirm it's publicly visible."
- "Create a draft post, get its preview URL, update the title, get a fresh preview URL, then publish. Verify the final published title via GraphQL."

### Schema design + content creation
The agent starts with nothing and must design then populate.
- "Design a blog with posts, authors, categories. Posts have titles, slugs, excerpts, cover images, structured text content with code blocks, and belong to one author and one category. Set up preview URL templates. Create 2 sample posts and publish them. Query GraphQL to verify they're live."
- "Design a recipe site with recipes, ingredients, and difficulty levels. Recipes have a title, prep time, cook time, servings, steps (structured text), and a list of ingredients (links). Create 2 recipes, publish, and verify via GraphQL."

### Multi-step editorial workflows
- "Build a CMS for a restaurant: menu items with prices, categories, a daily special (singleton), and photos. Create the full schema, add 5 menu items across 2 categories, set today's special, publish everything, and verify the menu via GraphQL."
- "Create a documentation site: docs have a title, slug, body (structured text with code blocks), category, and sort order. Create 3 docs in 2 categories, publish, and verify."

### Error recovery
- "Design a post model, create a post with a non-existent author link, then fix the error by creating the author first and retrying."

## What's Already Solved

### Phase 1 (109 runs on editor MCP)
- Single-task editorial flows are friction-free
- Write-time validation for all scalar types
- Precise error messages for wrong field shapes
- Tool surface consolidated from 43 to 33
- Boolean normalization, search titles, singleton shortcuts

### Phase 2 (15 runs on admin MCP from empty)
- Schema design from empty: blog, recipe, portfolio, restaurant, docs, events — all friction-free
- Nested blocks, slug ordering, validator UX — all clean
- Localization setup — friction-free
- Schema import/export round-trip — friction-free
- Only fix needed: XML angle-bracket escaping in structured text code blocks

### Phase 3 (preview + verification)
- Draft preview → publish → GraphQL verification — friction-free
- Preview tokens, canonicalPathTemplate, multi-draft workflows — all clean

### Entering Phase 4: Structured text + block friction
Real-world editorial testing (rvkfoodie.is) revealed agents hand-assemble 100+ line DAST JSON instead of using markdown mode. Root causes fixed:
- Sentinel format `<!-- cms:block:ID -->` was undocumented → now in create_record, update_record, and guide
- update_record had no field format docs → now references create_record
- expandStructuredTextShorthand silently dropped blocks passed as maps or with canonical `_type` format → now accepts both
- Phase 4 focuses on whether agents discover and correctly use markdown mode for prose-heavy content
