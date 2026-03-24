/**
 * Effect Schema definitions for REST API request body validation.
 * Replaces manual type guard functions with runtime-verified decoding.
 */
import { Schema } from "effect";

const Int = Schema.Number.pipe(Schema.int());

function finiteNumber(message: string) {
  return Schema.Number.pipe(
    Schema.filter((value) => Number.isFinite(value), { message: () => message }),
  );
}

function positiveInt(label: string) {
  return Int.pipe(
    Schema.filter((value) => Number.isFinite(value) && value > 0, {
      message: () => `${label} must be a positive integer`,
    }),
  );
}

function nonNegativeFiniteNumber(label: string) {
  return finiteNumber(`${label} must be a finite number`).pipe(
    Schema.filter((value) => value >= 0, { message: () => `${label} must be >= 0` }),
  );
}

const UnitIntervalNumber = finiteNumber("Expected a finite number").pipe(
  Schema.filter((value) => value >= 0 && value <= 1, {
    message: () => "Expected a number between 0 and 1",
  }),
);

const HttpUrlString = Schema.String.pipe(
  Schema.filter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }, { message: () => "Expected a valid http:// or https:// URL" }),
);

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
  canonicalPathTemplate: Schema.optional(Schema.NullOr(Schema.String)),
});
export type CreateModelInput = typeof CreateModelInput.Type;

export const CreateFieldInput = Schema.Struct({
  label: Schema.NonEmptyString,
  apiKey: Schema.NonEmptyString,
  fieldType: Schema.NonEmptyString,
  position: Schema.optional(Int.pipe(
    Schema.filter((value) => value >= 0, { message: () => "position must be >= 0" }),
  )),
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
  size: Schema.optionalWith(nonNegativeFiniteNumber("size"), { default: () => 0 }),
  width: Schema.optional(nonNegativeFiniteNumber("width")),
  height: Schema.optional(nonNegativeFiniteNumber("height")),
  alt: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  r2Key: Schema.optional(Schema.String),
  blurhash: Schema.optional(Schema.String),
  colors: Schema.optional(Schema.Array(Schema.String).pipe(
    Schema.filter((value) => value.length <= 16, { message: () => "colors must contain at most 16 entries" }),
  )),
  focalPoint: Schema.optional(Schema.Struct({ x: UnitIntervalNumber, y: UnitIntervalNumber })),
  tags: Schema.optionalWith(
    Schema.Array(Schema.String).pipe(
      Schema.filter((value) => value.length <= 50, { message: () => "tags must contain at most 50 entries" }),
    ),
    { default: () => [] },
  ),
});
export type CreateAssetInput = typeof CreateAssetInput.Type;

export const ImportAssetFromUrlInput = Schema.Struct({
  url: HttpUrlString,
  filename: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  alt: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  tags: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
});
export type ImportAssetFromUrlInput = typeof ImportAssetFromUrlInput.Type;

export const SearchAssetsInput = Schema.Struct({
  query: Schema.optional(Schema.String),
  limit: Schema.optionalWith(positiveInt("limit"), { default: () => 24 }),
  offset: Schema.optionalWith(Int.pipe(
    Schema.filter((value) => value >= 0, { message: () => "offset must be >= 0" }),
  ), { default: () => 0 }),
});
export type SearchAssetsInput = typeof SearchAssetsInput.Type;

export const UpdateAssetMetadataInput = Schema.Struct({
  alt: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
});
export type UpdateAssetMetadataInput = typeof UpdateAssetMetadataInput.Type;

export const ReorderInput = Schema.Struct({
  modelApiKey: Schema.NonEmptyString,
  recordIds: Schema.Array(Schema.String).pipe(
    Schema.filter((value) => value.length <= 1000, { message: () => "recordIds must contain at most 1000 entries" }),
  ),
});
export type ReorderInput = typeof ReorderInput.Type;

export const BulkRecordOperationInput = Schema.Struct({
  modelApiKey: Schema.NonEmptyString,
  recordIds: Schema.Array(Schema.String).pipe(
    Schema.filter((value) => value.length >= 1, { message: () => "recordIds must contain at least 1 entry" }),
    Schema.filter((value) => value.length <= 1000, { message: () => "recordIds must contain at most 1000 entries" }),
  ),
});
export type BulkRecordOperationInput = typeof BulkRecordOperationInput.Type;

export const ScheduleRecordInput = Schema.Struct({
  modelApiKey: Schema.NonEmptyString,
  at: Schema.NullOr(Schema.String.pipe(
    Schema.filter((value) => !Number.isNaN(Date.parse(value)), {
      message: () => "at must be a valid ISO datetime string or null",
    }),
  )),
});
export type ScheduleRecordInput = typeof ScheduleRecordInput.Type;

export const SearchInput = Schema.Struct({
  query: Schema.String,
  modelApiKey: Schema.optional(Schema.String),
  first: Schema.optional(positiveInt("first")),
  skip: Schema.optional(Int.pipe(
    Schema.filter((value) => value >= 0, { message: () => "skip must be >= 0" }),
  )),
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
  position: Schema.optional(Int.pipe(
    Schema.filter((value) => value >= 0, { message: () => "position must be >= 0" }),
  )),
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
  ordering: Schema.optional(Schema.NullOr(Schema.String)),
  canonicalPathTemplate: Schema.optional(Schema.NullOr(Schema.String)),
});
export type UpdateModelInput = typeof UpdateModelInput.Type;

export const UpdateFieldInput = Schema.Struct({
  label: Schema.optional(Schema.NonEmptyString),
  apiKey: Schema.optional(Schema.NonEmptyString),
  fieldType: Schema.optional(Schema.NonEmptyString),
  position: Schema.optional(Int.pipe(
    Schema.filter((value) => value >= 0, { message: () => "position must be >= 0" }),
  )),
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
  ordering: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  canonicalPathTemplate: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
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
  order: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  blocks: Schema.Record({ key: Schema.String, value: Schema.NullOr(Schema.Unknown) }),
  append: Schema.optional(Schema.Array(Schema.Record({ key: Schema.String, value: Schema.Unknown }))),
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
  expiresIn: Schema.optional(Int.pipe(
    Schema.positive(),
    Schema.filter((value) => value <= 60 * 60 * 24 * 365, {
      message: () => "expiresIn must be <= 31536000 seconds",
    }),
  )),
});
export type CreateEditorTokenInput = typeof CreateEditorTokenInput.Type;
