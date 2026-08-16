/**
 * Effect Schema definitions for DAST documents.
 * Comprehensive recursive schemas for full validation of DAST nodes.
 */
import { Effect, Schema } from "effect";
import { DEFAULT_MARKS } from "./types.js";

// --- Marks ---
/** The six marks every project gets for free. */
const DefaultMarkSchema = Schema.Literals(DEFAULT_MARKS);
/**
 * Project-defined marks, e.g. `customMark_kbd`. DatoCMS' CMA lets a project
 * register arbitrary custom marks; only the `customMark_` prefix is fixed.
 */
const CustomMarkSchema = Schema.TemplateLiteral(["customMark_", Schema.String]);
export const MarkSchema = Schema.Union([DefaultMarkSchema, CustomMarkSchema]);

// --- Link meta ---
const LinkMetaEntry = Schema.Struct({
  id: Schema.String,
  value: Schema.String,
});

// --- Inline node schemas ---
export const SpanNodeSchema = Schema.Struct({
  type: Schema.Literal("span"),
  value: Schema.String,
  marks: Schema.optionalKey(Schema.Array(MarkSchema)),
});

export const LinkNodeSchema = Schema.Struct({
  type: Schema.Literal("link"),
  url: Schema.NonEmptyString,
  meta: Schema.optionalKey(Schema.Array(LinkMetaEntry)),
  children: Schema.Array(SpanNodeSchema),
});

export const ItemLinkNodeSchema = Schema.Struct({
  type: Schema.Literal("itemLink"),
  item: Schema.NonEmptyString,
  meta: Schema.optionalKey(Schema.Array(LinkMetaEntry)),
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

export const InlineNodeSchema = Schema.Union([
  SpanNodeSchema,
  LinkNodeSchema,
  ItemLinkNodeSchema,
  InlineItemNodeSchema,
  InlineBlockNodeSchema,
]);

// --- Block-level node schemas ---
export const ParagraphNodeSchema = Schema.Struct({
  type: Schema.Literal("paragraph"),
  style: Schema.optionalKey(Schema.String),
  children: Schema.Array(InlineNodeSchema),
});

const HeadingLevel = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.check(Schema.isLessThanOrEqualTo(6)),
);

export const HeadingNodeSchema = Schema.Struct({
  type: Schema.Literal("heading"),
  level: HeadingLevel,
  style: Schema.optionalKey(Schema.String),
  children: Schema.Array(InlineNodeSchema),
});

// Forward-declare interfaces for the recursive list schemas
interface ListItemNodeType {
  readonly type: "listItem";
  readonly children: ReadonlyArray<
    | typeof ParagraphNodeSchema.Type
    | ListNodeType
  >;
}

interface ListNodeType {
  readonly type: "list";
  readonly style: "bulleted" | "numbered";
  readonly children: ReadonlyArray<ListItemNodeType>;
}

export const ListNodeSchema: Schema.Codec<ListNodeType> = Schema.suspend((): Schema.Codec<ListNodeType> =>
  Schema.Struct({
    type: Schema.Literal("list"),
    style: Schema.Literals(["bulleted", "numbered"]),
    children: Schema.Array(ListItemNodeSchema),
  })
);

export const ListItemNodeSchema: Schema.Codec<ListItemNodeType> = Schema.suspend((): Schema.Codec<ListItemNodeType> =>
  Schema.Struct({
    type: Schema.Literal("listItem"),
    children: Schema.Array(Schema.Union([
      ParagraphNodeSchema,
      ListNodeSchema,
    ])),
  })
);

export const BlockquoteNodeSchema = Schema.Struct({
  type: Schema.Literal("blockquote"),
  attribution: Schema.optionalKey(Schema.String),
  children: Schema.Array(ParagraphNodeSchema),
});

export const CodeNodeSchema = Schema.Struct({
  type: Schema.Literal("code"),
  code: Schema.String,
  language: Schema.optionalKey(Schema.String),
  highlight: Schema.optionalKey(Schema.Array(Schema.Number)),
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
  // paragraph+ — inline nodes must be wrapped in a paragraph. Mixing block and
  // inline siblings is unrepresentable in every structured editor (ProseMirror
  // rejects it, Slate silently destroys it), so the grammar forbids it.
  children: Schema.NonEmptyArray(ParagraphNodeSchema),
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
export const BlockLevelNodeSchema = Schema.Union([
  ParagraphNodeSchema,
  HeadingNodeSchema,
  ListNodeSchema,
  BlockquoteNodeSchema,
  CodeNodeSchema,
  ThematicBreakNodeSchema,
  BlockRefNodeSchema,
  TableNodeSchema,
]);

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
  blocks: Schema.Record(Schema.String, Schema.Unknown).pipe(
    Schema.withDecodingDefaultType(Effect.sync(() => ({}))),
  ),
});

export type StructuredTextWriteInput = typeof StructuredTextWriteInput.Type;
