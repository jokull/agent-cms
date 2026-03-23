# Autoresearch: Admin MCP Full-Stack Optimization

## Objective

Optimize the full agent-cms MCP experience — from empty database to designed schema to published content to verifiable preview. Each tick starts with a **completely empty CMS** and uses the **admin MCP** (full access). The agent must design models, create fields, create content, publish, and verify its work on the live site.

This tests what actually matters: can an AI agent build a CMS, populate it, preview its work, and verify the result — using only MCP tools?

**What gets optimized:**
- Tool descriptions and input schemas in `src/mcp/server.ts`
- The `agent-cms://guide` resource
- Error messages in services and tools
- Schema creation workflow (field ordering, validator UX, dependency handling)
- Draft preview workflow (canonicalPathTemplate, get_preview_url, preview tokens)
- Content creation and publication

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

**Structured Text**: build_structured_text (nodes or markdown mode)

**Preview**: get_preview_url (returns preview path + token for draft viewing)

**Search**: search_content, reindex_search

**Site Settings**: get_site_settings, update_site_settings

**Tokens**: editor_tokens

**Resources**: agent-cms://guide, agent-cms://schema

## Task Categories

### Draft preview workflows (primary focus)
The agent should design schema, create content, and then VERIFY its work by checking the live site. This exercises the full draft→preview→publish→verify cycle.

- "Design a blog with posts (title, slug, body, cover_image). Set canonicalPathTemplate to /posts/{slug}. Create a draft post, get a preview URL, then use the preview token to fetch the GraphQL API and confirm the draft is visible. Publish it and fetch again without the token to confirm it's publicly visible."
- "Create a post model with canonicalPathTemplate, create 3 draft posts, get preview URLs for each, then publish them all. Verify via GraphQL that all 3 are now publicly visible."
- "Create a draft post, get its preview URL, update the title, get a fresh preview URL, then publish. Verify the final published title via GraphQL."

### Schema design + content creation
The agent starts with nothing and must design then populate.
- "Design a blog with posts, authors, categories. Posts have titles, slugs, excerpts, cover images, structured text content with code blocks, and belong to one author and one category. Set up preview URL templates. Create 2 sample posts and publish them. Query GraphQL to verify they're live."
- "Design a recipe site with recipes, ingredients, and difficulty levels. Recipes have a title, prep time, cook time, servings, steps (structured text), and a list of ingredients (links). Create 2 recipes, publish, and verify via GraphQL."
- "Design a portfolio site with projects and technologies. Projects have a title, description, cover image, structured text body, tech stack (links to technology records), and a live URL. Create 3 projects, publish, verify."

### Verification via live site
The agent should confirm its work actually landed by querying GraphQL after publishing.
- "Create a post model, create and publish a post titled 'Hello World'. Then query the GraphQL API at https://test-cms.solberg.is/graphql to confirm the post appears in allPosts."
- "Create 3 categories, publish them, then query allCategories via GraphQL and confirm all 3 are returned."

### Multi-step workflows from empty
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
