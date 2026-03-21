# MCP Editor Friction Testing — Ideas Backlog

## Confirmed / Learned
- Basic guide → create → publish post flow is already friction-free
- Structured text authoring with `build_structured_text_from_markdown` is already friction-free for simple code-block posts
- `import_asset_from_url` now follows normal public redirects successfully
- Seeded blog schema now includes `post.cover_image`, `post.related_posts`, and `post.gallery`, avoiding schema-mutation detours in common editorial tasks

## Next Best Bets
- Make the guide more explicit about checking `schema_info` / `describe_model` before assuming example fields
- Probe edge-case error quality for weak spots that still cause extra turns
- Test publishing/scheduling workflows for status/validation confusion

## Content CRUD
- Update specific fields on existing records (`reading_time`, `featured`)
- Delete a post and verify it's gone
- Bulk create multiple category records
- Create a record with all currently seeded post field types: string, text, integer, boolean, date, media, link, seo, structured_text

## Structured Text
- Patch specific blocks in existing structured text without replacing the whole field
- Create deeply nested structured text with inline links
- Convert long markdown (1000+ words) to structured text
- Create structured text referencing a block type not whitelisted on the field

## Publishing Lifecycle
- Publish and unpublish a record, verify status changes via `query_records`
- Schedule a future publish date
- Edit a published post (should create updated/draft state), verify draft vs published views
- List version history, restore a previous version

## Assets
- Import an asset from a redirecting public URL and attach it as `cover_image`
- Import an asset from a direct public URL and set alt/title metadata
- Replace an asset's metadata

## Search
- Full-text search for content across models

## Multi-Step Workflows
- "Write a blog post about Effect TypeScript" — full workflow from schema discovery to published post
- Update site settings (`site_name`, `tagline`, SEO)
- Reorganize: create new categories, reassign posts to them

## Script Writing
- Have Claude write a bash script that uses curl to batch-create 5 posts via MCP
- Have Claude write a Node.js script that imports assets from URLs and creates records referencing them

## Edge Cases
- Reference a non-existent record ID in a link field
- Try to use admin-only tools with an editor token — verify clear error
