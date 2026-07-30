/**
 * DAST types — re-exported from `@agent-cms/dast`.
 *
 * This file used to be a vendored copy of agent-cms `src/dast/types.ts`, and it
 * drifted (custom marks landed here but not in the generated contract), which
 * made the editor's output un-assignable to the generated write input. There is
 * now exactly one declaration, in the zero-dependency `@agent-cms/dast`
 * package; this barrel keeps the existing `./dast-types.js` import paths inside
 * the editor working.
 */

export type {
  BlockLevelNode,
  BlockNode,
  BlockquoteNode,
  CodeNode,
  CustomMark,
  DastDocument,
  DastNode,
  DefaultMark,
  HeadingNode,
  InlineBlockNode,
  InlineItemNode,
  InlineNode,
  ItemLinkNode,
  LinkNode,
  ListItemNode,
  ListNode,
  Mark,
  ParagraphNode,
  RootNode,
  SpanNode,
  TableCellNode,
  TableNode,
  TableRowNode,
  ThematicBreakNode,
} from "@agent-cms/dast";

export { CUSTOM_MARK_PREFIX, DEFAULT_MARKS, isCustomMark, isDefaultMark, isMark } from "@agent-cms/dast";
