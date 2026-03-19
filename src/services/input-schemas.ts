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

export const SearchAssetsInput = Schema.Struct({
  query: Schema.optional(Schema.String),
  limit: Schema.optionalWith(Schema.Number, { default: () => 24 }),
  offset: Schema.optionalWith(Schema.Number, { default: () => 0 }),
});
export type SearchAssetsInput = typeof SearchAssetsInput.Type;

export const UpdateAssetMetadataInput = Schema.Struct({
  alt: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
});
export type UpdateAssetMetadataInput = typeof UpdateAssetMetadataInput.Type;

export const ReorderInput = Schema.Struct({
  modelApiKey: Schema.NonEmptyString,
  recordIds: Schema.Array(Schema.String),
});
export type ReorderInput = typeof ReorderInput.Type;

export const SearchInput = Schema.Struct({
  query: Schema.String,
  modelApiKey: Schema.optional(Schema.String),
  first: Schema.optional(Schema.Number),
  skip: Schema.optional(Schema.Number),
  mode: Schema.optional(Schema.Literal("keyword", "semantic", "hybrid")),
});
export type SearchInput = typeof SearchInput.Type;

export const ReindexSearchInput = Schema.Struct({
  modelApiKey: Schema.optional(Schema.String),
});
export type ReindexSearchInput = typeof ReindexSearchInput.Type;

// ColorInput and LatLonInput schemas moved to src/field-types.ts (field type registry)

export const CreateLocaleInput = Schema.Struct({
  code: Schema.NonEmptyString,
  position: Schema.optional(Schema.Number),
  fallbackLocaleId: Schema.optional(Schema.String),
});
export type CreateLocaleInput = typeof CreateLocaleInput.Type;

export const UpdateModelInput = Schema.Struct({
  name: Schema.optional(Schema.NonEmptyString),
  apiKey: Schema.optional(Schema.NonEmptyString),
  singleton: Schema.optional(Schema.Boolean),
  sortable: Schema.optional(Schema.Boolean),
  hasDraft: Schema.optional(Schema.Boolean),
  allLocalesRequired: Schema.optional(Schema.Boolean),
});
export type UpdateModelInput = typeof UpdateModelInput.Type;

export const UpdateFieldInput = Schema.Struct({
  label: Schema.optional(Schema.NonEmptyString),
  apiKey: Schema.optional(Schema.NonEmptyString),
  fieldType: Schema.optional(Schema.NonEmptyString),
  position: Schema.optional(Schema.Number),
  localized: Schema.optional(Schema.Boolean),
  validators: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown })
  ),
  hint: Schema.optional(Schema.String),
  appearance: Schema.optional(Schema.Unknown),
});
export type UpdateFieldInput = typeof UpdateFieldInput.Type;

export const BulkCreateRecordsInput = Schema.Struct({
  modelApiKey: Schema.NonEmptyString,
  records: Schema.Array(
    Schema.Record({ key: Schema.String, value: Schema.Unknown })
  ),
});
export type BulkCreateRecordsInput = typeof BulkCreateRecordsInput.Type;

const SchemaExportFieldSchema = Schema.Struct({
  label: Schema.String,
  apiKey: Schema.String,
  fieldType: Schema.String,
  position: Schema.Number,
  localized: Schema.Boolean,
  validators: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  hint: Schema.NullOr(Schema.String),
});

const SchemaExportModelSchema = Schema.Struct({
  name: Schema.String,
  apiKey: Schema.String,
  isBlock: Schema.Boolean,
  singleton: Schema.Boolean,
  sortable: Schema.Boolean,
  tree: Schema.Boolean,
  hasDraft: Schema.Boolean,
  fields: Schema.Array(SchemaExportFieldSchema),
});

const SchemaExportLocaleSchema = Schema.Struct({
  code: Schema.String,
  position: Schema.Number,
  fallbackLocale: Schema.NullOr(Schema.String),
});

export const PatchBlocksInput = Schema.Struct({
  recordId: Schema.NonEmptyString,
  modelApiKey: Schema.NonEmptyString,
  fieldApiKey: Schema.NonEmptyString,
  value: Schema.optional(Schema.Unknown),
  blocks: Schema.Record({ key: Schema.String, value: Schema.NullOr(Schema.Unknown) }),
});
export type PatchBlocksInput = typeof PatchBlocksInput.Type;

export const ImportSchemaInput = Schema.Struct({
  version: Schema.Literal(1),
  locales: Schema.optionalWith(Schema.Array(SchemaExportLocaleSchema), { default: () => [] }),
  models: Schema.Array(SchemaExportModelSchema),
});
export type ImportSchemaInput = typeof ImportSchemaInput.Type;

export const CreateUploadUrlInput = Schema.Struct({
  filename: Schema.NonEmptyString,
  mimeType: Schema.NonEmptyString,
});
export type CreateUploadUrlInput = typeof CreateUploadUrlInput.Type;

export const CreateEditorTokenInput = Schema.Struct({
  name: Schema.NonEmptyString,
  expiresIn: Schema.optional(Schema.Number),
});
export type CreateEditorTokenInput = typeof CreateEditorTokenInput.Type;
