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
  marks?: Mark[];
}

export interface LinkNode {
  type: "link";
  url: string;
  meta?: Array<{ id: string; value: string }>;
  children: SpanNode[];
}

export interface ItemLinkNode {
  type: "itemLink";
  item: string; // Record ID
  meta?: Array<{ id: string; value: string }>;
  children: SpanNode[];
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
  children: InlineNode[];
}

export interface HeadingNode {
  type: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  style?: string;
  children: InlineNode[];
}

export interface ListNode {
  type: "list";
  style: "bulleted" | "numbered";
  children: ListItemNode[];
}

export interface ListItemNode {
  type: "listItem";
  children: (ParagraphNode | ListNode)[];
}

export interface BlockquoteNode {
  type: "blockquote";
  attribution?: string;
  children: ParagraphNode[];
}

export interface CodeNode {
  type: "code";
  code: string;
  language?: string;
  highlight?: number[];
}

export interface ThematicBreakNode {
  type: "thematicBreak";
}

export interface BlockNode {
  type: "block";
  item: string; // Block ID
}

export type BlockLevelNode =
  | ParagraphNode
  | HeadingNode
  | ListNode
  | BlockquoteNode
  | CodeNode
  | ThematicBreakNode
  | BlockNode;

// --- Root ---
export interface RootNode {
  type: "root";
  children: BlockLevelNode[];
}

export interface DastDocument {
  schema: "dast";
  document: RootNode;
}

/** The full StructuredText value as returned by GraphQL */
export interface StructuredTextValue {
  value: DastDocument;
  blocks: Record<string, { type: string; [key: string]: any }>;
  links?: Record<string, { id: string; [key: string]: any }>;
}
