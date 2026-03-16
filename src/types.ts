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
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/** Record publication status */
export const RECORD_STATUSES = ["draft", "published", "updated"] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

/** Cloudflare Worker environment bindings */
export interface Env {
  DB: D1Database;
  ENVIRONMENT: string;
}
