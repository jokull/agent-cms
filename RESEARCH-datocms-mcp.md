# DatoCMS MCP Server Design

Research from github.com/datocms/mcp for designing our own MCP server.

## 3-Layer Architecture (Progressive Disclosure)

The key insight: **save tokens by only returning detail when asked.**

1. **Discovery**: "What exists?" — returns names + one-liners only
2. **Planning**: "How do I use this?" — returns method signatures + types, depth-limited
3. **Execution**: "Do it." — single API calls or multi-step TypeScript scripts

Each tool's description tells the LLM which tool to call next.

## The 11 Tools

### Layer 1 — Discovery (no auth)

| Tool | Input | Returns |
|---|---|---|
| `resources` | none | Grouped list of API resources (namespace, title, description) |
| `resource` | `resource`, `expandDetails?` | Resource description + available actions |

### Layer 2 — Planning (no auth)

| Tool | Input | Returns |
|---|---|---|
| `resource_action` | `resource`, `action`, `expandDetails?` | Action description + TypeScript method signatures |
| `resource_action_method` | `resource`, `method`, `expandTypes?` | Full type definitions for a method |

### Layer 3 — Execution (token required)

| Tool | Input | Returns |
|---|---|---|
| `resource_action_readonly_method_execute` | `resource`, `action`, `method`, `arguments[]`, `jqSelector` | JSON (GET only) |
| `resource_action_destructive_method_execute` | same | JSON (write/delete, non-GET) |
| `schema_info` | `filter_by_name?`, `filter_by_type?`, `fields_details`, `include_fieldsets?`, `include_nested_blocks?`, `include_referenced_models?`, `include_embedding_models?` | Flat JSON array of models/blocks/fields |

### Script Tools

| Tool | Input | Returns |
|---|---|---|
| `create_script` | `name`, `content`, `execute?` | Validation + optional execution output |
| `update_script` | `name`, `replacements[]`, `execute?` | Validation + optional execution output |
| `view_script` | `name`, `start_line?`, `limit?` | TypeScript source |
| `execute_script` | `name` | Execution output |

## Design Patterns to Adopt

### Read vs Write Split
Split execution tools into read-only and destructive. MCP clients can auto-approve reads while prompting for writes.

### `schema_info` is the Power Tool
Returns the full content model in one call — models, blocks, fields, relations. Supports filtering by name/type and depth control for nested blocks/references. This is what agents use most.

### Token Conservation
- `expandDetails` and `expandTypes` params let the LLM request more detail only when needed
- Documentation returned with collapsed `<details>` tags
- Type definitions truncated at depth 2 by default
- `jqSelector` on execute tools to trim response

### Error Messages Guide the LLM
`invariant()` with guidance: "Invalid content type: use `list_content_types` to see available types."

### Script Sandbox
- `export default async function(client: Client)` required
- Whitelist imports: `@datocms/*`, `datocms-*`, `./schema` only
- Reject `any`/`unknown` types via AST inspection
- Auto-generate `schema.ts` from actual content model
- Cap output at ~2KB

## Our MCP Tool Design

### Layer 1 — Discovery
- `list_models` — all models + block types with field summaries
- `describe_model` — full field definitions, validators, relations

### Layer 2 — Schema Management (triggers auto-migration)
- `create_model` / `update_model` / `delete_model`
- `create_field` / `update_field` / `delete_field`

### Layer 3 — Content
- `query_records` (read) — with filter, orderBy, pagination
- `create_record` / `update_record` / `delete_record` (write)
- `publish_record` / `unpublish_record`

### Layer 4 — Assets
- `upload_asset` / `list_assets`

Keep it simpler than DatoCMS (no script system for v1). Focus on the core CRUD + schema operations that agents need.
