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
  in-table, and a `can` cluster: `undo`, `redo`, `insertBlock`, `tableActions`,
  `toggleMark[mark]`). Re-renders on selection and document changes. `handle.can()` remains for
  imperative, point-in-time checks.

```tsx
import { EditorContent } from "@tiptap/react";
import { useDastEditor, useDastEditorState, type BlockViewProps } from "@agent-cms/editor-react";
import type { PostContentEnvelope } from "./cms/contract"; // generated

type PostBlock = PostContentEnvelope["blocks"][string];
interface Editing { edit: (id: string) => void }   // whatever the host needs

function HeroOrCta({ id, block, remove, props }: BlockViewProps<PostBlock, Editing>) {
  if (!block) return null;
  const onEdit = () => props?.edit(id);            // host props, no React context
  switch (block._type) {
    case "hero_section": return <YourHeroCard heading={block.heading} onEdit={onEdit} onRemove={remove} />;
    case "cta_block":    return <YourCtaChip label={block.label} onEdit={onEdit} onRemove={remove} />;
  }
}

function ContentField({ envelope, onChange }) {
  const handle = useDastEditor({
    value: envelope,
    onChange,
    blockView: HeroOrCta,
    // Anything the block cards need beyond {id, block, inline, remove}. Read
    // through a ref: a new object every render never remounts a node view.
    blockViewProps: { edit: openPayloadEditor },
    // Fired by commands.insertBlock(draft) with the id the toolkit minted.
    onBlockCreate: (id, draft) => setBlocks((prev) => ({ ...prev, [id]: { ...draft, id } })),
    placeholder: "Write something…",
    customMarks: ["customMark_kbd"],
  });
  const s = useDastEditorState(handle);

  return (
    <>
      <YourToolbar>
        <YourButton active={s?.marks.strong} onClick={() => handle.commands.toggleMark("strong")} />
        <YourButton active={s?.block === "heading2"} onClick={() => handle.commands.toggleHeading(2)} />
        <YourButton disabled={!s?.can.undo} onClick={handle.commands.undo} />
        <YourButton
          disabled={!s?.can.insertBlock}
          onClick={() => handle.commands.insertBlock({ _type: "cta_block", label: "New" })}
        />
      </YourToolbar>
      <EditorContent editor={handle.editor} />
    </>
  );
}
```

**Block insertion is not order-sensitive.** `commands.insertBlock(draft)` mints an id (or reuses
`draft.id`), registers the payload in the map node views read *before* the atom exists, and only
then calls `onBlockCreate(id, draft)` — so the host's state update can land whenever React gets
to it and the card never flashes "unresolved payload". `commands.insertBlock(id: string)` still
means "reference this existing block".

Deliberate normalizations (semantically lossless): empty spans are dropped on load and never
emitted; adjacent identical marks merge. Everything else round-trips byte-identically — see
`test/codec.test.ts`. Behavioral coverage (history, commands, table surgery, custom marks,
paste normalization) lives in `test/editor-behavior.test.ts`; hook-level coverage (host props,
reactive `can`, draft insertion) in `test/hook.test.tsx` — both jsdom.
