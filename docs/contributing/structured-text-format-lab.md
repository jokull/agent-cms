# Structured Text Format Lab

agent-cms stores structured text as DAST, but agents should not author or edit
raw DAST JSON for normal prose changes.

The authoring target is normal Markdown plus opaque wikilink-style CMS handles.
Those handles are the canonical authoring surface. DAST remains the internal
storage and validation shape.

## Target Syntax

Use wikilink handles for every CMS reference:

```md
# Kyoto Campaign Refresh

Intro copy for the page.

[[block:hero]]

Day 1 highlights [[record:rec_stop_01|Stop 1]] with planning note [[inline_block:note_01]].

- Confirm booking [[inline_item:rec_booking_01]] before publishing.
- Keep tip [[inline_block:tip_01]] beside this day.
```

Supported handles:

| DAST node | Authoring handle | Notes |
| --- | --- | --- |
| root block | `[[block:hero]]` | block placement only; payload data lives outside prose |
| inline block | `[[inline_block:callout]]` | inline opaque block reference |
| inline item | `[[inline_item:rec_booking_01]]` | inline opaque record reference without link text |
| record link | `[[record:rec_stop_01\|Stop 1]]` | record reference with editable visible label |

Handles are opaque. The identifier after the prefix is a stable CMS handle, not
human-readable prose. Agents may move or delete handles only when the task asks
them to move or delete that CMS reference. They must not expand handles into
JSON, invent payload fields, rename IDs for readability, or convert handles to
another syntax.

Block payload editing remains separate from document placement. Create or edit
block data through structured block APIs such as `blocks` or `patch_blocks`;
the prose document should contain only the handle that places the block.

## Decision

Use wikilink handles as the canonical structured-text authoring format:

```json
{
  "text": "Intro paragraph\n\n[[block:hero1]]",
  "blocks": [{ "id": "hero1", "type": "hero", "data": { "title": "Welcome" } }]
}
```

The intended external authoring contract is:

- `[[block:id]]`
- `[[inline_block:id]]`
- `[[inline_item:id]]`
- `[[record:id|label]]`

No alternate authoring syntax is supported.

## Internal Conversion

The wikilink format compiles internally to DAST. That conversion boundary is
hidden from authors and agents. Authors should see stable handles, not DAST JSON
or implementation-specific reference markers.

## Current Lab State

The format lab in `src/dast/format-lab.ts` verifies the single supported
authoring format:

- `agentText` — canonical Markdown plus wikilink handles, e.g. `[[block:id]]`

Run the focused harness with:

```bash
pnpm vitest run test/dast-format-lab.test.ts
```

Run the agent performance eval harness with:

```bash
pnpm run eval:structured-text
```

That command runs the scenario/scoring loop in dry-run mode. It verifies that
Agent Text can be parsed and scored, but does not call an LLM.

For real model measurements:

```bash
OPENAI_API_KEY=... STRUCTURED_TEXT_EVAL_MODEL=gpt-5.4-mini pnpm run eval:structured-text -- --live --json
```

The eval can also drive local agent CLIs when they are installed and
authenticated:

```bash
pnpm run eval:structured-text -- --provider codex --model gpt-5.4-mini --json
pnpm run eval:structured-text -- --provider claude --model sonnet --json
```

For smoke tests, restrict the run:

```bash
pnpm run eval:structured-text -- --provider codex --scenario prose_edit_preserve_refs --format agentText
```

A single smoke scenario only verifies that the provider adapter works. Use the
full scenario set, multiple runs, and preferably more than one provider before
changing the authoring syntax.

To force divergence, use weaker/cheaper models and harder scenarios:

```bash
pnpm run eval:structured-text -- --provider codex --model gpt-5.4-mini --scenario complex_rewrite_reorder --repeat 3 --json
pnpm run eval:structured-text -- --provider codex --model gpt-5.4-mini --scenario delete_one_reference_only --repeat 3 --json
pnpm run eval:structured-text -- --provider codex --model gpt-5.3-codex-spark --scenario campaign_reference_maze --repeat 3 --json
```

The Codex adapter runs `codex exec` in a read-only, non-interactive subprocess.
The Claude adapter runs `claude --print` with tools disabled. Both adapters
score only the final text response.

## What To Measure

Prefer formats that:

- round-trip through valid DAST without lossy reference handling
- minimize characters and approximate token count
- avoid HTML comments and angle-bracket tags for content semantics
- make CMS references visually scannable in prose
- keep block payload editing separate from document placement
- improve actual LLM task success on realistic CMS edits

The LLM eval scenarios currently cover:

- prose edits while preserving block, inline block, inline item, and record-link references
- translation of human-readable prose while preserving CMS references
- moving a block without editing or inventing block payload data
- rewriting a longer section with lists, multiple blocks, inline items, inline blocks, and block reordering
- deleting exactly one block while preserving adjacent references
- editing a dense page with confusable IDs such as `hero_photo` and `hero_photo_mobile`
- editing a long campaign page with many numbered references, block deletion, block moves, and a targeted paragraph rewrite

The scorer checks both the requested prose edits and exact DAST reference sets.
It also penalizes responses that parse but leak unsupported syntax, such as
angle-bracket reference tags, HTML comments, or Markdown-link reference schemes.
