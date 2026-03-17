/**
 * Effect Schema definitions for DAST documents.
 * Comprehensive recursive schemas for full validation of DAST nodes.
 */
import { Schema } from "effect";

// --- Marks ---
export const MarkSchema = Schema.Literal(
  "strong", "emphasis", "underline", "strikethrough", "code", "highlight"
);

// --- Link meta ---
const LinkMetaEntry = Schema.Struct({
  id: Schema.String,
  value: Schema.String,
});

// --- Inline node schemas ---
export const SpanNodeSchema = Schema.Struct({
  type: Schema.Literal("span"),
  value: Schema.String,
  marks: Schema.optionalWith(Schema.Array(MarkSchema), { exact: true }),
});

export const LinkNodeSchema = Schema.Struct({
  type: Schema.Literal("link"),
  url: Schema.NonEmptyString,
  meta: Schema.optionalWith(Schema.Array(LinkMetaEntry), { exact: true }),
  children: Schema.Array(SpanNodeSchema),
});

export const ItemLinkNodeSchema = Schema.Struct({
  type: Schema.Literal("itemLink"),
  item: Schema.NonEmptyString,
  meta: Schema.optionalWith(Schema.Array(LinkMetaEntry), { exact: true }),
  children: Schema.Array(SpanNodeSchema),
});

export const InlineItemNodeSchema = Schema.Struct({
  type: Schema.Literal("inlineItem"),
  item: Schema.NonEmptyString,
});

export const InlineBlockNodeSchema = Schema.Struct({
  type: Schema.Literal("inlineBlock"),
  item: Schema.NonEmptyString,
});

export const InlineNodeSchema = Schema.Union(
  SpanNodeSchema,
  LinkNodeSchema,
  ItemLinkNodeSchema,
  InlineItemNodeSchema,
  InlineBlockNodeSchema,
);

// --- Block-level node schemas ---
export const ParagraphNodeSchema = Schema.Struct({
  type: Schema.Literal("paragraph"),
  style: Schema.optionalWith(Schema.String, { exact: true }),
  children: Schema.Array(InlineNodeSchema),
});

const HeadingLevel = Schema.Number.pipe(
  Schema.int(),
  Schema.greaterThanOrEqualTo(1),
  Schema.lessThanOrEqualTo(6),
);

export const HeadingNodeSchema = Schema.Struct({
  type: Schema.Literal("heading"),
  level: HeadingLevel,
  style: Schema.optionalWith(Schema.String, { exact: true }),
  children: Schema.Array(InlineNodeSchema),
});

export const ListItemNodeSchema: Schema.Schema<ListItemNode, ListItemNodeEncoded> = Schema.Struct({
  type: Schema.Literal("listItem"),
  children: Schema.Array(Schema.Union(
    ParagraphNodeSchema,
    Schema.suspend((): Schema.Schema<ListNode, ListNodeEncoded> => ListNodeSchema),
  )),
});

export const ListNodeSchema = Schema.Struct({
  type: Schema.Literal("list"),
  style: Schema.Literal("bulleted", "numbered"),
  children: Schema.Array(ListItemNodeSchema),
});

export const BlockquoteNodeSchema = Schema.Struct({
  type: Schema.Literal("blockquote"),
  attribution: Schema.optionalWith(Schema.String, { exact: true }),
  children: Schema.Array(ParagraphNodeSchema),
});

export const CodeNodeSchema = Schema.Struct({
  type: Schema.Literal("code"),
  code: Schema.String,
  language: Schema.optionalWith(Schema.String, { exact: true }),
  highlight: Schema.optionalWith(Schema.Array(Schema.Number), { exact: true }),
});

export const ThematicBreakNodeSchema = Schema.Struct({
  type: Schema.Literal("thematicBreak"),
});

export const BlockRefNodeSchema = Schema.Struct({
  type: Schema.Literal("block"),
  item: Schema.NonEmptyString,
});

// --- Table schemas ---
export const TableCellNodeSchema = Schema.Struct({
  type: Schema.Literal("tableCell"),
  children: Schema.Array(Schema.Union(ParagraphNodeSchema, InlineNodeSchema)),
});

export const TableRowNodeSchema = Schema.Struct({
  type: Schema.Literal("tableRow"),
  children: Schema.NonEmptyArray(TableCellNodeSchema),
});

export const TableNodeSchema = Schema.Struct({
  type: Schema.Literal("table"),
  children: Schema.NonEmptyArray(TableRowNodeSchema),
});

// --- Block-level union ---
export const BlockLevelNodeSchema = Schema.Union(
  ParagraphNodeSchema,
  HeadingNodeSchema,
  ListNodeSchema,
  BlockquoteNodeSchema,
  CodeNodeSchema,
  ThematicBreakNodeSchema,
  BlockRefNodeSchema,
  TableNodeSchema,
);

// --- Root and document ---
export const RootNodeSchema = Schema.Struct({
  type: Schema.Literal("root"),
  children: Schema.Array(BlockLevelNodeSchema),
});

export const DastDocumentSchema = Schema.Struct({
  schema: Schema.Literal("dast"),
  document: RootNodeSchema,
});

/** Backward-compatible alias */
export const DastDocumentInput = DastDocumentSchema;
export type DastDocumentInput = typeof DastDocumentSchema.Type;

/** Decode a StructuredText write payload */
export const StructuredTextWriteInput = Schema.Struct({
  value: DastDocumentSchema,
  blocks: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    { default: () => ({}) }
  ),
});

export type StructuredTextWriteInput = typeof StructuredTextWriteInput.Type;

// --- Type helpers for recursive schemas ---
type ListNode = typeof ListNodeSchema.Type;
type ListNodeEncoded = typeof ListNodeSchema.Encoded;
type ListItemNode = typeof ListItemNodeSchema.Type;
type ListItemNodeEncoded = typeof ListItemNodeSchema.Encoded;
