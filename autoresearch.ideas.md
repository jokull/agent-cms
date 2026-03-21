# MCP Editor Friction Testing — Ideas Backlog

## Confirmed / Learned
- Basic guide → create → publish post flow is already friction-free
- Structured text authoring with `build_structured_text_from_markdown` is already friction-free for simple code-block posts
- `import_asset_from_url` now follows normal public redirects successfully
- Seeded blog schema now includes `post.cover_image`, `post.related_posts`, and `post.gallery`, avoiding schema-mutation detours in common editorial tasks
- Invalid `link` / `links` references now fail fast with a precise `ValidationError`
- Singleton content-model editing is smoother with `update_singleton_record`
- Multi-record publishing is smoother with `bulk_publish_records`
- Multi-record unpublishing is smoother with `bulk_unpublish_records`
- Version diffing is smoother with `compare_record_versions`
- Search result reporting is smoother now that `search_content` includes titles in results
- Inspecting a searched record is smoother with `get_record`
- The numbered benchmark-oriented post titles in the blog seed are intentional fixture data, not accidental duplicate records

## Next Best Bets
- Make the guide more explicit about checking `schema_info` / `describe_model` before assuming example fields
- Probe edge-case error quality for weak spots that still cause extra turns
- Explore script-writing friction further (auth/bootstrap + nested mount points are better documented, but response parsing is still awkward)

## Structured Text
- Create deeply nested structured text with inline links in other nested block combinations

## Publishing Lifecycle
- Publish and unpublish a record, verify status changes via `query_records`

## Search
- Full-text search for content across models

## Script Writing
- Have Claude write a bash script that uses curl to batch-create 5 posts via MCP
- Have Claude write a Node.js script that imports assets from URLs and creates records referencing them

## Edge Cases
- Try to use admin-only tools with an editor token — verify clear error
