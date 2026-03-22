# MCP Full-Stack Friction Testing — Ideas Backlog

## Phase 2 — Schema Design + Content (from empty CMS)

### High priority
- Blog with posts, authors, categories, structured text with blocks
- Recipe site with ingredients (links), steps (structured text), difficulty
- Portfolio with projects, technologies, cover images
- Schema ordering: slug after source field, block types before structured text fields
- Validator UX: required fields, enum constraints, date ranges, slug_source

### Medium priority
- Singleton setup (site settings with custom fields)
- Schema import/export round-trip
- Error recovery: wrong field order, missing validators, dangling links

### Lower priority
- Complex block nesting: sections containing cards containing structured text
- Bulk content creation after schema design
- Search after content creation

## Anti-patterns
- Do NOT modify seed.ts — the CMS starts empty each run
- Do NOT add new tools without proving existing tools can't handle it
- Do NOT over-tune guide text for one specific prompt
