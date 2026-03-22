# Autoresearch: Editor MCP Workflow Optimization

## Objective

Optimize the editor MCP for **multi-step, realistic editorial workflows**. The single-task editorial surface is now well-optimized (95 runs, friction near zero on simple tasks). The next frontier is complex, multi-step, and multi-turn scenarios that expose sequencing issues, recovery friction, and schema design gaps.

**What gets optimized:**
- Tool descriptions and input schemas in `src/mcp/server.ts`
- The `agent-cms://guide` resource (workflow hints, sequencing guidance)
- Error messages in services and tools
- The blog example schema (richer models/fields to support complex workflows)
- The blog seed script

**Constraint: do NOT add new tools without strong evidence.** The current 32-tool surface was consolidated from 43 after analysis showed most friction comes from error quality, validation, and documentation — not missing tools. Adding a tool has near-zero token cost but increases selection ambiguity. Prefer improving existing tools, errors, and docs over adding new ones.

**The keep/discard cycle:**

1. Run a workflow through Claude with editor MCP → observe friction
2. Make code changes to fix the friction (better errors, descriptions, validation)
3. Re-run the **SAME task** to verify friction is reduced
4. **Keep** if the same task now works better, **discard** if not
5. Move to a harder task

## Metrics

- **Primary**: `friction_count` (integer, lower is better) — friction points in the dialog (errors, confusion, unnecessary tool calls, wrong tool choices, excessive round-trips, wheels spinning)
- **Secondary**:
  - `success` (0 or 1) — whether the task completed
  - `num_turns` (integer, lower is better) — fewer turns = more efficient sequencing
  - `total_tokens` (integer, lower is better) — fewer tokens = less discovery overhead
  - `cost_usd` (float, lower is better) — session cost

## How to Run

```bash
dotenvx run -f examples/blog/cms/.dev.vars -- ./autoresearch.sh "your task prompt here"
```

## Deployment

- **CMS URL**: `https://test-cms.solberg.is`
- **Admin MCP**: `https://test-cms.solberg.is/mcp` (full access)
- **Editor MCP**: `https://test-cms.solberg.is/mcp/editor` (content ops only)
- **GraphQL**: `https://test-cms.solberg.is/graphql`
- **Auth**: `Authorization: Bearer <key>`. Editor tokens (`etk_*`) for `/mcp/editor`, admin writeKey for both.

To redeploy after code changes:
```bash
pnpm run build
cd examples/blog/cms && npx wrangler deploy
```

## Files in Scope

### MCP Surface
- `src/mcp/server.ts` — tool definitions, descriptions, input schemas, guide resource
- `src/services/*.ts` — business logic and error messages
- `src/errors.ts` — error types and messages

### Schema / Seed
- `examples/blog/seed.ts` — models, fields, block types, sample content
- The live CMS schema — mutated via admin MCP

### Instrumentation
- `autoresearch.sh` — the tick script
- `autoresearch.ideas.md` — ideas backlog

## Off Limits

- `src/graphql/` — GraphQL layer (separate optimization)
- `src/db/` — database layer
- `src/schema-engine/` — DDL generation

## Constraints

- Tests must pass: `npx vitest run`
- TypeScript must compile: `npx tsc --noEmit`
- Build must succeed: `pnpm run build`
- No `as` casts, no `any` types
- Effect patterns (consult `~/Forks/effect-solutions/`)
- Do NOT add new MCP tools without proving existing tools cannot handle the workflow
- After code changes, redeploy: `pnpm run build && cd examples/blog/cms && npx wrangler deploy`

## Editor MCP Tools (22 editor tools)

**Read**: schema_info, get_record, query_records, list_assets, search_content, get_site_settings

**Write**: create_record, update_record (recordId optional for singletons), patch_blocks, bulk_create_records, publish_records, unpublish_records, schedule, record_versions, reorder_records, build_structured_text (nodes or markdown mode), upload_asset, import_asset_from_url, replace_asset, update_site_settings

**Delete**: delete_record

**Mixed**: schema_io (export only on editor)

**Resources**: agent-cms://guide (orientation), agent-cms://schema (current schema JSON)

**Prompts**: setup-content-model, generate-graphql-queries

## Task Categories — Phase 2

The single-task surface is solved. Focus on these harder scenarios:

### Multi-step workflows with dependencies
Tasks that require 10+ tool calls with ordering constraints. Tests whether the agent sequences correctly without unnecessary detours.
- "Create a new author, import their headshot from URL, create 3 posts by that author with cover images and structured text content, link them to an existing category, and publish everything."
- "Set up a 'recipe' content model with ingredients (links to a new ingredient model), steps (structured text), and a cover photo. Create 2 sample recipes with real ingredients and publish them."

### Correction and recovery flows
Real editorial work is messy — things go wrong and need fixing.
- "The post titled 'X' has the wrong cover image — replace it with this URL. Also fix the typo in the excerpt and republish."
- "I published the wrong version of post 'X'. Revert it to the previous version and republish."
- "Three posts were accidentally published. Unpublish them, update their titles to add '[DRAFT]' prefix, and leave them as drafts."

### Multi-turn conversation patterns
The loop currently resets per run. But real editors iterate. Test whether the agent handles sequential refinements gracefully.
- Turn 1: "Create a post about TypeScript" → Turn 2: "Actually change the title to something catchier" → Turn 3: "Add a code block to the content" → Turn 4: "Publish it"

### Schema design (admin MCP)
Test the admin surface for the first time. Schema design is a rich domain.
- "I need a recipe blog. Design the content models for recipes, ingredients, categories, and difficulty levels. Create the schema and seed it with 2 sample recipes."
- "Add a 'testimonials' block type that can be embedded in structured text fields. It should have author name, quote text, and an optional avatar image."

### Edge cases and error recovery
Push the boundaries of validation and error handling.
- "Create a post with an invalid date, a non-existent author link, and a malformed structured text field — I want to see what errors I get."
- "Try to publish a draft-enabled record that's missing required fields. What happens?"

## What's Already Solved (Phase 1 — 95 runs)

Single-task editorial flows are friction-free:
- Create/publish posts, structured text authoring, asset imports, version restore, search, scheduling, bulk operations, singleton editing, nested block patching

Validation/error quality improvements shipped:
- Write-time validation for booleans, integers, floats, dates
- Precise errors for wrong field shapes ({id:...} on links/media)
- SEO image validation, link reference validation, locale detection
- Boolean normalization in responses, search titles

Tool consolidation (43 → 32):
- Merged ambiguous single/bulk variants (publish_records, unpublish_records)
- Merged overlapping tools (schedule, record_versions, build_structured_text, schema_io, editor_tokens, remove_block)
- Dropped redundant tools (list_models, describe_model → schema_info)
- Made update_record handle singletons (optional recordId)

## Blog Example Schema

Models: site_settings (singleton), author (singleton), category, post
Block types: hero_section, code_block, feature_card, feature_grid
Key post fields: title, slug, excerpt, cover_image (media), content (structured_text), author (link), category (link), related_posts (links), published_date (date), seo_field (seo), gallery (media_gallery), reading_time (integer), featured (boolean)
