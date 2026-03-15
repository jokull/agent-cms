/**
 * Effect Schema definitions for DAST documents.
 * Used for runtime-verified decoding of unknown input.
 */
import { Schema } from "effect";

/** Decode an unknown value as a DAST document (minimal structural check) */
export const DastDocumentInput = Schema.Struct({
  schema: Schema.Literal("dast"),
  document: Schema.Struct({
    type: Schema.Literal("root"),
    children: Schema.Array(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  }),
});

export type DastDocumentInput = typeof DastDocumentInput.Type;

/** Decode a StructuredText write payload */
export const StructuredTextWriteInput = Schema.Struct({
  value: DastDocumentInput,
  blocks: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    { default: () => ({}) }
  ),
});

export type StructuredTextWriteInput = typeof StructuredTextWriteInput.Type;
