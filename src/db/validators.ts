import { isBoolean, isNumber, isObjectRecord, isString, type DynamicRow, type StoredFieldValue } from "../dynamic/row-types.js";
import { DateTime, Effect, Option } from "effect";

import { SqlClient } from "effect/unstable/sql";
import { decodeJsonRecordStringOr } from "../json.js";
import { parseMediaFieldReference } from "../media-field.js";

import type { ValidationIssueCode } from "../errors.js";

/**
 * Typed access to field validator properties.
 * Instead of casting with `as`, these functions safely extract
 * known validator properties with runtime checks.
 */

/** Safely get the slug source field from validators */
export function getSlugSource(validators: DynamicRow): string | undefined {
  const v = validators.slug_source;
  return isString(v) ? v : undefined;
}

/** Safely get the structured_text_blocks whitelist */
export function getBlockWhitelist(validators: DynamicRow): string[] | undefined {
  const v = validators.structured_text_blocks;
  return Array.isArray(v) && v.every((x) => isString(x)) ? v : undefined;
}

/** Safely get the rich_text_blocks whitelist */
export function getRichTextBlockWhitelist(validators: DynamicRow): string[] | undefined {
  const v = validators.rich_text_blocks;
  return Array.isArray(v) && v.every((x) => isString(x)) ? v : undefined;
}

/**
 * Safely get the structured_text_inline_blocks whitelist. When absent (undefined),
 * one whitelist (structured_text_blocks) governs both positions — validators are
 * opt-in refinements here, so leaving this one off means "don't split the lists",
 * not "no inline blocks" (DatoCMS requires it for inline blocks at all; we diverge
 * deliberately). Enforcement lives in structured-text-service.
 */
export function getInlineBlockWhitelist(validators: DynamicRow): string[] | undefined {
  const v = validators.structured_text_inline_blocks;
  return Array.isArray(v) && v.every((x) => isString(x)) ? v : undefined;
}

/** Safely get the structured_text_links allowed-model whitelist (api_keys) */
export function getStructuredTextLinkModels(validators: DynamicRow): string[] | undefined {
  const v = validators.structured_text_links;
  return Array.isArray(v) && v.every((x) => isString(x)) ? v : undefined;
}

/** Safely get the blocks_only flag */
export function getBlocksOnly(validators: DynamicRow): boolean {
  return validators.blocks_only === true;
}

/** Safely check if field is required */
export function isRequired(validators: DynamicRow): boolean {
  return validators.required === true;
}

/** Safely check if field must be unique */
export function isUnique(validators: DynamicRow): boolean {
  return validators.unique === true;
}

/** Safely get link target model types (for `link` fields) */
export function getLinkTargets(validators: DynamicRow): string[] | undefined {
  const v = validators.item_item_type;
  return Array.isArray(v) && v.every((x) => isString(x)) ? v : undefined;
}

/** Safely get links target model types (for `links` fields) */
export function getLinksTargets(validators: DynamicRow): string[] | undefined {
  const v = validators.items_item_type;
  return Array.isArray(v) && v.every((x) => isString(x)) ? v : undefined;
}

/** Check if field is searchable (default: true — opt out with {"searchable": false}) */
export function isSearchable(validators: DynamicRow): boolean {
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
  record: DynamicRow,
  fields: ReadonlyArray<{ api_key: string; field_type: string; localized: number; validators: DynamicRow }>,
  defaultLocale: string | null,
  allLocales?: readonly string[]
): { valid: boolean; missingFields: string[] } {
  const missingFields: string[] = [];
  for (const field of fields) {
    // SAFETY: DynamicRow cells are StoredFieldValue by the dynamic-zone contract
    // (the Record<string, unknown> window hides the union).
    const value = record[field.api_key] as StoredFieldValue;
    let fieldInvalid = false;
    if (field.localized && defaultLocale) {
      // Localized field: check locale keys in JSON map
      let localeMap = value;
      if (isString(localeMap)) {
        localeMap = decodeJsonRecordStringOr(localeMap, {});
      }
      if (!isObjectRecord(localeMap)) {
        missingFields.push(field.api_key);
        continue;
      }
      // When allLocales is set, check every locale; otherwise just the default
      const localesToCheck = allLocales ?? [defaultLocale];
      for (const locale of localesToCheck) {
        // SAFETY: locale-map values are content-table cells (StoredFieldValue).
        const locValue = localeMap[locale] as StoredFieldValue;
        if (!isValueValidForField(locValue, field.field_type, field.validators)) {
          fieldInvalid = true;
          break; // One missing locale is enough to mark the field invalid
        }
      }
    } else {
      fieldInvalid = !isValueValidForField(value, field.field_type, field.validators);
    }
    if (fieldInvalid) {
      missingFields.push(field.api_key);
    }
  }
  return { valid: missingFields.length === 0, missingFields };
}

