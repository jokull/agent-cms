/**
 * Effect Schema definitions for REST API request body validation.
 * Replaces manual type guard functions with runtime-verified decoding.
 */
import { Schema } from "effect";

export const CreateModelInput = Schema.Struct({
  name: Schema.NonEmptyString,
  apiKey: Schema.NonEmptyString,
  isBlock: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  singleton: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  sortable: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  tree: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  hasDraft: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  allLocalesRequired: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  ordering: Schema.optional(Schema.String),
});
export type CreateModelInput = typeof CreateModelInput.Type;

export const CreateFieldInput = Schema.Struct({
  label: Schema.NonEmptyString,
  apiKey: Schema.NonEmptyString,
  fieldType: Schema.NonEmptyString,
  position: Schema.optional(Schema.Number),
  localized: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  validators: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    { default: () => ({}) }
  ),
  defaultValue: Schema.optional(Schema.Unknown),
  appearance: Schema.optional(Schema.Unknown),
  hint: Schema.optional(Schema.String),
  fieldsetId: Schema.optional(Schema.String),
});
export type CreateFieldInput = typeof CreateFieldInput.Type;

export const CreateRecordInput = Schema.Struct({
  id: Schema.optional(Schema.String),
  modelApiKey: Schema.NonEmptyString,
  data: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    { default: () => ({}) }
  ),
  overrides: Schema.optional(
    Schema.Struct({
      createdAt: Schema.optional(Schema.String),
      updatedAt: Schema.optional(Schema.String),
      publishedAt: Schema.optional(Schema.String),
      firstPublishedAt: Schema.optional(Schema.String),
    })
  ),
});
export type CreateRecordInput = typeof CreateRecordInput.Type;

export const PatchRecordInput = Schema.Struct({
  modelApiKey: Schema.NonEmptyString,
  data: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    { default: () => ({}) }
  ),
  overrides: Schema.optional(
    Schema.Struct({
      createdAt: Schema.optional(Schema.String),
      updatedAt: Schema.optional(Schema.String),
      publishedAt: Schema.optional(Schema.String),
      firstPublishedAt: Schema.optional(Schema.String),
    })
  ),
});
export type PatchRecordInput = typeof PatchRecordInput.Type;

export const CreateAssetInput = Schema.Struct({
  id: Schema.optional(Schema.String),
  filename: Schema.NonEmptyString,
  mimeType: Schema.NonEmptyString,
  size: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
  alt: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  r2Key: Schema.optional(Schema.String),
  blurhash: Schema.optional(Schema.String),
  colors: Schema.optional(Schema.Array(Schema.String)),
  focalPoint: Schema.optional(Schema.Struct({ x: Schema.Number, y: Schema.Number })),
  tags: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
});
export type CreateAssetInput = typeof CreateAssetInput.Type;

export const ReorderInput = Schema.Struct({
  modelApiKey: Schema.NonEmptyString,
  recordIds: Schema.Array(Schema.String),
});
export type ReorderInput = typeof ReorderInput.Type;

// ColorInput and LatLonInput schemas moved to src/field-types.ts (field type registry)

export const CreateLocaleInput = Schema.Struct({
  code: Schema.NonEmptyString,
  position: Schema.optional(Schema.Number),
  fallbackLocaleId: Schema.optional(Schema.String),
});
export type CreateLocaleInput = typeof CreateLocaleInput.Type;
