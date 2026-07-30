/**
 * DAST (DatoCMS Abstract Syntax Tree) type definitions and grammar constants.
 *
 * This package is the single source of truth for DAST shapes across agent-cms:
 * the CMS itself (`src/dast/types.ts` re-exports it), `@agent-cms/editor-react`'s
 * bridge, and the `contract.ts` emitted by `@agent-cms/codegen`. It has **zero
 * runtime dependencies** and contains only types, grammar constants, and pure
 * predicates, so importing it from a browser bundle costs nothing.
 *
 * The Effect Schema validators live in the CMS (`src/dast/schema.ts`) because
 * they depend on `effect`; they build on the constants exported here.
 */

// --- Mark types ---

/** The six marks every DatoCMS project supports out of the box. */
export type DefaultMark =
  | "strong"
  | "emphasis"
  | "underline"
  | "strikethrough"
  | "code"
  | "highlight";

/** Ordered list of the default marks, shared by the schema and the markdown projection. */
export const DEFAULT_MARKS: readonly DefaultMark[] = [
  "strong",
  "emphasis",
  "underline",
  "strikethrough",
  "code",
  "highlight",
];

/** Naming-convention prefix every project-defined mark must carry. */
export const CUSTOM_MARK_PREFIX = "customMark_";

/**
 * Project-defined marks. DatoCMS' CMA lets a project register custom marks
 * (e.g. `customMark_kbd`) that render however the receiving app likes; the
 * DAST spec only constrains the naming convention, not the suffix.
 */
export type CustomMark = `customMark_${string}`;

export type Mark = DefaultMark | CustomMark;

/** True for one of the six built-in marks. */
export function isDefaultMark(value: string): value is DefaultMark {
  const marks: readonly string[] = DEFAULT_MARKS;
  return marks.includes(value);
}

/** True for a project-defined `customMark_*` mark with a non-empty suffix. */
export function isCustomMark(value: string): value is CustomMark {
  return value.startsWith(CUSTOM_MARK_PREFIX) && value.length > CUSTOM_MARK_PREFIX.length;
}

/** True for any mark the DAST grammar accepts (default or custom). */
export function isMark(value: string): value is Mark {
  return isDefaultMark(value) || isCustomMark(value);
}

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
  children: readonly [ParagraphNode, ...ParagraphNode[]];
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

/** Any node in the tree, root excluded. */
export type DastNode = RootNode | BlockLevelNode | ListItemNode | TableRowNode | TableCellNode | InlineNode;

// --- Root ---

export interface RootNode {
  type: "root";
  children: readonly BlockLevelNode[];
}

export interface DastDocument {
  schema: "dast";
  document: RootNode;
}

/** An empty, valid DAST document — the canonical "no content yet" value. */
export function emptyDastDocument(): DastDocument {
  return { schema: "dast", document: { type: "root", children: [] } };
}

/** The full StructuredText value as returned by GraphQL and the REST read path. */
export interface StructuredTextValue {
  value: DastDocument;
  blocks: Readonly<Record<string, { type: string; [key: string]: unknown }>>;
  links?: Readonly<Record<string, { id: string; [key: string]: unknown }>>;
}
