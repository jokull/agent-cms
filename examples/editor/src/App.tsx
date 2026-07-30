import { EditorContent } from "@tiptap/react";
import { useDastEditor, useDastEditorState, type DastDocument } from "@agent-cms/editor-react";
import { useState } from "react";
import { BlockView } from "./BlockView.js";
import type { DemoBlock } from "./blocks.js";
import { Inspector } from "./Inspector.js";
import { seedEnvelope } from "./seed.js";
import { Toolbar } from "./Toolbar.js";

const CUSTOM_MARKS: ReadonlyArray<`customMark_${string}`> = ["customMark_kbd"];

export function App() {
  const [doc, setDoc] = useState<DastDocument>(seedEnvelope.value);
  const [blocks, setBlocks] = useState<Record<string, DemoBlock>>(seedEnvelope.blocks);

  const handle = useDastEditor<DemoBlock>({
    value: { value: seedEnvelope.value, blocks },
    placeholder: "Write something…",
    customMarks: CUSTOM_MARKS,
    blockView: BlockView,
    onChange: setDoc,
    // The toolkit minted the id and already made the payload renderable; this
    // just persists it in host state. Ordering no longer matters.
    onBlockCreate: (id, draft) => setBlocks((prev) => ({ ...prev, [id]: draft })),
  });
  const snapshot = useDastEditorState(handle);

  const insertHero = () =>
    handle.commands.insertBlock(
      {
        _type: "hero_section",
        heading: "A freshly inserted hero",
        image_url: `https://picsum.photos/seed/${Math.random().toString(36).slice(2)}/640/240`,
      },
      "block",
    );

  const insertCta = () =>
    handle.commands.insertBlock({ _type: "cta_chip", label: "New chip" }, "inline");

  return (
    <div className="page">
      <header className="page__header">
        <h1>editor-react demo</h1>
        <p>
          Plain hand-written CSS, no Tailwind, no agent-cms components. This chrome is deliberately
          foreign to the CMS — everything below is built from <code>handle.commands</code> and{" "}
          <code>useDastEditorState</code>.
        </p>
      </header>

      <main className="layout">
        <section className="editor-pane">
          <Toolbar commands={handle.commands} snapshot={snapshot} />
          <div className="block-insert-row">
            <button type="button" disabled={!snapshot?.can.insertBlock} onClick={insertHero}>
              Insert hero block
            </button>
            <button type="button" disabled={!snapshot?.can.insertBlock} onClick={insertCta}>
              Insert CTA chip (inline)
            </button>
          </div>
          <div className="editor-surface">
            <EditorContent editor={handle.editor} />
          </div>
        </section>

        <Inspector document={doc} />
      </main>
    </div>
  );
}
