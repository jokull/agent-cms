# MCP Full-Stack Friction Testing — Ideas Backlog

## Phase 3 — Preview + Verification (from empty CMS)

### High priority (preview workflow)
- Draft → get_preview_url → verify via GraphQL with X-Preview-Token → publish → verify without token
- Multiple drafts → preview URLs for each → bulk publish → verify all visible
- Update draft title → get fresh preview URL → verify updated content → publish
- canonicalPathTemplate with nested paths: /docs/{category}/{slug}

### High priority (live site verification)
- Create schema + content → query GraphQL to confirm published records appear
- Publish → query allPosts → confirm title, slug, status match what was created
- Unpublish → query again → confirm record disappeared from public GraphQL
- Draft with preview token → query GraphQL with X-Preview-Token → confirm draft visible

### Medium priority
- Preview token expiry: create token with short TTL, wait, verify it's rejected
- canonicalPathTemplate on multiple models (posts, categories) → verify each resolves correctly
- Structured text content → publish → query GraphQL → verify content.value is valid DAST

### Already probed cleanly (phase 2)
- Blog, recipe, portfolio, restaurant, docs, events schema design from empty
- Nested blocks, slug ordering, validator UX
- Localization setup and drift QA
- Schema import/export round-trip

## Anti-patterns
- Do NOT modify seed.ts — the CMS starts empty each run
- Do NOT add new tools without proving existing tools can't handle it
- Do NOT over-tune guide text for one specific prompt
- DO encourage the agent to verify its work by querying GraphQL after publishing
