# Autoresearch: Editor MCP Friction Optimization

## Objective

Hill-climb towards the perfect editor MCP experience. The loop explores the edges of what an editor agent should be able to do — add images to posts, reorder content, create rich blog posts, manage publishing schedules, build structured text with blocks, browse version history, revert changes — and optimizes the MCP surface until these flows are smooth and efficient.

When a Claude agent connected via MCP has "wheels spinning" on a task (too many tool calls, wrong tool choice, confusion, poor errors), make code changes to reduce that friction. When a new editorial capability is needed, **add it** — new MCP tools, richer tool descriptions, better error messages, expanded guide content, or new features in the CMS services.

**What gets optimized:**
- Tool names, descriptions, and input schemas in `src/mcp/server.ts`
- The `agent-cms://guide` resource (orientation, workflow hints, field format docs)
- Error messages in services and tools
- MCP prompt templates
- New editor MCP tools and features (version history browsing, change reverting, diff viewing, etc.)
- The blog example schema (new models, fields, block types to support richer editorial flows)
- The blog seed script and PROMPT.md

**The keep/discard cycle — MCP runs are unit tests:**

Each MCP run is like a test case. When it's RED (friction found):
1. Run an editorial task through claude with editor MCP → observe friction
2. Make code changes to fix the friction (better tools, descriptions, errors, new features)
3. Re-run the **SAME task** to verify friction is reduced → GREEN
4. **Keep** if the same task now works better, **discard** if not
5. Move to a harder task

The key: always re-run the same prompt after making improvements. The before/after comparison on the same task is what proves the improvement is real.

## Metrics

- **Primary**: `friction_count` (integer, lower is better) — number of friction points in the claude dialog (errors, confusion, unnecessary tool calls, wrong tool choices, unclear field formats, excessive round-trips)
- **Secondary**:
  - `success` (0 or 1) — whether the claude subprocess completed the task
  - `total_tokens` (integer, lower is better) — total tokens consumed by the editor MCP session (input + output). A well-guided MCP surface means fewer discovery round-trips, less schema exploration, and more direct tool usage.
  - `output_tokens` (integer, lower is better) — output tokens only; measures how much "thinking" the agent needed
  - `cost_usd` (float, lower is better) — dollar cost of the session
  - `num_turns` (integer, lower is better) — number of conversation turns; fewer turns = more efficient tool sequencing

## How to Run

```bash
dotenvx run -f examples/blog/cms/.dev.vars -- ./autoresearch.sh "Read the agent-cms://guide resource, then create a post with title 'Test' and publish it."
```

The write key lives in `examples/blog/cms/.dev.vars` (`CMS_WRITE_KEY`). Always use `dotenvx run -f examples/blog/cms/.dev.vars --` to wrap commands that need it.

Outputs the full claude dialog plus `METRIC` lines (evaluated by codex).

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

### MCP Surface (tool descriptions, guides, errors, NEW FEATURES)
- `src/mcp/server.ts` — **primary target**: tool definitions, descriptions, input schemas, validation. ADD new editor tools here.
- `src/mcp/guide.ts` or wherever the `agent-cms://guide` resource content lives — orientation text, workflow hints
- `src/mcp/prompts/` — MCP prompt templates
- `src/services/*.ts` — business logic and error messages. ADD new service methods for new features.
- `src/errors.ts` — error types and messages

### Feature Expansion (new editor capabilities)
- `src/services/record-service.ts` — record CRUD, version management
- `src/services/publish-service.ts` — publish/unpublish, scheduling
- `src/services/asset-service.ts` — asset management
- `src/services/schema-io-service.ts` — schema import/export

### Schema Evolution (via admin MCP or seed script)
- `examples/blog/seed.ts` — add new models, fields, block types
- `examples/blog/PROMPT.md` — project-specific agent lifecycle prompt
- The live CMS schema — use admin MCP to create_model, create_field, etc.

### Instrumentation
- `autoresearch.sh` — the tick script itself
- `autoresearch.ideas.md` — ideas backlog

## Off Limits

- `src/graphql/` — GraphQL layer (separate optimization)
- `src/db/` — database layer
- `src/schema-engine/` — DDL generation
- Published fast path, filter compiler

## Constraints

- Tests must pass: `npx vitest run`
- TypeScript must compile: `npx tsc --noEmit`
- Build must succeed: `pnpm run build`
- No `as` casts, no `any` types
- Effect patterns (consult `~/Forks/effect-solutions/`)
- GraphQL API must return identical responses
- MCP protocol compatibility must be maintained
- After code changes, redeploy: `pnpm run build && cd examples/blog/cms && npx wrangler deploy`

## Editor MCP Tools (29 tools)

**Read**: list_models, describe_model, schema_info, query_records, list_record_versions, get_record_version, list_assets, search_content, get_site_settings, export_schema

**Write**: create_record, update_record, patch_blocks, bulk_create_records, publish_record, unpublish_record, schedule_publish, schedule_unpublish, clear_schedule, restore_record_version, reorder_records, build_structured_text, build_structured_text_from_markdown, upload_asset, import_asset_from_url, replace_asset, update_site_settings

**Delete**: delete_record

**Resources**: agent-cms://guide (orientation), agent-cms://schema (current schema JSON)

**Prompts**: setup-content-model, generate-graphql-queries

### Feature gaps to explore and fill
- **Diff viewing**: compare two versions of a record side by side
- **Bulk publish/unpublish**: operate on multiple records at once
- **Record duplication**: clone an existing record
- **Content preview**: see what the published version looks like vs draft
- **Asset metadata enrichment**: auto-fill alt text, detect dimensions from URL
- **Undo last change**: quick revert to previous state without browsing versions

## Blog Example Schema

Models: site_settings (singleton), author (singleton), category, post
Block types: hero_section, code_block (and possibly feature_card, feature_grid from seed)
Key post fields: title, slug, excerpt, cover_image (media), content (structured_text), author (link), category (link), related_posts (links), published_date (date), seo_field (seo), gallery (media_gallery), reading_time (integer), featured (boolean)

## Task Categories (rotate through these)

- **content_crud**: Create/update/delete records — exercises field format documentation
- **structured_text**: Build complex content with blocks — exercises build_structured_text tool
- **publishing**: Publish/unpublish/schedule — exercises lifecycle tools
- **version_history**: Browse versions, restore, revert changes — exercises version tools
- **assets**: Import/upload/reference — exercises asset workflow
- **search**: Full-text search — exercises search_content tool
- **workflow**: Multi-step editorial tasks — exercises tool sequencing and schema discovery
- **script**: Write scripts that orchestrate MCP calls — exercises tool composability
- **edge_case**: Invalid inputs — exercises error message quality
- **new_features**: Test gaps in editor capabilities, propose and implement new tools

## What's Been Tried

### Runs 1-5 (pre-fix)
- Basic create → publish post: friction-free (run #3)
- Structured text from markdown with code_block: friction-free (run #4)
- Asset import with redirecting URLs: friction found but fix was reverted by checks_failed (run #5)
- All improvements reverted because pre-existing test failures blocked `keep`
- Tests fixed, ready to iterate for real
