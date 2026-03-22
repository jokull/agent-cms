# MCP Editor Friction Testing — Ideas Backlog

## Phase 1 Complete (single-task editorial surface)

All single-task editorial flows are friction-free. Validation and error quality are strong. Tool surface consolidated from 43 to 32.

## Phase 2 — Multi-Step Workflow Prompts

### High priority (most likely to find friction)

- Multi-step content creation: "Create an author, import headshot, create 3 posts with cover images and structured text, link to category, publish all"
- Correction flow: "Post X has wrong cover image, typo in excerpt — fix both and republish"
- Bulk recovery: "3 posts were accidentally published — unpublish, prefix titles with [DRAFT], leave as drafts"
- Schema design: "Design a recipe blog with ingredients, steps, categories, difficulty levels — create schema and seed 2 recipes"
- Version rollback + edit: "Revert post X to previous version, then change the title before republishing"

### Medium priority

- Add a new block type to an existing structured text field and use it in a post
- Create a testimonials block type with author, quote, avatar — embed it in post content
- Search for posts by a keyword, update all matching posts to add a tag/category
- Batch import: "Here are 5 post titles and excerpts — create them all with auto-generated slugs and publish"

### Lower priority (likely already friction-free)

- Singleton record editing (already optimized)
- Simple asset import and attachment (already optimized)
- Schedule/unschedule publish (already optimized)
- Basic search and report (already optimized)

## Residual Known Friction

- **Script writing** (curl/Node.js) is stuck at friction_count ~2 — remaining friction is auth/bootstrap inference outside the MCP surface. Diminishing returns on guide wording.
- **Editor/admin boundary** — editor MCP intentionally lacks schema tools. When a task requires schema mutation, the agent can only report the limitation, not fix it. This is by design.

## Anti-patterns to avoid

- Do NOT add new tools to reduce friction on a single prompt. Improve errors/docs/validation first.
- Do NOT bloat tool descriptions with edge-case wording that confuses the common case.
- Do NOT over-tune the guide for one specific prompt — it should be general-purpose orientation.
