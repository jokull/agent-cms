# Autoresearch: Admin MCP Full-Stack Optimization

## Objective

Optimize the full agent-cms MCP experience — from empty database to designed schema to published content. Each tick starts with a **completely empty CMS** and uses the **admin MCP** (full access). The agent must design models, create fields, create content, and publish — exercising the entire tool surface.

This tests what actually matters: can an AI agent build and populate a CMS from scratch using only the MCP tools?

**What gets optimized:**
- Tool descriptions and input schemas in `src/mcp/server.ts`
- The `agent-cms://guide` resource
- Error messages in services and tools
- Schema creation workflow (field ordering, validator UX, dependency handling)
- Content creation after schema design

**Constraint: do NOT add new tools without strong evidence.** The 32-tool surface was consolidated after analysis. Prefer improving errors, descriptions, and validation over adding tools.

**Constraint: do NOT modify seed.ts or blog example schema.** There is no seed — each run starts empty. If a task requires specific schema, the agent creates it. Fixes must be in the CMS code itself (tools, errors, validation, guide).

## Metrics

- **Primary**: `friction_count` (integer, lower is better) — friction points in the dialog
- **Secondary**:
  - `success` (0 or 1)
  - `num_turns` (integer, lower is better)
  - `total_tokens` (integer, lower is better)
  - `cost_usd` (float, lower is better)

## How to Run

```bash
dotenvx run -f examples/blog/cms/.dev.vars -- ./autoresearch.sh "Design a blog with posts, authors, categories. Create 2 sample posts with structured text content and publish them."
```

The CMS starts **empty** each run — no models, no fields, no content. The agent does everything.

## Deployment

- **CMS URL**: `https://test-cms.solberg.is`
- **Admin MCP**: `https://test-cms.solberg.is/mcp` (full access)
- **GraphQL**: `https://test-cms.solberg.is/graphql`

To redeploy after code changes:
```bash
pnpm run build && cd examples/blog/cms && npx wrangler deploy
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

## Admin MCP Tools (32 tools)

**Schema**: schema_info, create_model, update_model, create_field, update_field, delete_model, delete_field, remove_block, remove_locale, schema_io

**Content**: create_record, update_record, patch_blocks, delete_record, get_record, query_records, bulk_create_records

**Lifecycle**: publish_records, unpublish_records, schedule, record_versions, reorder_records

**Assets**: upload_asset, import_asset_from_url, list_assets, replace_asset

**Structured Text**: build_structured_text (nodes or markdown mode)

**Search**: search_content, reindex_search

**Site Settings**: get_site_settings, update_site_settings

**Tokens**: editor_tokens

**Resources**: agent-cms://guide, agent-cms://schema

## Task Categories

### Schema design + content creation (primary focus)
The agent starts with nothing and must design then populate.
- "Design a blog with posts, authors, categories. Posts have titles, slugs, excerpts, cover images, structured text content with code blocks, and belong to one author and one category. Create 2 sample posts and publish them."
- "Design a recipe site with recipes, ingredients, and difficulty levels. Recipes have a title, prep time, cook time, servings, steps (structured text), and a list of ingredients (links). Create 2 recipes and publish."
- "Design a portfolio site with projects and technologies. Projects have a title, description, cover image, structured text body, tech stack (links to technology records), and a live URL. Create 3 projects and publish."

### Schema design edge cases
Tests whether the agent handles ordering, validators, and dependencies correctly.
- "Create a blog post model where the slug auto-generates from title, content allows hero_section and code_block blocks, and posts link to an author model."
- "Create an event model with a required title, date range validation (future dates only), a venue link, and an image gallery."

### Multi-step workflows from empty
- "Build a CMS for a restaurant: menu items with prices, categories, a daily special (singleton), and photos. Create the full schema, add 5 menu items across 2 categories, set today's special, and publish everything."
- "Create a documentation site: docs have a title, slug, body (structured text with code blocks), category, and sort order. Create 3 docs in 2 categories and publish."

### Error recovery
- "Design a post model, create a post with a non-existent author link, then fix the error by creating the author first and retrying."

## What's Already Solved (Phase 1 — 109 runs on editor MCP)

- Single-task editorial flows are friction-free
- Write-time validation for all scalar types
- Precise error messages for wrong field shapes
- Tool surface consolidated from 43 to 32
- Boolean normalization, search titles, singleton shortcuts