function isValueValidForField(
  value: StoredFieldValue,
  fieldType: string,
  validators: DynamicRow,
): boolean {
  return valueValidationCode(value, fieldType, validators) === null;
}

/**
 * The specific validator a value fails first (in a stable order), or `null` if
 * the value is valid. Single source of truth for scalar-value validation, shared
 * by {@link computeIsValid} (publish gate) and {@link collectValueValidationIssues}
 * (dry-run) so the two never diverge on what counts as valid.
 */
function valueValidationCode(
  value: StoredFieldValue,
  fieldType: string,
  validators: DynamicRow,
): ValidationIssueCode | null {
  if (isRequired(validators) && !hasMeaningfulValue(value)) {
    return "required";
  }
  if (!hasMeaningfulValue(value)) {
    return null;
  }
  if (!passesEnumValidation(value, validators)) {
    return "enum";
  }
  if (!passesLengthValidation(value, fieldType, validators)) {
    return "length";
  }
  if (!passesNumberRangeValidation(value, fieldType, validators)) {
    return "range";
  }
  if (!passesFormatValidation(value, fieldType, validators)) {
    return "format";
  }
  if (!passesDateRangeValidation(value, fieldType, validators)) {
    return "range";
  }
  return null;
}

export interface ValueValidationIssue {
  readonly field: string;
  readonly code: ValidationIssueCode;
}

/**
 * Per-field scalar-value validation issues (required / enum / length / range /
 * format), mirroring {@link computeIsValid}'s field walk but reporting the
 * *specific* validator each field failed rather than a flat missing-field list.
 * Powers the validation dry-run's machine-readable `code`. Localized fields are
 * checked per the same locale rules as `computeIsValid`.
 */
export function collectValueValidationIssues(
  record: DynamicRow,
  fields: ReadonlyArray<{ api_key: string; field_type: string; localized: number; validators: DynamicRow }>,
  defaultLocale: string | null,
  allLocales?: readonly string[],
): ValueValidationIssue[] {
  const issues: ValueValidationIssue[] = [];
  for (const field of fields) {
    // SAFETY: DynamicRow cells are StoredFieldValue by the dynamic-zone contract
    // (the Record<string, unknown> window hides the union).
    const value = record[field.api_key] as StoredFieldValue;
    if (field.localized && defaultLocale) {
      let localeMap = value;
      if (isString(localeMap)) {
        localeMap = decodeJsonRecordStringOr(localeMap, {});
      }
      if (!isObjectRecord(localeMap)) {
        issues.push({ field: field.api_key, code: isRequired(field.validators) ? "required" : "type" });
        continue;
      }
      const localesToCheck = allLocales ?? [defaultLocale];
      let fieldCode: ValidationIssueCode | null = null;
      for (const locale of localesToCheck) {
        // SAFETY: locale-map values are content-table cells (StoredFieldValue).
        fieldCode = valueValidationCode(localeMap[locale] as StoredFieldValue, field.field_type, field.validators);
        if (fieldCode !== null) break;
      }
      if (fieldCode !== null) issues.push({ field: field.api_key, code: fieldCode });
    } else {
      const code = valueValidationCode(value, field.field_type, field.validators);
      if (code !== null) issues.push({ field: field.api_key, code });
    }
  }
  return issues;
}

function passesEnumValidation(value: StoredFieldValue, validators: DynamicRow): boolean {
  const enumValues = validators.enum;
  if (!Array.isArray(enumValues) || !enumValues.every((entry) => isString(entry))) {
    return true;
  }
  return isString(value) && enumValues.includes(value);
}

