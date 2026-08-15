/**
 * Per-model row decode schemas — the schema-driven face of the boundary
 * decode (Wave 11 of PLAN.md).
 *
 * `buildModelRowSchema` composes a `Schema.Struct` from a model's field
 * definitions (the statically-known bottom of the type sandwich) plus the
 * system columns every content table carries, so a content-table row can be
 * decoded — and optionally validated — in one pass at the SQL edge.
 *
 * Two decode flavors:
 * - `tolerantJsonField` (the DEFAULT field shape): parse the JSON string if
 *   it is valid JSON, else pass the raw string through. Byte-identical to
 *   `deserializeRecord`'s string-prefix sniffing for every input, without
 *   the heuristic.
 * - validating variant: `Schema.Union([Schema.fromJsonString(shape),
 *   Schema.String])` with a concrete shape (ColorSchema etc.) still parses
 *   wrong-shape JSON into the raw string rather than failing the row —
 *   strictness is opt-in at the caller, never a row rejection.
 */
import { Schema } from "effect";
import { ColorSchema, LatLonSchema, MediaFieldObjectSchema, SeoSchema } from "../field-types.js";
import { DastDocumentSchema } from "../dast/schema.js";
import type { ParsedFieldRow } from "../db/row-types.js";

/** Tolerant JSON field: parse valid JSON, pass unparseable strings through. */
export function tolerantJsonField(shape: Schema.Schema<unknown>): Schema.Schema<unknown> {
  return Schema.Union([Schema.fromJsonString(shape), Schema.String]);
}

/** JSON-stored field types: parsed as any valid JSON, strings pass through. */
function isJsonStoredFieldType(fieldType: string): boolean {
  switch (fieldType) {
    case "media": case "media_gallery": case "links": case "structured_text":
    case "seo": case "color": case "lat_lon": case "json": case "video": case "rich_text":
      return true;
    default:
      return false;
  }
}

/**
 * Read-shaped decode schema per field type — PARITY form (the default): any
 * valid JSON parses, unparseable strings pass through, byte-identical to
 * `deserializeRecord` for every input. Shape validation is opt-in via
 * `validatingFieldDecodeSchema`.
 */
export function fieldDecodeSchema(fieldType: string): Schema.Schema<unknown> | null {
  if (isJsonStoredFieldType(fieldType)) {
    return tolerantJsonField(Schema.Unknown);
  }
  switch (fieldType) {
    case "string": case "text": case "slug": case "date": case "date_time": case "link":
      return Schema.NullOr(Schema.String);
    case "integer": case "float":
      return Schema.NullOr(Schema.Number);
    case "boolean":
      // SQLite stores booleans as INTEGER 0/1; modern writes may store true/false.
      return Schema.NullOr(Schema.Union([Schema.Literal(0), Schema.Literal(1), Schema.Boolean]));
    default:
      return null;
  }
}

/**
 * VALIDATING form: parses JSON with the known composite shape
 * (ColorSchema, SeoSchema, ...). Wrong-shape JSON falls back to the raw
 * string rather than failing the row — strictness is a caller choice.
 */
export function validatingFieldDecodeSchema(fieldType: string): Schema.Schema<unknown> | null {
  switch (fieldType) {
    case "media":
      return tolerantJsonField(Schema.Union([Schema.String, MediaFieldObjectSchema]));
    case "media_gallery":
      return tolerantJsonField(Schema.Array(Schema.Union([Schema.String, MediaFieldObjectSchema])));
    case "links":
      return tolerantJsonField(Schema.Array(Schema.String));
    case "structured_text":
      return tolerantJsonField(DastDocumentSchema);
    case "seo":
      return tolerantJsonField(SeoSchema);
    case "color":
      return tolerantJsonField(ColorSchema);
    case "lat_lon":
      return tolerantJsonField(LatLonSchema);
    default:
      return fieldDecodeSchema(fieldType);
  }
}

/** System columns on every content table row (mirrors schema-engine DDL). */
export const CONTENT_SYSTEM_COLUMNS = [
  "id",
  "_status",
  "_published_at",
  "_first_published_at",
  "_published_snapshot",
  "_created_at",
  "_updated_at",
  "_created_by",
  "_updated_by",
  "_published_by",
  "_scheduled_publish_at",
  "_scheduled_unpublish_at",
] as const;

/** Sortable-model extra column. */
const POSITION_COLUMN = "_position";

/**
 * Compose the row schema for one model: system columns + one decode schema
 * per field (columns not covered by the registry decode as plain strings —
 * they still pass through, just unvalidated).
 */
export function buildModelRowSchema(
  fields: ReadonlyArray<ParsedFieldRow>,
  options: { sortable?: boolean } = {},
): Schema.Schema<Record<string, unknown>> {
  const entries: Record<string, Schema.Top> = {};
  for (const name of CONTENT_SYSTEM_COLUMNS) {
    entries[name] = name === "id"
      ? Schema.String
      : name === "_published_snapshot"
        ? tolerantJsonField(Schema.Unknown)
        : Schema.NullOr(Schema.String);
  }
  if (options.sortable) {
    entries[POSITION_COLUMN] = Schema.NullOr(Schema.Number);
  }
  for (const f of fields) {
    const shape = fieldDecodeSchema(f.field_type) ?? Schema.String;
    entries[f.api_key] = Schema.NullOr(shape);
  }
  return Schema.Struct(entries) as unknown as Schema.Schema<Record<string, unknown>>;
}
