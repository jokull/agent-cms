# MCP Full-Stack Friction Testing — Ideas Backlog

## Phase 4 — Structured Text + Block Friction (primary)

### High priority (markdown mode adoption)
- Does the agent discover markdown mode from create_record description, or does it hand-assemble DAST?
- Does the agent use correct sentinel format `<!-- cms:block:BLOCK_ID -->`?
- Does the agent use `[text](itemLink:RECORD_ID)` for record links in markdown?
- When editing existing content, does the agent re-send the whole document as DAST or use markdown mode?
- Does the agent use patch_blocks for block-level changes vs full document rewrites?
- When blocks are passed as a map (canonical format from get_record), does expandStructuredTextShorthand accept them?
- When blocks are passed as array with `_type` (canonical), does buildBlockMapFromArray handle them?

### Medium priority
- Mixed workflow: create with markdown mode, then patch_blocks for targeted edits, then markdown mode for prose rewrites
- `patch_blocks` returns a compact summary (`blocks`, `deleted`, `blockOrder`) rather than the full record; agents may still misread this and invent draft-state bugs. Consider whether a richer response or more forceful docs/example would actually reduce friction on block-edit prompts.
- Inline formatting round-trip: create with markdown bold/italic/code/links, query via GraphQL, verify marks are correct
- Large content updates: 10+ paragraphs with blocks — does the agent choose markdown over DAST?
- update_record description: does the agent find the field format docs (they live on create_record)?

### Already probed cleanly (phases 2-3)
- Blog, recipe, portfolio, restaurant, docs, events schema design from empty
- Nested blocks, slug ordering, validator UX
- Localization setup and drift QA
- Schema import/export round-trip
- Draft preview → publish → GraphQL verification flows

### Deferred / out of scope but promising
- GraphQL nested link resolution may stop one hop early for paths like `dailySpecial.menuItem.category` even though `menuItem.category` resolves correctly. This surfaced in a restaurant workflow, but the fix likely lives in the off-limits GraphQL layer rather than MCP/tooling.
- `dastToEditableMarkdown`/`editableMarkdownToDast` round-trip API exists in code but isn't exposed as an MCP tool — could enable targeted inline text edits without full document rewrites

## Anti-patterns
- Do NOT modify seed.ts — the CMS starts empty each run
- Do NOT add new tools without proving existing tools can't handle it
- Do NOT over-tune guide text for one specific prompt
- DO encourage the agent to verify its work by querying GraphQL after publishing
