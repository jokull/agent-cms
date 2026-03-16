/** Field types supported in v1 */
export const FIELD_TYPES = [
  "string",
  "text",
  "boolean",
  "integer",
  "slug",
  "media",
  "media_gallery",
  "link",
  "links",
  "structured_text",
  "seo",
  "json",
  "float",
  "date",
  "date_time",
  "color",
  "lat_lon",
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/** Type guard for FieldType */
export function isFieldType(value: string): value is FieldType {
  return (FIELD_TYPES as readonly string[]).includes(value);
}

/** Record publication status */
export const RECORD_STATUSES = ["draft", "published", "updated"] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

// CmsBindings is exported from src/index.ts
