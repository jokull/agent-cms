# MCP Full-Stack Friction Testing — Ideas Backlog

## Phase 2 — Schema Design + Content (from empty CMS)

### Already probed cleanly
- Blog with posts, authors, categories, structured text with blocks
- Recipe site with ingredients (links), steps (structured text), difficulty
- Portfolio with projects, technologies, cover images
- Schema ordering: slug after source field, block types before structured text fields
- Validator UX: required fields, date ranges, slug_source
- Singleton setup (daily special / site settings style flows)
- Error recovery: dangling links
- Complex nested blocks: structured text containing blocks with nested structured text

### Still promising
- Schema import/export round-trip on an empty CMS, then create/publish content against the imported schema
- Bulk content creation after schema design (larger batches, then bulk publish)
- Search after content creation from an empty CMS (verify indexing/reindex guidance in a schema+content workflow)
- Enum validator UX from empty CMS (author a constrained field, trigger a bad value, recover cleanly)
- Missing-dependency recovery from empty CMS (attempt structured_text before block whitelist / create slug before source field, then recover)
- Localization setup from empty CMS (create locales, localized fields, publish translated content)

## Anti-patterns
- Do NOT modify seed.ts — the CMS starts empty each run
- Do NOT add new tools without proving existing tools can't handle it
- Do NOT over-tune guide text for one specific prompt
