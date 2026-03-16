export type {
  DastDocument,
  RootNode,
  BlockLevelNode,
  InlineNode,
  SpanNode,
  LinkNode,
  ItemLinkNode,
  InlineItemNode,
  InlineBlockNode,
  ParagraphNode,
  HeadingNode,
  ListNode,
  ListItemNode,
  BlockquoteNode,
  CodeNode,
  ThematicBreakNode,
  BlockNode,
  Mark,
  StructuredTextValue,
} from "./types.js";

export { validateDast, validateBlocksOnly, extractBlockIds, extractInlineBlockIds, extractAllBlockIds, extractLinkIds } from "./validate.js";
export type { ValidationError } from "./validate.js";
