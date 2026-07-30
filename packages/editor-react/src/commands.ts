/**
 * The typed command surface, in DAST vocabulary. Hosts build toolbars against
 * this; the raw Tiptap editor stays reachable but should never be needed.
 *
 * Table structure commands are hand-rolled: the DAST table grammar is our own
 * (`table > tableRow+ > tableCell(paragraph+)`), deliberately simpler than
 * prosemirror-tables (no spans, no colwidths), so its operations are plain
 * node surgery. The NonEmptyArray grammar means "delete the last row/column"
 * degrades to "delete the table".
 */
import type { Editor } from "@tiptap/core";
import type { Node as PmNode, ResolvedPos } from "@tiptap/pm/model";
import type { HeadingNode, ListNode, Mark } from "./bridge/dast-types.js";

export interface DastCommands<Block = unknown> {
  focus(): void;
  undo(): boolean;
  redo(): boolean;
  toggleMark(mark: Mark): boolean;
  setParagraph(): boolean;
  toggleHeading(level: HeadingNode["level"]): boolean;
  toggleList(style: ListNode["style"]): boolean;
  toggleBlockquote(): boolean;
  toggleCodeBlock(): boolean;
  /** Apply a link mark over the selection. */
  setLink(url: string, meta?: ReadonlyArray<{ id: string; value: string }>): boolean;
  unsetLink(): boolean;
  /** Apply an itemLink (record link) mark over the selection. */
  setItemLink(recordId: string): boolean;
  unsetItemLink(): boolean;
  /** Insert an inline record reference at the cursor. */
  insertInlineItem(recordId: string): boolean;
  /**
   * Insert an embedded block atom.
   *
   * - `insertBlock(id)` — reference a block already in the envelope's map.
   * - `insertBlock(draft)` — hand the toolkit a payload object. It mints an id
   *   (or reuses `draft.id` when the payload already carries one), registers
   *   the payload in the map the node views read BEFORE the atom exists, and
   *   only then notifies the host via `onBlockCreate(id, draft)`. That ordering
   *   is what makes the host's state update order irrelevant.
   *
   * A string argument is always an existing id, never a payload.
   */
  insertBlock(item: string | Block, position?: "block" | "inline"): boolean;
  insertThematicBreak(): boolean;
  insertTable(rows?: number, cols?: number): boolean;
  addRowAfter(): boolean;
  deleteRow(): boolean;
  addColumnAfter(): boolean;
  deleteColumn(): boolean;
}

/** Booleans mirroring DastCommands, for disabling toolbar buttons honestly. */
export interface DastCan {
  undo: boolean;
  redo: boolean;
  toggleMark(mark: Mark): boolean;
  insertBlock: boolean;
  tableActions: boolean;
}

// --- table helpers ---

interface Ancestor {
  node: PmNode;
  depth: number;
  /** Position immediately before the node. */
  before: number;
}

function findAncestor($from: ResolvedPos, name: string): Ancestor | null {
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === name) {
      return { node, depth, before: $from.before(depth) };
    }
  }
  return null;
}

function emptyCellJson() {
  return { type: "tableCell", content: [{ type: "paragraph" }] };
}

function tableJson(rows: number, cols: number) {
  return {
    type: "table",
    content: Array.from({ length: rows }, () => ({
      type: "tableRow",
      content: Array.from({ length: cols }, emptyCellJson),
    })),
  };
}

/**
 * @param registerBlock Called for `insertBlock(draft)` with the payload; returns
 * the id the atom should reference. Omitted (e.g. a host with no block map) →
 * draft insertion is a no-op returning false.
 */
