# editor-demo

A minimal Vite + React app proving `@agent-cms/editor-react` drops into "any React app."

## What this demonstrates

- `useDastEditor` wired to a hand-seeded `StructuredTextEnvelope` (local React state, no CMS
  backend, no network calls) that exercises every DAST node type: headings, nested lists,
  blockquote, code block, thematic break, table, link, itemLink, inlineItem, and two embedded
  blocks (`hero_section` rendered block-level, `cta_chip` rendered inline).
- A toolbar (`src/Toolbar.tsx`) built **exclusively** from `handle.commands` and
  `useDastEditorState` — marks (including the custom `customMark_kbd` mark), a block-type
  select, list/quote/hr toggles, link editing via `window.prompt`, table insert plus row/column
  commands gated on `snapshot.inTable`, and undo/redo gated on `canUndo`/`canRedo`.
  `handle.editor.chain()` is never called from this file.
- A `blockView` component (`src/BlockView.tsx`) that discriminates the two block payload types
  on `_type` and renders a remove button per the toolkit's `BlockViewProps` contract.
- A live DAST inspector (`src/Inspector.tsx`) that pretty-prints the document coming back out of
  `onChange` on every keystroke, so the round-trip is visible while typing.

## Deliberately foreign chrome

**The CSS in `src/app.css` is hand-written and has nothing to do with agent-cms.** No Tailwind,
no CMS component library, no shared design tokens — a plain serif/sepia look chosen specifically
so it reads as "some unrelated app," not the CMS admin. That's the point of this example: the
editor toolkit is headless and ships zero CSS, so any host can skin it however it wants.

## Run it

```bash
pnpm install         # from the repo root
pnpm --filter editor-demo dev      # dev server
pnpm --filter editor-demo build    # typecheck + production build
```
