# MCP Editor Friction Testing — Ideas Backlog

## Confirmed / Learned
- Basic guide → create → publish post flow is already friction-free
- Structured text authoring with `build_structured_text_from_markdown` is already friction-free for simple code-block posts
- `import_asset_from_url` now follows normal public redirects successfully
- Seeded blog schema now includes `post.cover_image`, `post.related_posts`, and `post.gallery`, avoiding schema-mutation detours in common editorial tasks
- Invalid `link` / `links` references now fail fast with a precise `ValidationError`
- Invalid `date` / `date_time` values now fail fast with a precise `ValidationError`
- Invalid `boolean` / `integer` / `float` values now fail fast with a precise `ValidationError`
- Boolean fields now come back as true/false in MCP record responses instead of raw SQLite 1/0 values
- Locale-keyed values on non-localized fields now fail fast with a precise `ValidationError`
- `seo.image` asset references now fail fast with a precise `ValidationError` when the asset ID does not exist
- Media objects that incorrectly use `{id: ...}` instead of `{upload_id: ...}` now fail fast with a schema-aware `ValidationError`
- Link objects that incorrectly use `{id: ...}` instead of a bare record ID string now fail fast with a schema-aware `ValidationError`
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
- Explore script-writing friction further (auth/bootstrap + nested mount points are better documented, and the raw HTTP shapes are clearer now, but standalone script prompts still have some residual friction)

## Script Writing
- Have Claude write a bash script that uses curl to batch-create 5 posts via MCP
- Have Claude write a Node.js script that imports assets from URLs and creates records referencing them

## Edge Cases
- Probe invalid nested/composite payloads that still produce generic type errors instead of schema-aware guidance
