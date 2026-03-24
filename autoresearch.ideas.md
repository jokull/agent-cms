# MCP Full-Stack Friction Testing — Ideas Backlog

## Phase 4 — Structured Text + Block Friction (primary)

### High priority (remaining)
- Watch for prompts where the agent still falls back to hand-assembled DAST instead of markdown mode despite the current docs.
- Watch for publish/verify prompts where the agent substitutes MCP workspace reads for GraphQL/live verification.

### Medium priority

### Already probed cleanly (phases 2-3)
- Blog, recipe, portfolio, restaurant, docs, events schema design from empty
- Nested blocks, slug ordering, validator UX
- Localization setup and drift QA
- Schema import/export round-trip
- Draft preview → publish → GraphQL verification flows

### Deferred / out of scope but promising
- GraphQL nested link resolution may stop one hop early for paths like `dailySpecial.menuItem.category` even though `menuItem.category` resolves correctly. This surfaced in a restaurant workflow, but the fix likely lives in the off-limits GraphQL layer rather than MCP/tooling.
- The preview/public Astro site can be schema-coupled to an older frontend query shape. In empty-CMS end-to-end tasks this can create friction unrelated to MCP/tooling, because the agent may need to update and redeploy the site just to render a newly designed schema.
- `dastToEditableMarkdown`/`editableMarkdownToDast` round-trip API exists in code but isn't exposed as an MCP tool — could enable targeted inline text edits without full document rewrites

## Anti-patterns
- Do NOT modify seed.ts — the CMS starts empty each run
- Do NOT add new tools without proving existing tools can't handle it
- Do NOT over-tune guide text for one specific prompt
- DO encourage the agent to verify its work by querying GraphQL after publishing
