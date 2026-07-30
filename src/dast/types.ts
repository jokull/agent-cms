/**
 * DAST (DatoCMS Abstract Syntax Tree) type definitions.
 *
 * The definitions themselves live in `@agent-cms/dast` (zero runtime deps) so
 * the CMS, `@agent-cms/editor-react` and the `contract.ts` emitted by
 * `@agent-cms/codegen` all share one declaration instead of three vendored
 * copies that drift apart. This module is a re-export barrel: every existing
 * `./types.js` import inside `src/` keeps working unchanged.
 *
 * The Effect Schema validators stay here in the CMS (`./schema.ts`) — they
 * depend on `effect`, which the types package deliberately does not.
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
  StructuredTextValue,
  TableCellNode,
  TableNode,
  TableRowNode,
  ThematicBreakNode,
} from "@agent-cms/dast";

export {
  CUSTOM_MARK_PREFIX,
  DEFAULT_MARKS,
  emptyDastDocument,
  isCustomMark,
  isDefaultMark,
  isMark,
} from "@agent-cms/dast";
