/**
 * Reactive editor state for toolbars. `useDastEditor`'s handle is stable by
 * design (it doesn't re-render on selection changes); this hook subscribes to
 * the editor and re-renders with a fresh DAST-vocabulary snapshot whenever the
 * selection or document changes.
 */
import { useEditorState, type Editor } from "@tiptap/react";
import type { CustomMark, DefaultMark, HeadingNode, ListNode, Mark } from "./bridge/dast-types.js";
import { DEFAULT_MARKS, isCustomMark } from "./bridge/dast-types.js";
import { buildCan } from "./commands.js";

export type ActiveBlock =
  | "paragraph"
  | `heading${HeadingNode["level"]}`
  | "codeBlock"
  | "other";

/**
 * The reactive form of `DastCan`: every "is this possible right now" boolean a
 * toolbar needs, recomputed with the snapshot so disabled states are honest.
 * `handle.can()` remains for imperative, point-in-time checks.
 */
export interface DastCanSnapshot {
  undo: boolean;
  redo: boolean;
  /** An embedded block atom can be inserted at the selection. */
  insertBlock: boolean;
  /** The selection sits in a table cell, so the row/column commands apply. */
  tableActions: boolean;
  /** Per-mark, for every default mark and every custom mark this field declares. */
  toggleMark: Readonly<Record<Mark, boolean>>;
}

export interface DastEditorSnapshot {
  isEmpty: boolean;
  selectionEmpty: boolean;
  /** Default marks active at the selection. */
  marks: Readonly<Record<DefaultMark, boolean>>;
  /** Project-defined marks active at the selection. */
  customMarks: readonly CustomMark[];
  /** The textblock the cursor sits in. */
  block: ActiveBlock;
  listStyle: ListNode["style"] | null;
  inBlockquote: boolean;
  inTable: boolean;
  activeLink: { url: string } | null;
  activeItemLink: { item: string } | null;
  /** @deprecated use `can.undo` — kept because it predates the `can` cluster. */
  canUndo: boolean;
  /** @deprecated use `can.redo`. */
  canRedo: boolean;
  /** Reactive `DastCan`: what the editor can do at this selection. */
  can: DastCanSnapshot;
}

function canToggleMarks(editor: Editor): Readonly<Record<Mark, boolean>> {
  const custom: Record<string, boolean> = {};
  for (const name of Object.keys(editor.schema.marks)) {
    if (isCustomMark(name)) custom[name] = editor.can().toggleMark(name);
  }
  return {
    strong: editor.can().toggleMark("strong"),
    emphasis: editor.can().toggleMark("emphasis"),
    underline: editor.can().toggleMark("underline"),
    strikethrough: editor.can().toggleMark("strikethrough"),
    code: editor.can().toggleMark("code"),
    highlight: editor.can().toggleMark("highlight"),
    ...custom,
  };
}

function snapshot(editor: Editor): DastEditorSnapshot {
  const marks = Object.fromEntries(
    DEFAULT_MARKS.map((mark) => [mark, editor.isActive(mark)])
  );

  const customMarks = Object.keys(editor.schema.marks)
    .filter(isCustomMark)
    .filter((mark) => editor.isActive(mark));

  let block: ActiveBlock = "other";
  if (editor.isActive("paragraph")) block = "paragraph";
  else if (editor.isActive("codeNode")) block = "codeBlock";
  else {
    for (const level of [1, 2, 3, 4, 5, 6]) {
      if (editor.isActive("heading", { level })) {
        block = `heading${level}` satisfies string as ActiveBlock;
        break;
      }
    }
  }

  // One source of truth with the imperative `handle.can()`.
  const can = buildCan(editor);

  const linkAttrs = editor.isActive("link") ? editor.getAttributes("link") : null;
  const itemLinkAttrs = editor.isActive("itemLink") ? editor.getAttributes("itemLink") : null;

  return {
    isEmpty: editor.isEmpty,
    selectionEmpty: editor.state.selection.empty,
    marks: {
      strong: marks.strong ?? false,
      emphasis: marks.emphasis ?? false,
      underline: marks.underline ?? false,
      strikethrough: marks.strikethrough ?? false,
      code: marks.code ?? false,
      highlight: marks.highlight ?? false,
    },
    customMarks,
    block,
    listStyle: editor.isActive("list", { style: "numbered" })
      ? "numbered"
      : editor.isActive("list", { style: "bulleted" })
        ? "bulleted"
        : null,
    inBlockquote: editor.isActive("blockquote"),
    inTable: editor.isActive("tableCell"),
    activeLink:
      linkAttrs && typeof linkAttrs.url === "string" ? { url: linkAttrs.url } : null,
    activeItemLink:
      itemLinkAttrs && typeof itemLinkAttrs.item === "string" ? { item: itemLinkAttrs.item } : null,
    canUndo: can.undo,
    canRedo: can.redo,
    can: {
      undo: can.undo,
      redo: can.redo,
      insertBlock: can.insertBlock,
      tableActions: can.tableActions,
      toggleMark: canToggleMarks(editor),
    },
  };
}

/**
 * Subscribe to a DAST-vocabulary snapshot of the editor. Accepts the handle
 * from useDastEditor (or a raw editor). Returns null until the editor mounts.
 */
export function useDastEditorState(source: { editor: Editor | null } | Editor | null): DastEditorSnapshot | null {
  const editor = source === null ? null : "editor" in source ? source.editor : source;
  return useEditorState({
    editor,
    // A destroyed editor still notifies subscribers once (React can re-render a
    // tree that is on its way out); it has no schema left to read.
    selector: (ctx) => (ctx.editor && !ctx.editor.isDestroyed ? snapshot(ctx.editor) : null),
  });
}
