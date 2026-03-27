import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { decodeJsonRecordStringOr } from "../json.js";
import { parseMediaFieldReference } from "../media-field.js";

type SupportedFieldType =
  | "string"
  | "text"
  | "slug"
  | "integer"
  | "float"
  | "date"
  | "date_time";

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

/** Safely get the rich_text_blocks whitelist */
export function getRichTextBlockWhitelist(validators: Record<string, unknown>): string[] | undefined {
  const v = validators.rich_text_blocks;
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
  fields: ReadonlyArray<{ api_key: string; field_type: string; localized: number; validators: Record<string, unknown> }>,
  defaultLocale: string | null,
  allLocales?: readonly string[]
): { valid: boolean; missingFields: string[] } {
  const missingFields: string[] = [];
  for (const field of fields) {
    const value = record[field.api_key];
    let fieldInvalid = false;
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
        if (!isValueValidForField(locValue, field.field_type as SupportedFieldType, field.validators)) {
          fieldInvalid = true;
          break; // One missing locale is enough to mark the field invalid
        }
      }
    } else {
      fieldInvalid = !isValueValidForField(value, field.field_type as SupportedFieldType, field.validators);
    }
    if (fieldInvalid) {
      missingFields.push(field.api_key);
    }
  }
  return { valid: missingFields.length === 0, missingFields };
}

function isValueValidForField(
  value: unknown,
  fieldType: string,
  validators: Record<string, unknown>,
): boolean {
  if (isRequired(validators) && !hasMeaningfulValue(value)) {
    return false;
  }
  if (!hasMeaningfulValue(value)) {
    return true;
  }
  if (!passesEnumValidation(value, validators)) {
    return false;
  }
  if (!passesLengthValidation(value, fieldType, validators)) {
    return false;
  }
  if (!passesNumberRangeValidation(value, fieldType, validators)) {
    return false;
  }
  if (!passesFormatValidation(value, fieldType, validators)) {
    return false;
  }
  if (!passesDateRangeValidation(value, fieldType, validators)) {
    return false;
  }
  return true;
}

function passesEnumValidation(value: unknown, validators: Record<string, unknown>): boolean {
  const enumValues = validators.enum;
  if (!Array.isArray(enumValues) || !enumValues.every((entry) => typeof entry === "string")) {
    return true;
  }
  return typeof value === "string" && enumValues.includes(value);
}

function passesLengthValidation(value: unknown, fieldType: string, validators: Record<string, unknown>): boolean {
  if (!["string", "text", "slug"].includes(fieldType)) return true;
  const lengthConfig = validators.length;
  if (typeof lengthConfig !== "object" || lengthConfig === null || Array.isArray(lengthConfig)) return true;
  const length = lengthConfig as { min?: unknown; max?: unknown };
  if (typeof value !== "string") return false;
  const min = typeof length.min === "number" ? length.min : undefined;
  const max = typeof length.max === "number" ? length.max : undefined;
  if (min !== undefined && value.length < min) return false;
  if (max !== undefined && value.length > max) return false;
  return true;
}

function passesNumberRangeValidation(value: unknown, fieldType: string, validators: Record<string, unknown>): boolean {
  if (!["integer", "float"].includes(fieldType)) return true;
  const rangeConfig = validators.number_range;
  if (typeof rangeConfig !== "object" || rangeConfig === null || Array.isArray(rangeConfig)) return true;
  const range = rangeConfig as { min?: unknown; max?: unknown };
  if (typeof value !== "number") return false;
  const min = typeof range.min === "number" ? range.min : undefined;
  const max = typeof range.max === "number" ? range.max : undefined;
  if (min !== undefined && value < min) return false;
  if (max !== undefined && value > max) return false;
  return true;
}

function passesFormatValidation(value: unknown, fieldType: string, validators: Record<string, unknown>): boolean {
  if (!["string", "text", "slug"].includes(fieldType) || typeof value !== "string") return true;
  const format = validators.format;
  if (!format) return true;
  if (format === "email") {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }
  if (format === "url") {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }
  if (typeof format === "object" && !Array.isArray(format) && typeof (format as { custom_pattern?: unknown }).custom_pattern === "string") {
    try {
      return new RegExp((format as { custom_pattern: string }).custom_pattern).test(value);
    } catch {
      return false;
    }
  }
  return true;
}

function passesDateRangeValidation(value: unknown, fieldType: string, validators: Record<string, unknown>): boolean {
  if (!["date", "date_time"].includes(fieldType) || typeof value !== "string") return true;
  const rangeConfig = validators.date_range;
  if (typeof rangeConfig !== "object" || rangeConfig === null || Array.isArray(rangeConfig)) return true;
  const range = rangeConfig as { min?: unknown; max?: unknown };
  const valueTime = parseDateValue(value);
  if (valueTime === null) return false;
  const minTime = parseDateBoundary(range.min);
  const maxTime = parseDateBoundary(range.max);
  if (minTime !== null && valueTime < minTime) return false;
  if (maxTime !== null && valueTime > maxTime) return false;
  return true;
}

function parseDateValue(value: string): number | null {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function parseDateBoundary(value: unknown): number | null {
  if (value === undefined) return null;
  if (value === "now") return Date.now();
  if (typeof value !== "string") return null;
  return parseDateValue(value);
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
      const comparableValue = field.field_type === "media"
        ? parseMediaFieldReference(value)?.uploadId ?? value
        : value;
      const rows = yield* sql.unsafe<{ id: string }>(
        `SELECT id FROM "${options.tableName}" WHERE (CASE WHEN json_valid("${field.api_key}") AND json_type("${field.api_key}") = 'object' THEN json_extract("${field.api_key}", '$.upload_id') ELSE "${field.api_key}" END) = ?${options.excludeId ? " AND id != ?" : ""} LIMIT 1`,
        options.excludeId
          ? [serializeUniqueValue(comparableValue), options.excludeId]
          : [serializeUniqueValue(comparableValue)]
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
