/**
 * The structured_text field: `useDastEditor` + `useDastEditorState` + a host
 * toolbar, block insertion, and a record picker for itemLink / inlineItem.
 *
 * The envelope is still host-owned (`onChange` hands back a `DastDocument`
 * only, and orphan pruning is this component's job — FRICTION.md #10), but
 * block *insertion* no longer is: `commands.insertBlock(draft)` mints the id,
 * makes the payload renderable before the atom exists, and calls
 * `onBlockCreate` so this component can persist it whenever React gets to it.
 * No second "live" ref, no load-bearing ordering. (Was FRICTION.md #7.)
 */
import { EditorContent } from "@tiptap/react";
import { useDastEditor, useDastEditorState } from "@agent-cms/editor-react";
import { useCallback, useRef, useState } from "react";
import { client } from "../client.js";
import type { DastDocument as ContractDastDocument, PickerRow, PostContentEnvelope } from "../cms/contract.js";
import { EditorToolbar } from "./EditorToolbar.js";
import { PostBlockView, type BlockEditing, type PostBlock } from "./PostBlockView.js";
import { RecordPicker } from "./RecordPicker.js";

const EMPTY_DOC: ContractDastDocument = {
  schema: "dast",
  document: { type: "root", children: [{ type: "paragraph", children: [] }] },
};

/** Collect every block id the document still references (block + inlineBlock). */
function referencedBlockIds(document: ContractDastDocument): ReadonlySet<string> {
  const ids = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    if (!("type" in node)) return;
    const typed: { type?: unknown; item?: unknown; children?: unknown } = node;
    if ((typed.type === "block" || typed.type === "inlineBlock") && typeof typed.item === "string") {
      ids.add(typed.item);
    }
    if (Array.isArray(typed.children)) for (const child of typed.children) visit(child);
  };
  visit(document.document);
  return ids;
}

/** Only the three the toolbar offers; the union carries five. */
export type InsertableBlock = "hero_section" | "code_block" | "image_gallery";

/**
 * A payload with the id the toolkit will reuse. (The generated block union
 * requires `id`, so the host mints it here; a union without one lets
 * `insertBlock` mint it instead.)
 */
function newBlock(id: string, type: InsertableBlock): PostBlock {
  switch (type) {
    case "hero_section":
      return { id, _type: "hero_section", headline: "New hero" };
    case "code_block":
      return { id, _type: "code_block", code: "console.log('hi')", language: "ts" };
    case "image_gallery":
      return { id, _type: "image_gallery", caption: "New gallery", images: [] };
  }
}

export interface ContentFieldProps {
  /** Initial envelope from `post.byId`. Not reactive — remount by key to reset. */
  readonly initial: PostContentEnvelope | null;
  readonly onChange: (next: PostContentEnvelope) => void;
}

export function ContentField({ initial, onChange }: ContentFieldProps) {
  const [blocks, setBlocks] = useState<Record<string, PostBlock>>(() => initial?.blocks ?? {});
  // Read by callbacks that fire between renders (the payload editor, the
  // record picker). No longer load-bearing for insertion.
  const blocksRef = useRef<Record<string, PostBlock>>(blocks);
  blocksRef.current = blocks;

  const docRef = useRef<ContractDastDocument>(initial?.value ?? EMPTY_DOC);
  const [picker, setPicker] = useState<null | "itemLink" | "inlineItem">(null);

  const emit = useCallback(
    (document: ContractDastDocument, nextBlocks: Record<string, PostBlock>) => {
      // Orphan pruning is the host's job — nothing in the toolkit does it.
      const referenced = referencedBlockIds(document);
      const pruned: Record<string, PostBlock> = {};
      for (const [id, block] of Object.entries(nextBlocks)) {
        if (referenced.has(id)) pruned[id] = block;
      }
      onChange({ value: document, blocks: pruned });
    },
    [onChange],
  );

  const handle = useDastEditor<PostBlock, BlockEditing>({
    value: { value: docRef.current, blocks },
    placeholder: "Write the post…",
    blockView: PostBlockView,
    // Host props straight into the block cards (was a React context).
    blockViewProps: { edit: (id) => editBlockRef.current(id) },
    onChange: (document) => {
      // No adapter: the editor and the contract share @agent-cms/dast, so the
      // hook's document IS the contract's document. (Was FRICTION.md #1.)
      docRef.current = document;
      emit(document, blocksRef.current);
    },
    onBlockCreate: (id, draft) => {
      const next = { ...blocksRef.current, [id]: draft };
      blocksRef.current = next;
      setBlocks(next);
    },
  });
  const snapshot = useDastEditorState(handle);

  const insertBlock = (type: InsertableBlock) => {
    // One call: the toolkit registers the payload, inserts the atom, and calls
    // onBlockCreate. Nothing here can get the order wrong.
    handle.commands.insertBlock(newBlock(crypto.randomUUID(), type), "block");
    emit(handle.getValue(), blocksRef.current);
  };

  const editBlock = useCallback((id: string) => {
    const current = blocksRef.current[id];
    if (!current) return;
    let updated: PostBlock;
    switch (current._type) {
      case "hero_section": {
        const headline = window.prompt("Headline", current.headline);
        if (headline === null) return;
        updated = { ...current, headline };
        break;
      }
      case "code_block": {
        const code = window.prompt("Code", current.code);
        if (code === null) return;
        updated = { ...current, code };
        break;
      }
      case "image_gallery": {
        const caption = window.prompt("Caption", current.caption ?? "");
        if (caption === null) return;
        updated = { ...current, caption };
        break;
      }
      case "feature_card": {
        // `details` is a NESTED structured_text whose blocks map degrades to
        // Record<string, unknown> — the toolkit has no nested-editor story, so
        // only the scalar fields are editable here. FRICTION.md #12.
        const title = window.prompt("Title", current.title);
        if (title === null) return;
        updated = { ...current, title };
        break;
      }
      case "feature_grid": {
        const heading = window.prompt("Heading", current.heading);
        if (heading === null) return;
        updated = { ...current, heading };
        break;
      }
    }
    const next = { ...blocksRef.current, [id]: updated };
    blocksRef.current = next;
    setBlocks(next);
    emit(docRef.current, next);
  }, [emit]);

  // The block cards call the latest editor without re-creating blockViewProps.
  const editBlockRef = useRef(editBlock);
  editBlockRef.current = editBlock;

  const searchPosts = useCallback(async (q: string): Promise<readonly PickerRow[]> => {
    const result = await client.cms.post.search({ q });
    return result.ok ? result.value : [];
  }, []);

  const onPick = (row: PickerRow) => {
    if (picker === "itemLink") handle.commands.setItemLink(row.id);
    if (picker === "inlineItem") handle.commands.insertInlineItem(row.id);
    setPicker(null);
    emit(handle.getValue(), blocksRef.current);
  };

  return (
    <div className="contentfield">
      <EditorToolbar
        commands={handle.commands}
        snapshot={snapshot}
        onInsertBlock={insertBlock}
        onLinkRecord={() => setPicker("itemLink")}
        onInlineRecord={() => setPicker("inlineItem")}
      />
      <div className="editor-surface">
        <EditorContent editor={handle.editor} />
      </div>
      {snapshot?.activeItemLink && (
        <p className="muted">
          itemLink → {snapshot.activeItemLink.item}{" "}
          <button type="button" onClick={() => handle.commands.unsetItemLink()}>
            unlink
          </button>
        </p>
      )}
      {picker && (
        <RecordPicker
          title={picker === "itemLink" ? "Link to a post" : "Embed a post inline"}
          search={searchPosts}
          onPick={onPick}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}
