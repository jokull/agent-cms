import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { decodeJsonRecordStringOr } from "../json.js";

/**
 * Typed access to field validator properties.
 * Instead of casting with `as`, these functions safely extract
 * known validator properties with runtime checks.
 */

/** Safely get the slug source field from validators */
export function getSlugSource(validators: Record<string, unknown>): string | undefined {
  const v = validators.slug_source;
  return typeof v === "string" ? v : undefined;
}

/** Safely get the structured_text_blocks whitelist */
export function getBlockWhitelist(validators: Record<string, unknown>): string[] | undefined {
  const v = validators.structured_text_blocks;
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined;
}

/** Safely get the blocks_only flag */
export function getBlocksOnly(validators: Record<string, unknown>): boolean {
  return validators.blocks_only === true;
}

/** Safely check if field is required */
export function isRequired(validators: Record<string, unknown>): boolean {
  return validators.required === true;
}

/** Safely check if field must be unique */
export function isUnique(validators: Record<string, unknown>): boolean {
  return validators.unique === true;
}

/** Safely get link target model types (for `link` fields) */
export function getLinkTargets(validators: Record<string, unknown>): string[] | undefined {
  const v = validators.item_item_type;
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined;
}

/** Safely get links target model types (for `links` fields) */
export function getLinksTargets(validators: Record<string, unknown>): string[] | undefined {
  const v = validators.items_item_type;
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined;
}

/** Check if field is searchable (default: true — opt out with {"searchable": false}) */
export function isSearchable(validators: Record<string, unknown>): boolean {
  return validators.searchable !== false;
}

/** Field types where exact-value uniqueness is supported */
export function supportsUniqueValidation(fieldType: string): boolean {
  return [
    "string",
    "text",
    "slug",
    "integer",
    "float",
    "boolean",
    "date",
    "date_time",
    "link",
    "media",
  ].includes(fieldType);
}

/**
 * Compute whether a record is valid (all required fields have values).
 * For localized required fields, checks the default locale key in the JSON map.
 * When allLocales is provided, checks all locale keys (for all_locales_required models).
 * Returns { valid, missingFields } where missingFields lists api_keys that are missing.
 */
export function computeIsValid(
  record: Record<string, unknown>,
  fields: ReadonlyArray<{ api_key: string; localized: number; validators: Record<string, unknown> }>,
  defaultLocale: string | null,
  allLocales?: readonly string[]
): { valid: boolean; missingFields: string[] } {
  const missingFields: string[] = [];
  for (const field of fields) {
    if (!isRequired(field.validators)) continue;
    const value = record[field.api_key];
    if (field.localized && defaultLocale) {
      // Localized field: check locale keys in JSON map
      let localeMap = value;
      if (typeof localeMap === "string") {
        try { localeMap = JSON.parse(localeMap); } catch { missingFields.push(field.api_key); continue; }
      }
      if (typeof localeMap !== "object" || localeMap === null) {
        missingFields.push(field.api_key);
        continue;
      }
      const map = localeMap as Record<string, unknown>;
      // When allLocales is set, check every locale; otherwise just the default
      const localesToCheck = allLocales ?? [defaultLocale];
      for (const locale of localesToCheck) {
        const locValue = map[locale];
        if (locValue === null || locValue === undefined || locValue === "") {
          missingFields.push(field.api_key);
          break; // One missing locale is enough to mark the field invalid
        }
      }
    } else {
      if (value === null || value === undefined || value === "") {
        missingFields.push(field.api_key);
      }
    }
  }
  return { valid: missingFields.length === 0, missingFields };
}

export function findUniqueConstraintViolations(options: {
  tableName: string;
  record: Record<string, unknown>;
  fields: ReadonlyArray<{ api_key: string; localized: number; field_type: string; validators: Record<string, unknown> }>;
  excludeId?: string | null;
  onlyFieldApiKeys?: ReadonlySet<string>;
}) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const invalidFields = new Set<string>();

    for (const field of options.fields) {
      if (!isUnique(field.validators) || !supportsUniqueValidation(field.field_type)) continue;
      if (options.onlyFieldApiKeys && !options.onlyFieldApiKeys.has(field.api_key)) continue;

      const value = options.record[field.api_key];
      if (field.localized) {
        const localeMap = parseLocaleMap(value);
        for (const [localeCode, localeValue] of Object.entries(localeMap)) {
          if (!hasMeaningfulValue(localeValue)) continue;
          const path = `$."${localeCode.replace(/"/g, '\\"')}"`;
          const rows = yield* sql.unsafe<{ id: string }>(
            `SELECT id FROM "${options.tableName}" WHERE json_extract("${field.api_key}", ?) = ?${options.excludeId ? " AND id != ?" : ""} LIMIT 1`,
            options.excludeId
              ? [path, serializeUniqueValue(localeValue), options.excludeId]
              : [path, serializeUniqueValue(localeValue)]
          );
          if (rows.length > 0) {
            invalidFields.add(field.api_key);
            break;
          }
        }
        continue;
      }

      if (!hasMeaningfulValue(value)) continue;
      const rows = yield* sql.unsafe<{ id: string }>(
        `SELECT id FROM "${options.tableName}" WHERE "${field.api_key}" = ?${options.excludeId ? " AND id != ?" : ""} LIMIT 1`,
        options.excludeId
          ? [serializeUniqueValue(value), options.excludeId]
          : [serializeUniqueValue(value)]
      );
      if (rows.length > 0) {
        invalidFields.add(field.api_key);
      }
    }

    return [...invalidFields];
  });
}

function parseLocaleMap(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  const parsed = typeof value === "string" ? decodeJsonRecordStringOr(value, {}) : value;
  return parsed as Record<string, unknown>;
}

function hasMeaningfulValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

function serializeUniqueValue(value: unknown): unknown {
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}
