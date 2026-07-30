# @agent-cms/editor-react (prototype)

Headless React toolkit for agent-cms structured_text fields, on Tiptap 3 (ProseMirror).
See `PLAN.md` for the roadmap; wayfinder tickets 13/15 own the final API stance.

Layers:

- `@agent-cms/editor-react/bridge` — engine-level, no React: Tiptap extensions whose
  `NodeSpec.content` expressions are the DAST grammar 1:1 (invalid content fails loudly — the
  hook sets `enableContentCheck`, never silently repaired), plus a lossless DAST ↔ ProseMirror
  codec (`dastToPm` / `pmToDast`).
- `useDastEditor` — the hook. Renders nothing, ships no CSS. Includes undo/redo, mark and
  structure keyboard shortcuts, markdown-style input rules (`## `, `- `, `> `, ``` ```` ```,
  `---`, `**bold**`…), gap/drop cursors, a trailing paragraph guard after block atoms,
  placeholder, and `customMark_*` support.
- `handle.commands` — typed commands in DAST vocabulary (marks, headings, lists, quote, code
  block, links, record links, inline records, embedded blocks, thematic break, table surgery,
  undo/redo). No ProseMirror types leak into host code.
- `useDastEditorState` — reactive snapshot for toolbars (active marks/block/list, link attrs,
  canUndo/canRedo, in-table). Re-renders on selection and document changes.

```tsx
import { EditorContent } from "@tiptap/react";
import { useDastEditor, useDastEditorState, type BlockViewProps } from "@agent-cms/editor-react";
import type { PostContentEnvelope } from "./cms/contract"; // generated

function HeroOrCta({ block, remove }: BlockViewProps<PostContentEnvelope["blocks"][string]>) {
  if (!block) return null;
  switch (block._type) {
    case "hero_section": return <YourHeroCard heading={block.heading} onRemove={remove} />;
    case "cta_block":    return <YourCtaChip label={block.label} onRemove={remove} />;
  }
}

function ContentField({ envelope, onChange }) {
  const handle = useDastEditor({
    value: envelope,
    onChange,
    blockView: HeroOrCta,
    placeholder: "Write something…",
    customMarks: ["customMark_kbd"],
  });
  const s = useDastEditorState(handle);

  return (
    <>
      <YourToolbar>
        <YourButton active={s?.marks.strong} onClick={() => handle.commands.toggleMark("strong")} />
        <YourButton active={s?.block === "heading2"} onClick={() => handle.commands.toggleHeading(2)} />
        <YourButton disabled={!s?.canUndo} onClick={handle.commands.undo} />
      </YourToolbar>
      <EditorContent editor={handle.editor} />
    </>
  );
}
```

Deliberate normalizations (semantically lossless): empty spans are dropped on load and never
emitted; adjacent identical marks merge. Everything else round-trips byte-identically — see
`test/codec.test.ts`. Behavioral coverage (history, commands, table surgery, custom marks,
paste normalization) lives in `test/editor-behavior.test.ts` (jsdom).
