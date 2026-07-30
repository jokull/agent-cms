/**
 * Reactive editor state for toolbars. `useDastEditor`'s handle is stable by
 * design (it doesn't re-render on selection changes); this hook subscribes to
 * the editor and re-renders with a fresh DAST-vocabulary snapshot whenever the
 * selection or document changes.
 */
import { useEditorState, type Editor } from "@tiptap/react";
import type { CustomMark, DefaultMark, HeadingNode, ListNode } from "./bridge/dast-types.js";
import { DEFAULT_MARKS, isCustomMark } from "./bridge/dast-types.js";

export type ActiveBlock =
  | "paragraph"
  | `heading${HeadingNode["level"]}`
  | "codeBlock"
  | "other";

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
  canUndo: boolean;
  canRedo: boolean;
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
    canUndo: editor.can().undo(),
    canRedo: editor.can().redo(),
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
    selector: (ctx) => (ctx.editor ? snapshot(ctx.editor) : null),
  });
}
