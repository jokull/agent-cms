/**
 * DAST (DatoCMS Abstract Syntax Tree) type definitions.
 * Matches the DatoCMS DAST specification for StructuredText.
 */

// --- Mark types ---
export type Mark = "strong" | "emphasis" | "underline" | "strikethrough" | "code" | "highlight";

// --- Inline nodes ---
export interface SpanNode {
  type: "span";
  value: string;
  marks?: readonly Mark[];
}

export interface LinkNode {
  type: "link";
  url: string;
  meta?: ReadonlyArray<{ id: string; value: string }>;
  children: readonly SpanNode[];
}

export interface ItemLinkNode {
  type: "itemLink";
  item: string; // Record ID
  meta?: ReadonlyArray<{ id: string; value: string }>;
  children: readonly SpanNode[];
}

export interface InlineItemNode {
  type: "inlineItem";
  item: string; // Record ID
}

export interface InlineBlockNode {
  type: "inlineBlock";
  item: string; // Block ID
}

export type InlineNode = SpanNode | LinkNode | ItemLinkNode | InlineItemNode | InlineBlockNode;

// --- Block-level nodes ---
export interface ParagraphNode {
  type: "paragraph";
  style?: string;
  children: readonly InlineNode[];
}

export interface HeadingNode {
  type: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  style?: string;
  children: readonly InlineNode[];
}

export interface ListNode {
  type: "list";
  style: "bulleted" | "numbered";
  children: readonly ListItemNode[];
}

export interface ListItemNode {
  type: "listItem";
  children: readonly (ParagraphNode | ListNode)[];
}

export interface BlockquoteNode {
  type: "blockquote";
  attribution?: string;
  children: readonly ParagraphNode[];
}

export interface CodeNode {
  type: "code";
  code: string;
  language?: string;
  highlight?: readonly number[];
}

export interface ThematicBreakNode {
  type: "thematicBreak";
}

export interface BlockNode {
  type: "block";
  item: string; // Block ID
}

export interface TableCellNode {
  type: "tableCell";
  children: readonly (ParagraphNode | InlineNode)[];
}

export interface TableRowNode {
  type: "tableRow";
  children: readonly [TableCellNode, ...TableCellNode[]];
}

export interface TableNode {
  type: "table";
  children: readonly [TableRowNode, ...TableRowNode[]];
}

export type BlockLevelNode =
  | ParagraphNode
  | HeadingNode
  | ListNode
  | BlockquoteNode
  | CodeNode
  | ThematicBreakNode
  | BlockNode
  | TableNode;

// --- Root ---
export interface RootNode {
  type: "root";
  children: readonly BlockLevelNode[];
}

export interface DastDocument {
  schema: "dast";
  document: RootNode;
}

/** The full StructuredText value as returned by GraphQL */
export interface StructuredTextValue {
  value: DastDocument;
  blocks: Readonly<Record<string, { type: string; [key: string]: unknown }>>;
  links?: Readonly<Record<string, { id: string; [key: string]: unknown }>>;
}
