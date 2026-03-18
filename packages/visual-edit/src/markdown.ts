/**
 * Editable DAST ↔ Markdown projection for visual editing.
 *
 * Self-contained copy — no dependency on the core agent-cms runtime.
 * See src/dast/markdown.ts in the main package for the canonical implementation.
 *
 * Re-exports the types and the two core functions:
 *   dastToEditableMarkdown(doc) → { markdown, preservation }
 *   editableMarkdownToDast(markdown, preservation) → DastDocument
 */

export type {
  DastDocument,
  Mark,
  SpanNode,
  LinkNode,
  ItemLinkNode,
  InlineNode,
  ParagraphNode,
  HeadingNode,
  ListNode,
  ListItemNode,
  BlockquoteNode,
  CodeNode,
  BlockLevelNode,
  RootNode,
  TableNode,
  TableRowNode,
  TableCellNode,
} from "./dast-types.js";

export type {
  EditableMarkdown,
  PreservationMap,
  BlockNodeMeta,
  LinkMeta,
} from "./dast-editable.js";

export {
  dastToEditableMarkdown,
  editableMarkdownToDast,
  dastToMarkdown,
  markdownToDast,
} from "./dast-editable.js";
