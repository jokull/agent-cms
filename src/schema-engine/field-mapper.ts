import { text, integer } from "drizzle-orm/sqlite-core";
import type { FieldType } from "../types.js";

/**
 * Maps a CMS field type to a Drizzle column builder.
 * Returns a function that creates the column given an api_key.
 */
export function mapFieldToColumn(fieldType: FieldType, apiKey: string) {
  switch (fieldType) {
    case "string":
      return text(apiKey);
    case "text":
      return text(apiKey);
    case "boolean":
      return integer(apiKey, { mode: "boolean" });
    case "integer":
      return integer(apiKey);
    case "slug":
      return text(apiKey);
    case "media":
      // FK to assets table, stored as ULID text
      return text(apiKey);
    case "media_gallery":
      // JSON array of asset IDs
      return text(apiKey, { mode: "json" });
    case "link":
      // FK to another content table, stored as ULID text
      return text(apiKey);
    case "links":
      // JSON array of record IDs
      return text(apiKey, { mode: "json" });
    case "structured_text":
      // DAST JSON document
      return text(apiKey, { mode: "json" });
    case "seo":
      // SEO metadata JSON object
      return text(apiKey, { mode: "json" });
    case "json":
      // Arbitrary JSON storage
      return text(apiKey, { mode: "json" });
    case "float":
      // Floating point number stored as REAL
      return text(apiKey); // SQLite stores as TEXT, parsed to float
    default: {
      const _exhaustive: never = fieldType;
      throw new Error(`Unknown field type: ${_exhaustive}`);
    }
  }
}