export function buildCommands<Block = unknown>(
  editor: Editor,
  registerBlock?: (draft: Block) => string,
): DastCommands<Block> {
  const chain = () => editor.chain().focus();

  return {
    focus: () => {
      editor.commands.focus();
    },
    undo: () => chain().undo().run(),
    redo: () => chain().redo().run(),
    toggleMark: (mark) => chain().toggleMark(mark).run(),
    setParagraph: () => chain().setNode("paragraph").run(),
    toggleHeading: (level) => chain().toggleNode("heading", "paragraph", { level }).run(),
    toggleList: (style) => chain().toggleList("list", "listItem", false, { style }).run(),
    toggleBlockquote: () => chain().toggleWrap("blockquote").run(),
    toggleCodeBlock: () => chain().toggleNode("codeNode", "paragraph").run(),
    setLink: (url, meta) =>
      chain().extendMarkRange("link").setMark("link", { url, meta: meta ?? null }).run(),
    unsetLink: () => chain().extendMarkRange("link").unsetMark("link").run(),
    setItemLink: (recordId) =>
      chain().extendMarkRange("itemLink").setMark("itemLink", { item: recordId }).run(),
    unsetItemLink: () => chain().extendMarkRange("itemLink").unsetMark("itemLink").run(),
    insertInlineItem: (recordId) =>
      chain().insertContent({ type: "inlineItem", attrs: { item: recordId } }).run(),
    insertBlock: (item, position = "block") => {
      const id = typeof item === "string" ? item : registerBlock ? registerBlock(item) : null;
      if (id === null || id.length === 0) return false;
      return chain()
        .insertContent({
          type: position === "inline" ? "inlineBlock" : "blockNode",
          attrs: { item: id },
        })
        .run();
    },
    insertThematicBreak: () => chain().insertContent({ type: "thematicBreak" }).run(),
    insertTable: (rows = 2, cols = 2) =>
      chain().insertContent(tableJson(Math.max(1, rows), Math.max(1, cols))).run(),

    addRowAfter: () =>
      editor
        .chain()
        .focus()
        .command(({ state, tr, dispatch }) => {
          const row = findAncestor(state.selection.$from, "tableRow");
          if (!row) return false;
          if (dispatch) {
            const cells = Array.from({ length: row.node.childCount }, () =>
              state.schema.nodes.tableCell?.createAndFill()
            ).filter((cell): cell is PmNode => cell !== null && cell !== undefined);
            const newRow = state.schema.nodes.tableRow?.create(null, cells);
            if (!newRow) return false;
            tr.insert(row.before + row.node.nodeSize, newRow);
          }
          return true;
        })
        .run(),

    deleteRow: () =>
      editor
        .chain()
        .focus()
        .command(({ state, tr, dispatch }) => {
          const row = findAncestor(state.selection.$from, "tableRow");
          const table = findAncestor(state.selection.$from, "table");
          if (!row || !table) return false;
          if (dispatch) {
            if (table.node.childCount <= 1) {
              tr.delete(table.before, table.before + table.node.nodeSize);
            } else {
              tr.delete(row.before, row.before + row.node.nodeSize);
            }
          }
          return true;
        })
        .run(),

    addColumnAfter: () =>
      editor
        .chain()
        .focus()
        .command(({ state, tr, dispatch }) => {
          const $from = state.selection.$from;
          const cell = findAncestor($from, "tableCell");
          const table = findAncestor($from, "table");
          if (!cell || !table) return false;
          const columnIndex = $from.index(cell.depth - 1);
          if (dispatch) {
            // Walk rows back-to-front so earlier insertions don't shift later positions.
            const inserts: number[] = [];
            table.node.forEach((rowNode, rowOffset) => {
              const rowStart = table.before + 1 + rowOffset + 1; // inside the row
              let cellEnd = rowStart;
              rowNode.forEach((cellNode, cellOffset, index) => {
                if (index <= columnIndex) cellEnd = rowStart + cellOffset + cellNode.nodeSize;
              });
              inserts.push(cellEnd);
            });
            for (const pos of inserts.reverse()) {
              const newCell = state.schema.nodes.tableCell?.createAndFill();
              if (newCell) tr.insert(pos, newCell);
            }
          }
          return true;
        })
        .run(),

    deleteColumn: () =>
      editor
        .chain()
        .focus()
        .command(({ state, tr, dispatch }) => {
          const $from = state.selection.$from;
          const cell = findAncestor($from, "tableCell");
          const table = findAncestor($from, "table");
          if (!cell || !table) return false;
          const columnIndex = $from.index(cell.depth - 1);
          const columns = table.node.firstChild?.childCount ?? 0;
          if (dispatch) {
            if (columns <= 1) {
              tr.delete(table.before, table.before + table.node.nodeSize);
              return true;
            }
            const ranges: Array<[number, number]> = [];
            table.node.forEach((rowNode, rowOffset) => {
              const rowStart = table.before + 1 + rowOffset + 1;
              rowNode.forEach((cellNode, cellOffset, index) => {
                if (index === columnIndex) {
                  ranges.push([rowStart + cellOffset, rowStart + cellOffset + cellNode.nodeSize]);
                }
              });
            });
            for (const [from, to] of ranges.reverse()) tr.delete(from, to);
          }
          return true;
        })
        .run(),
  };
}

export function buildCan(editor: Editor): DastCan {
  return {
    undo: editor.can().undo(),
    redo: editor.can().redo(),
    toggleMark: (mark) => editor.can().toggleMark(mark),
    insertBlock: editor.can().insertContent({ type: "blockNode", attrs: { item: "x" } }),
    tableActions: findAncestor(editor.state.selection.$from, "tableCell") !== null,
  };
}