function passesLengthValidation(value: StoredFieldValue, fieldType: string, validators: DynamicRow): boolean {
  if (!["string", "text", "slug"].includes(fieldType)) return true;
  const lengthConfig = validators.length;
  if (!isObjectRecord(lengthConfig)) return true;
  if (!isString(value)) return false;
  const min = isNumber(lengthConfig.min) ? lengthConfig.min : undefined;
  const max = isNumber(lengthConfig.max) ? lengthConfig.max : undefined;
  if (min !== undefined && value.length < min) return false;
  if (max !== undefined && value.length > max) return false;
  return true;
}

function passesNumberRangeValidation(value: StoredFieldValue, fieldType: string, validators: DynamicRow): boolean {
  if (!["integer", "float"].includes(fieldType)) return true;
  const rangeConfig = validators.number_range;
  if (!isObjectRecord(rangeConfig)) return true;
  if (!isNumber(value)) return false;
  const min = isNumber(rangeConfig.min) ? rangeConfig.min : undefined;
  const max = isNumber(rangeConfig.max) ? rangeConfig.max : undefined;
  if (min !== undefined && value < min) return false;
  if (max !== undefined && value > max) return false;
  return true;
}

function passesFormatValidation(value: StoredFieldValue, fieldType: string, validators: DynamicRow): boolean {
  if (!["string", "text", "slug"].includes(fieldType) || !isString(value)) return true;
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
  if (isObjectRecord(format) && isString(format.custom_pattern)) {
    try {
      return new RegExp(format.custom_pattern).test(value);
    } catch {
      return false;
    }
  }
  return true;
}

function passesDateRangeValidation(value: StoredFieldValue, fieldType: string, validators: DynamicRow): boolean {
  if (!["date", "date_time"].includes(fieldType) || !isString(value)) return true;
  const rangeConfig = validators.date_range;
  if (!isObjectRecord(rangeConfig)) return true;
  const valueTime = parseDateValue(value);
  if (valueTime === null) return false;
  // SAFETY: validator-config cells are content-table cells (StoredFieldValue).
  const minTime = parseDateBoundary(rangeConfig.min as StoredFieldValue);
  // SAFETY: validator-config cells are content-table cells (StoredFieldValue).
  const maxTime = parseDateBoundary(rangeConfig.max as StoredFieldValue);
  if (minTime !== null && valueTime < minTime) return false;
  if (maxTime !== null && valueTime > maxTime) return false;
  return true;
}

function parseDateValue(value: string): number | null {
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : null;
}

function parseDateBoundary(value: StoredFieldValue): number | null {
  if (value == null) return null;
  if (value === "now") return DateTime.toEpochMillis(DateTime.nowUnsafe());
  if (!isString(value)) return null;
  return parseDateValue(value);
}

export function findUniqueConstraintViolations(options: {
  tableName: string;
  record: DynamicRow;
  fields: ReadonlyArray<{ api_key: string; localized: number; field_type: string; validators: DynamicRow }>;
  excludeId?: string | null;
  onlyFieldApiKeys?: ReadonlySet<string>;
}) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const invalidFields = new Set<string>();

    for (const field of options.fields) {
      if (!isUnique(field.validators) || !supportsUniqueValidation(field.field_type)) continue;
      if (options.onlyFieldApiKeys && !options.onlyFieldApiKeys.has(field.api_key)) continue;

      // SAFETY: DynamicRow cells are StoredFieldValue by the dynamic-zone contract
      // (the Record<string, unknown> window hides the union).
      const value = options.record[field.api_key] as StoredFieldValue;
      if (field.localized) {
        const localeMap = parseLocaleMap(value);
        for (const [localeCode, rawLocaleValue] of Object.entries(localeMap)) {
          // SAFETY: locale-map values are content-table cells (StoredFieldValue).
          const localeValue = rawLocaleValue as StoredFieldValue;
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

function parseLocaleMap(value: StoredFieldValue): DynamicRow {
  if (value == null) return {};
  const parsed = isString(value) ? decodeJsonRecordStringOr(value, {}) : value;
  return isObjectRecord(parsed) ? parsed : {};
}

function hasMeaningfulValue(value: StoredFieldValue): boolean {
  return value != null && value !== "";
}

function serializeUniqueValue(value: StoredFieldValue): StoredFieldValue {
  if (isBoolean(value)) return value ? 1 : 0;
  return value;
}
