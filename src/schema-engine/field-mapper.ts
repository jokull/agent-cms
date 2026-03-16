import { text, integer, real } from "drizzle-orm/sqlite-core";
import type { FieldType } from "../types.js";
import { getFieldTypeDef } from "../field-types.js";

/**
 * Maps a CMS field type to a Drizzle column builder.
 * Uses the field type registry for SQLite type, then creates the
 * appropriate Drizzle column with JSON mode for composite types.
 */
export function mapFieldToColumn(fieldType: FieldType, apiKey: string) {
  const def = getFieldTypeDef(fieldType);

  switch (def.sqliteType) {
    case "INTEGER":
      return fieldType === "boolean"
        ? integer(apiKey, { mode: "boolean" })
        : integer(apiKey);
    case "REAL":
      return real(apiKey);
    case "TEXT":
      return def.jsonStored
        ? text(apiKey, { mode: "json" })
        : text(apiKey);
  }
}
