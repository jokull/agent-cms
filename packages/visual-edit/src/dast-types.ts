/** Inlined DAST type definitions — subset needed for markdown conversion. */

export type Mark = "strong" | "emphasis" | "underline" | "strikethrough" | "code" | "highlight";

export interface SpanNode { type: "span"; value: string; marks?: readonly Mark[]; }
export interface LinkNode { type: "link"; url: string; meta?: ReadonlyArray<{ id: string; value: string }>; children: readonly SpanNode[]; }
export interface ItemLinkNode { type: "itemLink"; item: string; meta?: ReadonlyArray<{ id: string; value: string }>; children: readonly SpanNode[]; }
export interface InlineItemNode { type: "inlineItem"; item: string; }
export interface InlineBlockNode { type: "inlineBlock"; item: string; }
export type InlineNode = SpanNode | LinkNode | ItemLinkNode | InlineItemNode | InlineBlockNode;

export interface ParagraphNode { type: "paragraph"; style?: string; children: readonly InlineNode[]; }
export interface HeadingNode { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; style?: string; children: readonly InlineNode[]; }
export interface ListNode { type: "list"; style: "bulleted" | "numbered"; children: readonly ListItemNode[]; }
export interface ListItemNode { type: "listItem"; children: readonly (ParagraphNode | ListNode)[]; }
export interface BlockquoteNode { type: "blockquote"; attribution?: string; children: readonly ParagraphNode[]; }
export interface CodeNode { type: "code"; code: string; language?: string; highlight?: readonly number[]; }
export interface ThematicBreakNode { type: "thematicBreak"; }
export interface BlockNode { type: "block"; item: string; }
export interface TableCellNode { type: "tableCell"; children: readonly (ParagraphNode | InlineNode)[]; }
export interface TableRowNode { type: "tableRow"; children: readonly [TableCellNode, ...TableCellNode[]]; }
export interface TableNode { type: "table"; children: readonly [TableRowNode, ...TableRowNode[]]; }

export type BlockLevelNode =
  | ParagraphNode | HeadingNode | ListNode | BlockquoteNode
  | CodeNode | ThematicBreakNode | BlockNode | TableNode;

export interface RootNode { type: "root"; children: readonly BlockLevelNode[]; }
export interface DastDocument { schema: "dast"; document: RootNode; }
