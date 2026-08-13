/**
 * The custom DAST editor: `useDastEditor` + the headless slash plugin + a host
 * mark toolbar + the block view. The envelope is host-owned; orphan pruning is
 * this component's job (the toolkit never prunes).
 */
import { EditorContent } from "@tiptap/react";
import { useDastEditor, useDastEditorState } from "@agent-cms/editor-react";
import { useCallback, useRef, useState } from "react";
import type { DastDocument } from "@agent-cms/dast";
import type { PostContentEnvelope } from "../cms/contract.js";
import { BlockView, newBlock, type BlockEditing, type PostBlock } from "./blocks.jsx";
import { SlashMenu } from "./SlashMenu.jsx";
import { SlashCommands, type SlashCommand } from "./slash.js";

const EMPTY_DOC: DastDocument = {
  schema: "dast",
  document: { type: "root", children: [{ type: "paragraph", children: [] }] },
};

/** Stable across renders — a fresh array would rebuild the editor. */
const EXTENSIONS = [SlashCommands];

function referencedBlockIds(document: DastDocument): ReadonlySet<string> {
  const ids = new Set<string>();
  const visit = (node: unknown): void => {
    if (node == null || typeof node !== "object") return;
    const candidate = node as { type?: unknown; item?: unknown; children?: unknown };
    if (
      (candidate.type === "block" || candidate.type === "inlineBlock") &&
      typeof candidate.item === "string"
    ) {
      ids.add(candidate.item);
    }
    if (Array.isArray(candidate.children)) {
      for (const child of candidate.children) visit(child);
    }
  };
  visit(document.document);
  return ids;
}

const SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: "text", title: "Text", description: "Plain paragraph", run: (c) => c.setParagraph() },
  { id: "h1", title: "Heading 1", description: "Large section heading", run: (c) => c.toggleHeading(1) },
  { id: "h2", title: "Heading 2", description: "Medium heading", run: (c) => c.toggleHeading(2) },
  { id: "h3", title: "Heading 3", description: "Small heading", run: (c) => c.toggleHeading(3) },
  { id: "bullet", title: "Bulleted list", run: (c) => c.toggleList("bulleted") },
  { id: "numbered", title: "Numbered list", run: (c) => c.toggleList("numbered") },
  { id: "quote", title: "Quote", description: "Blockquote", run: (c) => c.toggleBlockquote() },
  { id: "code", title: "Code block", description: "Monospace block", run: (c) => c.toggleCodeBlock() },
  { id: "divider", title: "Divider", description: "Thematic break", run: (c) => c.insertThematicBreak() },
  { id: "table", title: "Table", description: "3 × 3 table", run: (c) => c.insertTable(3, 3) },
  {
    id: "hero",
    title: "Hero section",
    description: "Embedded block",
    keywords: ["block", "hero_section"],
    run: (c) => c.insertBlock(newBlock("hero_section"), "block"),
  },
  {
    id: "code-block",
    title: "Code (embedded)",
    description: "Embedded block",
    keywords: ["block", "code_block"],
    run: (c) => c.insertBlock(newBlock("code_block"), "block"),
  },
  {
    id: "gallery",
    title: "Image gallery",
    description: "Embedded block",
    keywords: ["block", "image_gallery"],
    run: (c) => c.insertBlock(newBlock("image_gallery"), "block"),
  },
  {
    id: "feature-card",
    title: "Feature card",
    description: "Embedded block",
    keywords: ["block", "feature_card"],
    run: (c) => c.insertBlock(newBlock("feature_card"), "block"),
  },
  {
    id: "feature-grid",
    title: "Feature grid",
    description: "Embedded block",
    keywords: ["block", "feature_grid"],
    run: (c) => c.insertBlock(newBlock("feature_grid"), "block"),
  },
];

const MARK_BUTTONS = [
  { mark: "strong", label: "B" },
  { mark: "emphasis", label: "I" },
  { mark: "code", label: "</>" },
] as const;

export interface DastEditorProps {
  readonly initial: PostContentEnvelope | null;
  readonly onChange: (next: PostContentEnvelope) => void;
}

export function DastEditor({ initial, onChange }: DastEditorProps) {
  const [blocks, setBlocks] = useState<Record<string, PostBlock>>(() => initial?.blocks ?? {});
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const docRef = useRef<DastDocument>(initial?.value ?? EMPTY_DOC);

  const emit = useCallback(
    (document: DastDocument, nextBlocks: Record<string, PostBlock>) => {
      const referenced = referencedBlockIds(document);
      const pruned: Record<string, PostBlock> = {};
      for (const [id, block] of Object.entries(nextBlocks)) {
        if (referenced.has(id)) pruned[id] = block;
      }
      onChange({ value: document, blocks: pruned });
    },
    [onChange],
  );

  const updateBlock = useCallback(
    (id: string, next: PostBlock) => {
      const current = blocksRef.current[id];
      if (!current) return;
      const merged = { ...blocksRef.current, [id]: next };
      blocksRef.current = merged;
      setBlocks(merged);
      emit(docRef.current, merged);
    },
    [emit],
  );

  const handle = useDastEditor<PostBlock, BlockEditing>({
    value: { value: docRef.current, blocks },
    placeholder: "Type / to insert a block…",
    blockView: BlockView,
    blockViewProps: { updateBlock },
    extensions: EXTENSIONS,
    onChange: (document) => {
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

  return (
    <div className="editor">
      <div className="editor__toolbar">
        {MARK_BUTTONS.map(({ mark, label }) => (
          <button
            key={mark}
            type="button"
            className={`tb${snapshot?.marks[mark] ? " tb--active" : ""}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => handle.commands.toggleMark(mark)}
          >
            {label}
          </button>
        ))}
        <span className="tb__hint">
          Type <kbd>/</kbd> for blocks, headings, lists, tables
        </span>
      </div>
      <div className="editor__surface">
        <EditorContent editor={handle.editor} />
      </div>
      <SlashMenu editor={handle.editor} commands={handle.commands} items={SLASH_COMMANDS} />
    </div>
  );
}
