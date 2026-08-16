import { Effect, Schema } from "effect";
import { contentTableName } from "../dynamic/tables.js";
import { isObjectRecord, type DynamicRow } from "../dynamic/row-types.js";
import { SqlClient } from "effect/unstable/sql";
import { generateId } from "../id.js";
import { NotFoundError, ValidationError, AggregateValidationError, DuplicateError, CmsErrorSchema, isCmsError, errorToResponse, type ValidationIssue } from "../errors.js";
import { generateSlug } from "../slug.js";
import {
  insertRecord,
  selectAll,
  selectById,
  deserializeRow,
  updateRecord as sqlUpdateRecord,
  deleteRecord as sqlDeleteRecord,
} from "../schema-engine/sql-records.js";
import { compileFilterToSql, compileOrderBy, type FilterCompilerOpts } from "../graphql/filter-compiler.js";
import * as PublishService from "./publish-service.js";
import { writeStructuredText, writeRichText, validateStructuredText, validateRichText, deleteBlocksForField, getStructuredTextStorageKey, materializeRecordStructuredTextFields, materializeStructuredTextValue, type RichTextWriteBlock } from "./structured-text-service.js";
import type { AssetRow, ModelRow, FieldRow, ParsedFieldRow } from "../db/row-types.js";
import { parseFieldValidators, isContentRow } from "../db/row-types.js";
import { getSlugSource, getBlockWhitelist, getBlocksOnly, getRichTextBlockWhitelist, getInlineBlockWhitelist, getStructuredTextLinkModels, isRequired, findUniqueConstraintViolations, isUnique, getLinkTargets, getLinksTargets, collectValueValidationIssues } from "../db/validators.js";
import * as SearchService from "../search/search-service.js";
import type { CreateRecordInput, PatchRecordInput, BulkCreateRecordsInput, PatchBlocksInput } from "./input-schemas.js";
import { getFieldTypeDef } from "../field-types.js";
import { isFieldType } from "../types.js";
import {
  assetUrlResolver,
  collectMediaSite,
  enrichMediaSites,
  isAssetFieldType,
  parseMediaFieldReference,
  parseMediaGalleryReferences,
  stripMediaEnrichment,
  type MediaSite,
} from "../media-field.js";
import { StructuredTextWriteInput } from "../dast/schema.js";
import { pruneBlockNodes, expandStructuredTextShorthand } from "../dast/index.js";
import { fireHook } from "../hooks.js";
import { likeContains } from "../sql-util.js";
import * as VersionService from "./version-service.js";
import { decodeJsonIfString, encodeJson } from "../json.js";
import type { RequestActor } from "../attribution.js";

function validateRequestedId(id: string | undefined) {
  if (id === undefined) return null;
  return id.trim().length > 0 ? id : null;
}

function applyRecordOverrides(target: Record<string, unknown>, overrides: {
  createdAt?: string;
  updatedAt?: string;
  publishedAt?: string;
  firstPublishedAt?: string;
} | undefined) {
  if (!overrides) return;
  if (overrides.createdAt !== undefined) target._created_at = overrides.createdAt;
  if (overrides.updatedAt !== undefined) target._updated_at = overrides.updatedAt;
  if (overrides.publishedAt !== undefined) target._published_at = overrides.publishedAt;
  if (overrides.firstPublishedAt !== undefined) target._first_published_at = overrides.firstPublishedAt;
}

function applyActorColumns(
  target: Record<string, unknown>,
  actor: RequestActor | null | undefined,
  options?: {
    created?: boolean;
    updated?: boolean;
    published?: boolean;
  },
) {
  if (!actor) return;
  if (options?.created) target._created_by = actor.label;
  if (options?.updated) target._updated_by = actor.label;
  if (options?.published) target._published_by = actor.label;
}

const getModelByApiKey = Effect.fn("getModelByApiKey")(function* (apiKey: string) {
  const sql = yield* SqlClient.SqlClient;
  const models = yield* sql.unsafe<ModelRow>(
    "SELECT * FROM models WHERE api_key = ?",
    [apiKey]
  );
  return models.length > 0 ? models[0] : null;
});

const getModelFields = Effect.fn("getModelFields")(function* (modelId: string) {
  const sql = yield* SqlClient.SqlClient;
  const fields = yield* sql.unsafe<FieldRow>(
    "SELECT * FROM fields WHERE model_id = ? ORDER BY position",
    [modelId]
  );
  return fields.map(parseFieldValidators);
});

function isEmptyFieldValue(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function toValidationIssue(error: ValidationError): ValidationIssue {
  const issue: ValidationIssue = error.field === undefined
    ? { message: error.message }
    : { field: error.field, message: error.message };
  return error.code === undefined ? issue : { ...issue, code: error.code };
}

/**
 * Fold the failures accumulated by an `Effect.validateAll` field loop into a
 * single error. Field-level `ValidationError`s collapse into one
 * `AggregateValidationError` carrying every issue (Dato-style whole-form
 * mapping, so a form can mark every bad field in one submit). A non-validation
 * failure (e.g. a `SqlError`) is a structural defect, not a per-field issue, so
 * it is surfaced directly and unchanged rather than folded into `issues`.
 */
function foldFieldValidationErrors<E>(
  errors: readonly (ValidationError | E)[],
): AggregateValidationError | E {
  const issues: ValidationIssue[] = [];
  for (const error of errors) {
    // E is an open generic here, so discriminant narrowing on _tag is
    // impossible; the tagged-union guard is the schema-based membership check.
    if (CmsErrorSchema.guards.ValidationError(error)) {
      issues.push(toValidationIssue(error));
    } else {
      return error;
    }
  }
  return new AggregateValidationError({ issues });
}

/**
 * Missing-required-field issues for the incoming data, accumulated across the
 * whole model (not fail-fast). `labelPrefix` scopes the message for bulk rows.
 */
function requiredFieldIssues(
  modelFields: readonly ParsedFieldRow[],
  data: Record<string, unknown>,
  labelPrefix?: string,
): ValidationIssue[] {
  return modelFields
    .filter((field) => isRequired(field.validators) && isEmptyFieldValue(data[field.api_key]))
    .map((field) => ({
      field: field.api_key,
      code: "required" as const,
      message: labelPrefix
        ? `${labelPrefix}: field '${field.api_key}' is required`
        : `Field '${field.api_key}' is required`,
    }));
}

function decodeLocalizedStructuredTextMap(field: ParsedFieldRow, rawValue: unknown) {
  return Schema.decodeUnknownEffect(
    Schema.Record(Schema.String, Schema.NullOr(Schema.Unknown))
  )(rawValue).pipe(
    Effect.mapError((e) => new ValidationError({
      message: `Invalid localized StructuredText for field '${field.api_key}': ${e.message}`,
      field: field.api_key,
    }))
  );
}

function decodeLocalizedFieldMap(field: ParsedFieldRow, rawValue: unknown) {
  return Schema.decodeUnknownEffect(
    Schema.Record(Schema.String, Schema.Unknown)
  )(rawValue).pipe(
    Effect.map((localeMap) => sanitizeLocaleMap(localeMap)),
    Effect.mapError((e) => new ValidationError({
      message: `Invalid localized value for field '${field.api_key}': ${e.message}`,
      field: field.api_key,
    }))
  );
}

function parseExistingLocaleMap(rawValue: unknown): Record<string, unknown> {
  if (rawValue === null || rawValue === undefined) return {};
  const parsed = decodeJsonIfString(rawValue);
  if (!isObjectRecord(parsed)) return {};
  return sanitizeLocaleMap(parsed);
}

function sanitizeLocaleMap(localeMap: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(localeMap).filter(([key]) => isLocaleKey(key))
  );
}

function isLocaleKey(key: string): boolean {
  return /^[a-z]{2,3}(?:[_-][A-Za-z0-9]{2,8})*$/.test(key);
}

function isLocalizedValueMap(value: unknown): value is Record<string, unknown> {
  return isJsonRecord(value) && Object.keys(value).length > 0 && Object.keys(value).every(isLocaleKey);
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMistakenMediaObject(value: unknown): value is Record<string, unknown> {
  return isJsonRecord(value) && typeof value.id === "string" && value.id.length > 0 && value.upload_id === undefined;
}

function isMistakenLinkObject(value: unknown): value is Record<string, unknown> {
  return isJsonRecord(value) && typeof value.id === "string" && value.id.length > 0;
}

function hasMistakenLinkObject(value: unknown): boolean {
  return Array.isArray(value) && value.some((entry) => isMistakenLinkObject(entry));
}

function toSlugSourceString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function normalizeBooleanValue(field: ParsedFieldRow, value: unknown): unknown {
  if (field.field_type !== "boolean") return value;
  if (value === 1) return true;
  if (value === 0) return false;
  if (field.localized && isJsonRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([locale, localeValue]) => [
        locale,
        localeValue === 1 ? true : localeValue === 0 ? false : localeValue,
      ])
    );
  }
  return value;
}

function normalizeBooleanFields(record: Record<string, unknown>, fields: ReadonlyArray<ParsedFieldRow>) {
  const normalized = { ...record };
  for (const field of fields) {
    if (field.api_key in normalized) {
      normalized[field.api_key] = normalizeBooleanValue(field, normalized[field.api_key]);
    }
  }
  return normalized;
}

function scopeStructuredTextIds<T>(value: T, scope: string): T {
  if (!value || typeof value !== "object") return value;

  const clone = structuredClone(value);
  if (!isObjectRecord(clone)) return clone;
  const mutableClone: Record<string, unknown> = clone;
  const blocks = isObjectRecord(mutableClone.blocks) ? mutableClone.blocks : undefined;
  const originalIds = Object.keys(blocks ?? {});
  if (originalIds.length === 0) return clone;

  const idMap = new Map(originalIds.map((id) => [id, `${scope}:${id}`]));

  const rewriteNode = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(rewriteNode);
    if (!isObjectRecord(node)) return node;

    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      next[key] = rewriteNode(child);
    }
    if ((next.type === "block" || next.type === "inlineBlock") && typeof next.item === "string") {
      next.item = idMap.get(next.item) ?? next.item;
    }
    return next;
  };

  if ("value" in mutableClone) {
    mutableClone.value = rewriteNode(mutableClone.value);
  }
  mutableClone.blocks = Object.fromEntries(
    Object.entries(blocks ?? {}).map(([blockId, blockValue]) => [
      idMap.get(blockId) ?? blockId,
      blockValue,
    ])
  );

  return clone;
}

type CreateLikeFieldProcessingParams = {
  modelApiKey: string;
  tableName: string;
  recordId: string;
  data: Record<string, unknown>;
  record: Record<string, unknown>;
  modelFields: readonly ParsedFieldRow[];
  errorPrefix?: string;
  skipReferenceValidation?: boolean;
  /**
   * Dry-run: run every check the create path runs (DAST/blocks validation,
   * whitelists, reference & asset existence, composite decode, localized guards)
   * but write NO block rows — structured_text/rich_text go through the
   * `validate*` twins instead of the `write*` ones. The slug branch stays as-is:
   * it only SELECTs to find a free suffix and mutates the in-memory `data`, so it
   * has no persistent side effect to suppress (no slug is reserved on write
   * either). Nothing else in this loop persists.
   */
  dryRun?: boolean;
};

function createFieldErrorMessage(prefix: string | undefined, message: string) {
  return prefix ? `${prefix}: ${message}` : message;
}

function getReferenceIds(fieldType: string, value: unknown): string[] {
  if (fieldType === "link") {
    return typeof value === "string" && value.length > 0 ? [value] : [];
  }
  if (fieldType === "links") {
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : [];
  }
  return [];
}

function getAssetIds(fieldType: string, value: unknown): string[] {
  if (fieldType === "media") {
    const ref = parseMediaFieldReference(value);
    return ref ? [ref.uploadId] : [];
  }
  if (fieldType === "media_gallery") {
    return parseMediaGalleryReferences(value).map((ref) => ref.uploadId);
  }
  if (fieldType === "seo" && isJsonRecord(value) && typeof value.image === "string" && value.image.length > 0) {
    return [value.image];
  }
  return [];
}

const validateAssetFieldValue = Effect.fn("validateAssetFieldValue")(function* (
  sql: SqlClient.SqlClient,
  field: ParsedFieldRow,
  value: unknown,
  errorPrefix?: string,
) {
  const assetIds = getAssetIds(field.field_type, value);
  if (assetIds.length === 0) {
    return;
  }

  const placeholders = assetIds.map(() => "?").join(", ");
  const found = yield* sql.unsafe<{ id: string }>(
    `SELECT id FROM assets WHERE id IN (${placeholders})`,
    assetIds,
  );
  const foundIds = new Set(found.map((row) => row.id));
  const missing = assetIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    return yield* new ValidationError({
      message: createFieldErrorMessage(errorPrefix, `Asset(s) not found for field '${field.api_key}': ${missing.join(", ")}`),
      field: field.api_key,
      code: "type",
    });
  }
});

const validateReferenceFieldValue = Effect.fn("validateReferenceFieldValue")(function* (
  sql: SqlClient.SqlClient,
  field: ParsedFieldRow,
  value: unknown,
  errorPrefix?: string,
) {
  const targetModelApiKeys = field.field_type === "link"
    ? getLinkTargets(field.validators)
    : field.field_type === "links"
      ? getLinksTargets(field.validators)
      : undefined;
  const referenceIds = getReferenceIds(field.field_type, value);

  if (!targetModelApiKeys || referenceIds.length === 0) {
    return;
  }

  const placeholders = targetModelApiKeys.map(() => "?").join(", ");
  const targetModels = yield* sql.unsafe<ModelRow>(
    `SELECT * FROM models WHERE api_key IN (${placeholders})`,
    targetModelApiKeys,
  );

  const foundIds = new Set<string>();
  for (const model of targetModels) {
    const idPlaceholders = referenceIds.map(() => "?").join(", ");
    const rows = yield* sql.unsafe<{ id: string }>(
      `SELECT id FROM "${contentTableName(model.api_key)}" WHERE id IN (${idPlaceholders})`,
      referenceIds,
    );
    for (const row of rows) {
      foundIds.add(row.id);
    }
  }

  const missingIds = referenceIds.filter((id) => !foundIds.has(id));
  if (missingIds.length > 0) {
    return yield* new ValidationError({
      message: createFieldErrorMessage(
        errorPrefix,
        `Linked record(s) not found for field '${field.api_key}': ${missingIds.join(", ")}`,
      ),
      field: field.api_key,
      code: "link_target",
    });
  }
});

const processCreateLikeRecordFields = Effect.fn("processCreateLikeRecordFields")(function* ({
  modelApiKey,
  tableName,
  recordId,
  data,
  record,
  modelFields,
  errorPrefix,
  skipReferenceValidation,
  dryRun,
}: CreateLikeFieldProcessingParams) {
  const sql = yield* SqlClient.SqlClient;

  // Validate/process every field, ACCUMULATING per-field failures across the
  // whole loop instead of aborting on the first bad field (Dato-style
  // whole-form error mapping). `Effect.validateAll` runs each field's effect
  // (sequential — side effects like structured-text block writes must keep
  // their order) and collects all failures; `foldFieldValidationErrors` then
  // fails once with an AggregateValidationError carrying every issue.
  const processField = (field: ParsedFieldRow) =>
    Effect.gen(function* () {
    if (field.field_type === "structured_text" && data[field.api_key] !== undefined && data[field.api_key] !== null) {
      if (field.localized) {
        const localeMap = yield* decodeLocalizedStructuredTextMap(field, data[field.api_key]).pipe(
          Effect.mapError((error) => new ValidationError({
            message: createFieldErrorMessage(errorPrefix, error.message),
            field: error.field,
          }))
        );
        const localizedDast: Record<string, unknown> = {};
        for (const [localeCode, localeValue] of Object.entries(localeMap)) {
          if (localeValue === null) {
            localizedDast[localeCode] = null;
            continue;
          }

          const expandedLocale = expandStructuredTextShorthand(localeValue);

          const stInput = yield* Schema.decodeUnknownEffect(StructuredTextWriteInput)(scopeStructuredTextIds(expandedLocale, `${field.api_key}:${localeCode}`)).pipe(
            Effect.mapError((e) => new ValidationError({
              message: createFieldErrorMessage(errorPrefix, `Invalid StructuredText for field '${field.api_key}' locale '${localeCode}': ${e.message}`),
              field: field.api_key,
            }))
          );

          const allowedBlockTypes = getBlockWhitelist(field.validators);
          const blocksOnly = getBlocksOnly(field.validators);

          const stParams = {
            rootModelApiKey: modelApiKey,
            fieldApiKey: field.api_key,
            rootFieldStorageKey: getStructuredTextStorageKey(field.api_key, localeCode),
            rootRecordId: recordId,
            value: stInput.value,
            blocks: stInput.blocks,
            allowedBlockTypes: allowedBlockTypes ?? [],
            allowedInlineBlockTypes: getInlineBlockWhitelist(field.validators),
            allowedLinkModels: getStructuredTextLinkModels(field.validators),
            blocksOnly,
          };
          if (dryRun) {
            yield* validateStructuredText(stParams);
          } else {
            localizedDast[localeCode] = yield* writeStructuredText(stParams);
          }
        }

        data[field.api_key] = localizedDast;
        record[field.api_key] = localizedDast;
        return;
      }

      const expanded = expandStructuredTextShorthand(data[field.api_key]);

      const stInput = yield* Schema.decodeUnknownEffect(StructuredTextWriteInput)(expanded).pipe(
        Effect.mapError((e) => new ValidationError({
          message: createFieldErrorMessage(errorPrefix, `Invalid StructuredText for field '${field.api_key}': ${e.message}`),
          field: field.api_key,
        }))
      );

      const allowedBlockTypes = getBlockWhitelist(field.validators);
      const blocksOnly = getBlocksOnly(field.validators);

      const stParams = {
        rootModelApiKey: modelApiKey,
        fieldApiKey: field.api_key,
        rootRecordId: recordId,
        value: stInput.value,
        blocks: stInput.blocks,
        allowedBlockTypes: allowedBlockTypes ?? [],
        allowedInlineBlockTypes: getInlineBlockWhitelist(field.validators),
        allowedLinkModels: getStructuredTextLinkModels(field.validators),
        blocksOnly,
      };
      if (dryRun) {
        yield* validateStructuredText(stParams);
      } else {
        data[field.api_key] = yield* writeStructuredText(stParams);
      }
    }

    if (field.field_type === "rich_text" && data[field.api_key] !== undefined && data[field.api_key] !== null) {
      const allowedBlockTypes = getRichTextBlockWhitelist(field.validators) ?? [];

      if (field.localized) {
        const localeMap = yield* decodeLocalizedFieldMap(field, data[field.api_key]).pipe(
          Effect.mapError((error) => new ValidationError({
            message: createFieldErrorMessage(errorPrefix, error.message),
            field: error.field,
          }))
        );
        const localizedBlockIds: Record<string, unknown> = {};
        for (const [localeCode, localeValue] of Object.entries(localeMap)) {
          if (localeValue === null) {
            localizedBlockIds[localeCode] = null;
            continue;
          }
          if (!Array.isArray(localeValue)) {
            return yield* new ValidationError({
              message: createFieldErrorMessage(errorPrefix, `rich_text field '${field.api_key}' locale '${localeCode}' must be an array of block objects`),
              field: field.api_key,
            });
          }
          const rtParams = {
            rootModelApiKey: modelApiKey,
            fieldApiKey: field.api_key,
            rootFieldStorageKey: getStructuredTextStorageKey(field.api_key, localeCode),
            rootRecordId: recordId,
            blocks: localeValue,
            allowedBlockTypes,
          };
          if (dryRun) {
            yield* validateRichText(rtParams);
          } else {
            localizedBlockIds[localeCode] = yield* writeRichText(rtParams);
          }
        }
        data[field.api_key] = localizedBlockIds;
        record[field.api_key] = localizedBlockIds;
        return;
      }

      const rawBlocks = data[field.api_key];
      if (!Array.isArray(rawBlocks)) {
        return yield* new ValidationError({
          message: createFieldErrorMessage(errorPrefix, `rich_text field '${field.api_key}' must be an array of block objects`),
          field: field.api_key,
        });
      }
      const rtParams = {
        rootModelApiKey: modelApiKey,
        fieldApiKey: field.api_key,
        rootRecordId: recordId,
        blocks: rawBlocks,
        allowedBlockTypes,
      };
      if (dryRun) {
        yield* validateRichText(rtParams);
      } else {
        data[field.api_key] = yield* writeRichText(rtParams);
      }
    }

    if (field.field_type === "slug") {
      const sourceFieldKey = getSlugSource(field.validators);
      const sourceValue = sourceFieldKey ? toSlugSourceString(data[sourceFieldKey]) : null;
      const currentValue = toSlugSourceString(data[field.api_key]);
      if (!data[field.api_key] && sourceValue) {
        data[field.api_key] = generateSlug(sourceValue);
      } else if (currentValue) {
        data[field.api_key] = generateSlug(currentValue);
      }
      if (data[field.api_key]) {
        let slug = String(data[field.api_key]);
        const baseSlug = slug;
        let suffix = 1;
        for (;;) {
          const existing = yield* sql.unsafe<{ id: string }>(
            `SELECT id FROM "${tableName}" WHERE "${field.api_key}" = ?`,
            [slug]
          );
          if (existing.length === 0) break;
          suffix++;
          slug = `${baseSlug}-${suffix}`;
        }
        data[field.api_key] = slug;
      }
    }

    if (isFieldType(field.field_type) && data[field.api_key] !== undefined && data[field.api_key] !== null) {
      const fieldDef = getFieldTypeDef(field.field_type);
      if (field.field_type === "media" && isMistakenMediaObject(data[field.api_key])) {
        return yield* new ValidationError({
          message: createFieldErrorMessage(errorPrefix, `Invalid media for field '${field.api_key}': use an asset ID string or {"upload_id":"<asset_id>"}, not {"id":"..."}`),
          field: field.api_key,
        });
      }
      if (field.field_type === "link" && isMistakenLinkObject(data[field.api_key])) {
        return yield* new ValidationError({
          message: createFieldErrorMessage(errorPrefix, `Invalid link for field '${field.api_key}': use a record ID string, not {"id":"..."}`),
          field: field.api_key,
        });
      }
      if (field.field_type === "links" && hasMistakenLinkObject(data[field.api_key])) {
        return yield* new ValidationError({
          message: createFieldErrorMessage(errorPrefix, `Invalid links for field '${field.api_key}': use an array of record ID strings, not objects like {"id":"..."}`),
          field: field.api_key,
        });
      }
      if (!field.localized && isLocalizedValueMap(data[field.api_key])) {
        return yield* new ValidationError({
          message: createFieldErrorMessage(errorPrefix, `Field '${field.api_key}' is not localized and cannot accept locale-keyed values`),
          field: field.api_key,
          code: "locale",
        });
      }
      if (fieldDef.inputSchema) {
        if (field.localized) {
          const localeMap = yield* decodeLocalizedFieldMap(field, data[field.api_key]).pipe(
            Effect.mapError((error) => new ValidationError({
              message: createFieldErrorMessage(errorPrefix, error.message),
              field: error.field,
              code: "locale",
            }))
          );
          for (const [localeCode, localeValue] of Object.entries(localeMap)) {
            if (localeValue === null) continue;
            yield* Schema.decodeUnknownEffect(fieldDef.inputSchema)(localeValue).pipe(
              Effect.mapError((e) => new ValidationError({
                message: createFieldErrorMessage(errorPrefix, `Invalid ${field.field_type} for field '${field.api_key}' locale '${localeCode}': ${e.message}`),
                field: field.api_key,
                code: "type",
              }))
            );
          }
        } else {
          yield* Schema.decodeUnknownEffect(fieldDef.inputSchema)(data[field.api_key]).pipe(
            Effect.mapError((e) => new ValidationError({
              message: createFieldErrorMessage(errorPrefix, `Invalid ${field.field_type} for field '${field.api_key}': ${e.message}`),
              field: field.api_key,
              code: "type",
            }))
          );
        }
      }
    }

    // Validate linked-record existence for link/links fields
    if (
      !skipReferenceValidation
      && (field.field_type === "link" || field.field_type === "links")
      && data[field.api_key] !== undefined
      && data[field.api_key] !== null
    ) {
      if (field.localized) {
        const localeMap = yield* decodeLocalizedFieldMap(field, data[field.api_key]).pipe(
          Effect.mapError((error) => new ValidationError({
            message: createFieldErrorMessage(errorPrefix, error.message),
            field: error.field,
          }))
        );
        for (const localeValue of Object.values(localeMap)) {
          if (localeValue === null) continue;
          yield* validateReferenceFieldValue(sql, field, localeValue, errorPrefix);
        }
      } else {
        yield* validateReferenceFieldValue(sql, field, data[field.api_key], errorPrefix);
      }
    }

    // Validate asset existence for asset-backed fields
    if (
      (field.field_type === "media" || field.field_type === "media_gallery" || field.field_type === "seo")
      && data[field.api_key] !== undefined
      && data[field.api_key] !== null
    ) {
      if (field.localized) {
        const localeMap = yield* decodeLocalizedFieldMap(field, data[field.api_key]).pipe(
          Effect.mapError((error) => new ValidationError({
            message: createFieldErrorMessage(errorPrefix, error.message),
            field: error.field,
          }))
        );
        for (const localeValue of Object.values(localeMap)) {
          if (localeValue === null) continue;
          yield* validateAssetFieldValue(sql, field, localeValue, errorPrefix);
        }
      } else {
        yield* validateAssetFieldValue(sql, field, data[field.api_key], errorPrefix);
      }
    }

    if (data[field.api_key] !== undefined) {
      // Reads enrich media values with resolved asset metadata; writing one
      // straight back must not persist that (stale URL) — strip it here so
      // read-modify-write round-trips to exactly what was stored.
      record[field.api_key] = stripMediaEnrichment(field.field_type, data[field.api_key]);
    }
    });

  yield* Effect.validate(modelFields, processField, { concurrency: 1 }).pipe(
    Effect.mapError(foldFieldValidationErrors),
  );
});

export function createRecord(body: CreateRecordInput, actor?: RequestActor | null) {
  return Effect.gen(function* () {

    const model = yield* getModelByApiKey(body.modelApiKey);
    if (!model) return yield* new NotFoundError({ entity: "Model", id: body.modelApiKey });
    if (model.is_block)
      return yield* new ValidationError({ message: "Cannot create records for block types directly" });

    const tableName = contentTableName(model.api_key);

    // Singleton check
    if (model.singleton) {
      const existing = yield* selectAll(tableName);
      if (existing.length > 0)
        return yield* new DuplicateError({ message: `Model '${model.api_key}' is a singleton and already has a record` });
    }

    const modelFields = yield* getModelFields(model.id);
    const data = { ...body.data };

    // Validate required fields only for non-draft models (has_draft=false auto-publishes)
    // Draft models defer required validation to publish time
    // Required-field check is its own accumulation gate, run BEFORE field
    // processing: every missing required field surfaces in one AggregateValidationError.
    if (!model.has_draft) {
      const missing = requiredFieldIssues(modelFields, data);
      if (missing.length > 0) return yield* new AggregateValidationError({ issues: missing });
    }

    const now = new Date().toISOString();
    const requestedId = validateRequestedId(body.id);
    const id = requestedId ?? generateId();
    const sql = yield* SqlClient.SqlClient;
    const duplicateId = yield* sql.unsafe<{ id: string }>(
      `SELECT id FROM "${tableName}" WHERE id = ?`,
      [id]
    );
    if (duplicateId.length > 0) {
      return yield* new DuplicateError({ message: `Record with id '${id}' already exists on model '${body.modelApiKey}'` });
    }
    // Models with hasDraft=false skip draft state, publish immediately
    const initialStatus = model.has_draft ? "draft" : "published";
    const record: DynamicRow = {
      id,
      _status: initialStatus,
      _created_at: now,
      _updated_at: now,
      ...(!model.has_draft ? { _published_at: now, _first_published_at: now } : {}),
    };
    applyActorColumns(record, actor, {
      created: true,
      updated: true,
      published: !model.has_draft,
    });
    applyRecordOverrides(record, body.overrides);

    // Sortable/tree models: auto-assign _position
    if (model.sortable || model.tree) {
      const maxPos = yield* sql.unsafe<{ max_pos: number | null }>(
        `SELECT MAX("_position") as max_pos FROM "${tableName}"`
      );
      record._position = (maxPos[0]?.max_pos ?? -1) + 1;
    }

    // Tree models: accept _parent_id
    if (model.tree && data._parent_id !== undefined) {
      record._parent_id = data._parent_id;
      delete data._parent_id;
    }

    yield* processCreateLikeRecordFields({
      modelApiKey: model.api_key,
      tableName,
      recordId: id,
      data,
      record,
      modelFields,
      skipReferenceValidation: body.skipReferenceValidation,
    });

    const createUniqueViolations = yield* findUniqueConstraintViolations({
      tableName,
      record: record,
      fields: modelFields,
      onlyFieldApiKeys: new Set(
        modelFields
          .filter((field) => isUnique(field.validators) && data[field.api_key] !== undefined)
          .map((field) => field.api_key)
      ),
    });
    if (createUniqueViolations.length > 0) {
      return yield* new AggregateValidationError({
        issues: createUniqueViolations.map((field) => ({
          field,
          code: "unique" as const,
          message: `Unique constraint violation for field '${field}'`,
        })),
      });
    }

    yield* insertRecord(tableName, record);

    // For has_draft=false models, build _published_snapshot from inserted values
    if (!model.has_draft) {
      const snap: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record)) {
        if (!key.startsWith("_") && key !== "id") snap[key] = value;
      }
      yield* sql.unsafe(
        `UPDATE "${tableName}" SET _published_snapshot = ? WHERE id = ?`,
        [encodeJson(snap), id]
      );
    }

    // Index for search
    yield* SearchService.indexRecord(body.modelApiKey, id, record, modelFields).pipe(Effect.ignore);
    yield* fireHook("onRecordCreate", { modelApiKey: body.modelApiKey, recordId: id });

    // Same projection as getRecord/patchRecord — a mutation result is shaped
    // like a read, structured_text envelopes and asset URLs included.
    const createMediaSites: MediaSite[] = [];
    const createMaterialized = yield* materializeRecordStructuredTextFields({
      modelApiKey: model.api_key,
      record: normalizeBooleanFields({ id, ...record }, modelFields),
      fields: modelFields,
      mediaSites: createMediaSites,
    });
    yield* enrichRecordSetMedia([createMaterialized], modelFields, createMediaSites);
    return createMaterialized;
  }).pipe(
    Effect.withSpan("record.create"),
    Effect.annotateSpans({
      modelApiKey: body.modelApiKey,
      actorType: actor?.type ?? "anonymous",
    }),
  );
}

/**
 * Attach canonical asset URLs to every media / media_gallery / seo value in a
 * materialized record set — the top-level fields plus every media field of
 * every block payload nested in a structured_text / rich_text envelope (those
 * sites are collected during materialization, see
 * `materializeRecordStructuredTextFields`'s `mediaSites`).
 *
 * ONE batched `WHERE id IN (...)` query for the whole set: no per-record and no
 * per-field lookup. See `enrichMediaSites`.
 */
function enrichRecordSetMedia(
  records: ReadonlyArray<Record<string, unknown>>,
  fields: ReadonlyArray<ParsedFieldRow>,
  nestedSites: MediaSite[],
) {
  const sites: MediaSite[] = [...nestedSites];
  for (const record of records) {
    for (const field of fields) {
      if (isAssetFieldType(field.field_type)) {
        collectMediaSite(sites, record, field.api_key, field.field_type);
      }
    }
  }
  return enrichMediaSites(sites);
}

export const listRecords = Effect.fn("listRecords")(function* (modelApiKey: string) {
  if (!modelApiKey)
    return yield* new ValidationError({ message: "modelApiKey query parameter is required" });
  const model = yield* getModelByApiKey(modelApiKey);
  if (!model) return yield* new NotFoundError({ entity: "Model", id: modelApiKey });
  const records = yield* selectAll(contentTableName(model.api_key));
  const fields = yield* getModelFields(model.id);
  const mediaSites: MediaSite[] = [];
  const materialized = yield* Effect.all(
    records.map((record) => materializeRecordStructuredTextFields({
      modelApiKey: model.api_key,
      record: normalizeBooleanFields(record, fields),
      fields,
      mediaSites,
    })),
    { concurrency: "unbounded" }
  );
  yield* enrichRecordSetMedia(materialized, fields, mediaSites);
  return materialized;
});

export const getRecord = Effect.fn("getRecord")(function* (modelApiKey: string, id: string) {
  if (!modelApiKey)
    return yield* new ValidationError({ message: "modelApiKey query parameter is required" });
  const model = yield* getModelByApiKey(modelApiKey);
  if (!model) return yield* new NotFoundError({ entity: "Model", id: modelApiKey });
  const record = yield* selectById(contentTableName(model.api_key), id);
  if (!record) return yield* new NotFoundError({ entity: "Record", id });
  const fields = yield* getModelFields(model.id);
  const mediaSites: MediaSite[] = [];
  const materialized = yield* materializeRecordStructuredTextFields({
    modelApiKey: model.api_key,
    record: normalizeBooleanFields(record, fields),
    fields,
    mediaSites,
  });
  yield* enrichRecordSetMedia([materialized], fields, mediaSites);
  return materialized;
});

export function updateSingletonRecord(modelApiKey: string, data: Record<string, unknown>, actor?: RequestActor | null) {
  return Effect.gen(function* () {
    const model = yield* getModelByApiKey(modelApiKey);
    if (!model) return yield* new NotFoundError({ entity: "Model", id: modelApiKey });
    if (!model.singleton) {
      return yield* new ValidationError({ message: `Model '${modelApiKey}' is not a singleton` });
    }

    const records = yield* selectAll(contentTableName(model.api_key));
    if (records.length === 0) {
      return yield* new NotFoundError({ entity: "Record", id: `${modelApiKey} singleton` });
    }
    const record = records[0];
    if (!isContentRow(record)) {
      return yield* new ValidationError({ message: `Singleton record for model '${modelApiKey}' is invalid` });
    }

    return yield* patchRecord(record.id, { modelApiKey, data }, actor);
  }).pipe(
    Effect.withSpan("record.update_singleton"),
    Effect.annotateSpans({
      modelApiKey,
      actorType: actor?.type ?? "anonymous",
    }),
  );
}

export function patchRecord(id: string, body: PatchRecordInput, actor?: RequestActor | null) {
  return Effect.gen(function* () {
    const model = yield* getModelByApiKey(body.modelApiKey);
    if (!model) return yield* new NotFoundError({ entity: "Model", id: body.modelApiKey });

    const tableName = contentTableName(model.api_key);
    const existing = yield* selectById(tableName, id);
    if (!existing) return yield* new NotFoundError({ entity: "Record", id });

    const modelFields = yield* getModelFields(model.id);
    const data = { ...body.data };
    const updates: DynamicRow = { _updated_at: new Date().toISOString() };
    applyActorColumns(updates, actor, { updated: true });

    const hasExplicitDataUpdates = Object.keys(data).length > 0;

    // Status transition: published → updated on content edit (draft models only)
    if (hasExplicitDataUpdates && isContentRow(existing) && existing._status === "published") {
      if (model.has_draft) {
        updates._status = "updated";
      } else {
        // Auto-re-publish: version old state, snapshot will be rebuilt after field processing
        if (existing._published_snapshot) {
          const prevSnapshot = typeof existing._published_snapshot === "string"
            ? existing._published_snapshot
            : encodeJson(existing._published_snapshot);
          yield* VersionService.createVersion(body.modelApiKey, id, prevSnapshot, {
            action: "auto_republish",
            actor,
          });
        }
      }
    }
    applyRecordOverrides(updates, body.overrides);

    // Tree models: accept _parent_id update
    if (model.tree && data._parent_id !== undefined) {
      updates._parent_id = data._parent_id;
      delete data._parent_id;
    }
    // Sortable/tree models: accept _position update
    if ((model.sortable || model.tree) && data._position !== undefined) {
      updates._position = data._position;
      delete data._position;
    }

    const sql = yield* SqlClient.SqlClient;

    // Same accumulation as the create path: process every field and collect all
    // per-field ValidationErrors, then fail once with AggregateValidationError.
    const processField = (field: ParsedFieldRow) =>
      Effect.gen(function* () {
      // StructuredText update: delete old blocks, write new ones
      if (field.field_type === "structured_text" && data[field.api_key] !== undefined) {
        if (data[field.api_key] === null) {
          // Clearing the field
          yield* deleteBlocksForField({
            rootRecordId: id,
            fieldApiKey: field.api_key,
            includeLocalizedVariants: field.localized === 1,
          });
        } else {
          if (field.localized) {
            const localeMap = yield* decodeLocalizedStructuredTextMap(field, data[field.api_key]);
            const existingLocaleMap = parseExistingLocaleMap(existing[field.api_key]);
            const nextLocaleMap = { ...existingLocaleMap };

            for (const [localeCode, localeValue] of Object.entries(localeMap)) {
              yield* deleteBlocksForField({
                rootRecordId: id,
                fieldApiKey: getStructuredTextStorageKey(field.api_key, localeCode),
              });

              if (localeValue === null) {
                nextLocaleMap[localeCode] = null;
                continue;
              }

              const expandedLocale = expandStructuredTextShorthand(localeValue);

              const stInput = yield* Schema.decodeUnknownEffect(StructuredTextWriteInput)(scopeStructuredTextIds(expandedLocale, `${field.api_key}:${localeCode}`)).pipe(
                Effect.mapError((e) => new ValidationError({
                  message: `Invalid StructuredText for field '${field.api_key}' locale '${localeCode}': ${e.message}`,
                  field: field.api_key,
                }))
              );

              const allowedBlockTypes = getBlockWhitelist(field.validators);
              const blocksOnly = getBlocksOnly(field.validators);

              const dast = yield* writeStructuredText({
                rootModelApiKey: model.api_key,
                fieldApiKey: field.api_key,
                rootFieldStorageKey: getStructuredTextStorageKey(field.api_key, localeCode),
                rootRecordId: id,
                value: stInput.value,
                blocks: stInput.blocks,
                allowedBlockTypes: allowedBlockTypes ?? [],
                allowedInlineBlockTypes: getInlineBlockWhitelist(field.validators),
                allowedLinkModels: getStructuredTextLinkModels(field.validators),
                blocksOnly,
              });

              nextLocaleMap[localeCode] = dast;
            }

            data[field.api_key] = nextLocaleMap;
            updates[field.api_key] = nextLocaleMap;
            return;
          }

          const expanded = expandStructuredTextShorthand(data[field.api_key]);

          const stInput = yield* Schema.decodeUnknownEffect(StructuredTextWriteInput)(expanded).pipe(
            Effect.mapError((e) => new ValidationError({
              message: `Invalid StructuredText for field '${field.api_key}': ${e.message}`,
              field: field.api_key,
            }))
          );

          yield* deleteBlocksForField({ rootRecordId: id, fieldApiKey: field.api_key });

          const allowedBlockTypes = getBlockWhitelist(field.validators);
          const blocksOnly = getBlocksOnly(field.validators);

          const dast = yield* writeStructuredText({
            rootModelApiKey: model.api_key,
            fieldApiKey: field.api_key,
            rootRecordId: id,
            value: stInput.value,
            blocks: stInput.blocks,
            allowedBlockTypes: allowedBlockTypes ?? [],
            allowedInlineBlockTypes: getInlineBlockWhitelist(field.validators),
            allowedLinkModels: getStructuredTextLinkModels(field.validators),
            blocksOnly,
          });

          data[field.api_key] = dast;
        }
      }

      // Rich text update: delete old blocks, write new ones
      if (field.field_type === "rich_text" && data[field.api_key] !== undefined) {
        if (data[field.api_key] === null) {
          yield* deleteBlocksForField({
            rootRecordId: id,
            fieldApiKey: field.api_key,
            includeLocalizedVariants: field.localized === 1,
          });
        } else if (field.localized) {
          const localeMap = yield* decodeLocalizedFieldMap(field, data[field.api_key]);
          const existingLocaleMap = parseExistingLocaleMap(existing[field.api_key]);
          const nextLocaleMap = { ...existingLocaleMap };
          const allowedBlockTypes = getRichTextBlockWhitelist(field.validators) ?? [];

          for (const [localeCode, localeValue] of Object.entries(localeMap)) {
            yield* deleteBlocksForField({
              rootRecordId: id,
              fieldApiKey: getStructuredTextStorageKey(field.api_key, localeCode),
            });

            if (localeValue === null) {
              nextLocaleMap[localeCode] = null;
              continue;
            }
            if (!Array.isArray(localeValue)) {
              return yield* new ValidationError({
                message: `rich_text field '${field.api_key}' locale '${localeCode}' must be an array of block objects`,
                field: field.api_key,
              });
            }
            const blockIds = yield* writeRichText({
              rootModelApiKey: model.api_key,
              fieldApiKey: field.api_key,
              rootFieldStorageKey: getStructuredTextStorageKey(field.api_key, localeCode),
              rootRecordId: id,
              // SAFETY: block shapes validated on the write path; array guard for null/absent.
              blocks: Array.isArray(localeValue) ? localeValue as RichTextWriteBlock[] : [],
              allowedBlockTypes,
            });
            nextLocaleMap[localeCode] = blockIds;
          }

          data[field.api_key] = nextLocaleMap;
          updates[field.api_key] = nextLocaleMap;
          return;
        } else {
          const rawBlocks = data[field.api_key];
          if (!Array.isArray(rawBlocks)) {
            return yield* new ValidationError({
              message: `rich_text field '${field.api_key}' must be an array of block objects`,
              field: field.api_key,
            });
          }
          yield* deleteBlocksForField({ rootRecordId: id, fieldApiKey: field.api_key });
          const allowedBlockTypes = getRichTextBlockWhitelist(field.validators) ?? [];
          const blockIds = yield* writeRichText({
            rootModelApiKey: model.api_key,
            fieldApiKey: field.api_key,
            rootRecordId: id,
            // SAFETY: block shapes validated on the write path; array guard for null/absent.
            blocks: Array.isArray(rawBlocks) ? rawBlocks as RichTextWriteBlock[] : [],
            allowedBlockTypes,
          });
          data[field.api_key] = blockIds;
        }
      }

      // Slug field: normalize and enforce uniqueness (excluding current record)
      if (field.field_type === "slug" && data[field.api_key] !== undefined && data[field.api_key] !== null) {
        const sourceFieldKey = getSlugSource(field.validators);
        const sourceValue = sourceFieldKey ? toSlugSourceString(data[sourceFieldKey]) : null;
        const currentValue = toSlugSourceString(data[field.api_key]);
        if (sourceValue && !currentValue) {
          data[field.api_key] = generateSlug(sourceValue);
        } else if (currentValue) {
          data[field.api_key] = generateSlug(currentValue);
        }
        // Enforce uniqueness (exclude current record)
        let slug = String(data[field.api_key]);
        const baseSlug = slug;
        let suffix = 1;
        for (;;) {
          const existing = yield* sql.unsafe<{ id: string }>(
            `SELECT id FROM "${tableName}" WHERE "${field.api_key}" = ? AND id != ?`,
            [slug, id]
          );
          if (existing.length === 0) break;
          suffix++;
          slug = `${baseSlug}-${suffix}`;
        }
        data[field.api_key] = slug;
      }

      // Validate composite field types using registry schemas
      if (isFieldType(field.field_type) && data[field.api_key] !== undefined && data[field.api_key] !== null) {
        const fieldDef = getFieldTypeDef(field.field_type);
        if (field.field_type === "media" && isMistakenMediaObject(data[field.api_key])) {
          return yield* new ValidationError({
            message: `Invalid media for field '${field.api_key}': use an asset ID string or {"upload_id":"<asset_id>"}, not {"id":"..."}`,
            field: field.api_key,
          });
        }
        if (field.field_type === "link" && isMistakenLinkObject(data[field.api_key])) {
          return yield* new ValidationError({
            message: `Invalid link for field '${field.api_key}': use a record ID string, not {"id":"..."}`,
            field: field.api_key,
          });
        }
        if (field.field_type === "links" && hasMistakenLinkObject(data[field.api_key])) {
          return yield* new ValidationError({
            message: `Invalid links for field '${field.api_key}': use an array of record ID strings, not objects like {"id":"..."}`,
            field: field.api_key,
          });
        }
        if (!field.localized && isLocalizedValueMap(data[field.api_key])) {
          return yield* new ValidationError({
            message: `Field '${field.api_key}' is not localized and cannot accept locale-keyed values`,
            field: field.api_key,
          });
        }
        if (fieldDef.inputSchema) {
          if (field.localized) {
            const localeMap = yield* decodeLocalizedFieldMap(field, data[field.api_key]);
            const existingLocaleMap = parseExistingLocaleMap(existing[field.api_key]);
            const nextLocaleMap = { ...existingLocaleMap, ...localeMap };
            for (const [localeCode, localeValue] of Object.entries(localeMap)) {
              if (localeValue === null) continue;
              yield* Schema.decodeUnknownEffect(fieldDef.inputSchema)(localeValue).pipe(
                Effect.mapError((e) => new ValidationError({
                  message: `Invalid ${field.field_type} for field '${field.api_key}' locale '${localeCode}': ${e.message}`,
                  field: field.api_key,
                }))
              );
            }
            data[field.api_key] = nextLocaleMap;
          } else {
            yield* Schema.decodeUnknownEffect(fieldDef.inputSchema)(data[field.api_key]).pipe(
              Effect.mapError((e) => new ValidationError({
                message: `Invalid ${field.field_type} for field '${field.api_key}': ${e.message}`,
                field: field.api_key,
              }))
            );
          }
        }
      }

      if (
        (field.field_type === "media" || field.field_type === "media_gallery" || field.field_type === "seo")
        && data[field.api_key] !== undefined
        && data[field.api_key] !== null
      ) {
        if (field.localized) {
          const localeMap = yield* decodeLocalizedFieldMap(field, data[field.api_key]);
          for (const localeValue of Object.values(localeMap)) {
            if (localeValue === null) continue;
            yield* validateAssetFieldValue(sql, field, localeValue);
          }
        } else {
          yield* validateAssetFieldValue(sql, field, data[field.api_key]);
        }
      }

      if (
        field.localized &&
        field.field_type !== "structured_text" &&
        field.field_type !== "rich_text" &&
        data[field.api_key] !== undefined
      ) {
        const localeMap = yield* decodeLocalizedFieldMap(field, data[field.api_key]);
        const existingLocaleMap = parseExistingLocaleMap(existing[field.api_key]);
        data[field.api_key] = { ...existingLocaleMap, ...localeMap };
      }

      if (data[field.api_key] !== undefined) {
        // See the same strip in the create path: enrichment keys are read-only.
        updates[field.api_key] = stripMediaEnrichment(field.field_type, data[field.api_key]);
      }
      });

    yield* Effect.validate(modelFields, processField, { concurrency: 1 }).pipe(
      Effect.mapError(foldFieldValidationErrors),
    );

    const uniqueFieldsTouched = new Set(
      modelFields
        .filter((field) => isUnique(field.validators) && data[field.api_key] !== undefined)
        .map((field) => field.api_key)
    );
    if (uniqueFieldsTouched.size > 0) {
      const nextRecord = { ...existing, ...updates };
      const patchUniqueViolations = yield* findUniqueConstraintViolations({
        tableName,
        record: nextRecord,
        fields: modelFields,
        excludeId: id,
        onlyFieldApiKeys: uniqueFieldsTouched,
      });
      if (patchUniqueViolations.length > 0) {
        return yield* new AggregateValidationError({
          issues: patchUniqueViolations.map((field) => ({
            field,
            code: "unique" as const,
            message: `Unique constraint violation for field '${field}'`,
          })),
        });
      }
    }

    yield* sqlUpdateRecord(tableName, id, updates);

    // Auto-re-publish for has_draft=false models
    if (!model.has_draft && hasExplicitDataUpdates) {
      const updated = yield* selectById(tableName, id);
      if (updated) {
        const snap: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(updated)) {
          if (!key.startsWith("_") && key !== "id") snap[key] = value;
        }
        yield* sql.unsafe(
          `UPDATE "${tableName}" SET _published_snapshot = ?, _published_at = ?, _published_by = ?, _status = 'published' WHERE id = ?`,
          [encodeJson(snap), new Date().toISOString(), actor?.label ?? null, id]
        );
      }
    }

    yield* SearchService.reindexRecord(body.modelApiKey, id, modelFields).pipe(Effect.ignore);
    yield* fireHook("onRecordUpdate", { modelApiKey: body.modelApiKey, recordId: id });
    const updated = yield* selectById(tableName, id);
    if (!updated) return null;
    // Project structured_text/rich_text exactly like the read path: a mutation
    // result must be the same shape as getRecord's, or callers that refresh
    // from the mutation response get raw DAST where the envelope is declared.
    const patchMediaSites: MediaSite[] = [];
    const patchMaterialized = yield* materializeRecordStructuredTextFields({
      modelApiKey: model.api_key,
      record: normalizeBooleanFields(updated, modelFields),
      fields: modelFields,
      mediaSites: patchMediaSites,
    });
    yield* enrichRecordSetMedia([patchMaterialized], modelFields, patchMediaSites);
    return patchMaterialized;
  }).pipe(
    Effect.withSpan("record.patch"),
    Effect.annotateSpans({
      modelApiKey: body.modelApiKey,
      recordId: id,
      actorType: actor?.type ?? "anonymous",
    }),
  );
}

export const removeRecord = Effect.fn("removeRecord")(function* (modelApiKey: string, id: string) {
  if (!modelApiKey)
    return yield* new ValidationError({ message: "modelApiKey query parameter is required" });
  const model = yield* getModelByApiKey(modelApiKey);
  if (!model) return yield* new NotFoundError({ entity: "Model", id: modelApiKey });

  const tableName = contentTableName(model.api_key);
  const existing = yield* selectById(tableName, id);
  if (!existing) return yield* new NotFoundError({ entity: "Record", id });

  // Clean up orphan blocks owned by this record (across all block tables)
  const sql = yield* SqlClient.SqlClient;
  const blockModels = yield* sql.unsafe<{ api_key: string }>(
    "SELECT api_key FROM models WHERE is_block = 1"
  );
  for (const bm of blockModels) {
    yield* sql.unsafe(
      `DELETE FROM "block_${bm.api_key}" WHERE _root_record_id = ?`, [id]
    );
  }

  yield* sqlDeleteRecord(tableName, id);
  yield* VersionService.deleteVersionsForRecord(modelApiKey, id).pipe(Effect.ignore);
  yield* SearchService.deindexRecord(modelApiKey, id).pipe(Effect.ignore);
  yield* fireHook("onRecordDelete", { modelApiKey, recordId: id });
  return { deleted: true };
});

/**
 * Bulk create records in a single operation.
 * All records must belong to the same model. Runs in a logical batch
 * (individual inserts, but avoids per-record overhead of schema lookups).
 */
export const bulkCreateRecords = Effect.fn("bulkCreateRecords")(function* ({ modelApiKey, records }: BulkCreateRecordsInput, actor?: RequestActor | null) {
  if (records.length === 0)
    return yield* new ValidationError({ message: "records must be a non-empty array" });
  if (records.length > 1000)
    return yield* new ValidationError({ message: "Maximum 1000 records per bulk operation" });

  const model = yield* getModelByApiKey(modelApiKey);
  if (!model) return yield* new NotFoundError({ entity: "Model", id: modelApiKey });
  if (model.is_block)
    return yield* new ValidationError({ message: "Cannot create records for block types directly" });
  if (model.singleton)
    return yield* new ValidationError({ message: "Cannot bulk create on singleton models" });

  const tableName = contentTableName(model.api_key);
  const modelFields = yield* getModelFields(model.id);
  const sql = yield* SqlClient.SqlClient;
  const now = new Date().toISOString();
  const initialStatus = model.has_draft ? "draft" : "published";
  const created: Array<{ id: string }> = [];

  // Get current max position for sortable models
  let nextPosition = 0;
  if (model.sortable || model.tree) {
    const maxPos = yield* sql.unsafe<{ max_pos: number | null }>(
      `SELECT MAX("_position") as max_pos FROM "${tableName}"`
    );
    nextPosition = (maxPos[0]?.max_pos ?? -1) + 1;
  }

  for (let idx = 0; idx < records.length; idx++) {
    const rawRecord = records[idx];
    const data = { ...rawRecord };

    // Validate required fields only for non-draft models (accumulated per record)
    if (!model.has_draft) {
      const missing = requiredFieldIssues(modelFields, data, `Record ${idx}`);
      if (missing.length > 0) return yield* new AggregateValidationError({ issues: missing });
    }

    const requestedId = typeof data.id === "string" && data.id.trim().length > 0 ? data.id : undefined;
    if (requestedId) delete data.id;
    const id = requestedId ?? generateId();
    const duplicateId = yield* sql.unsafe<{ id: string }>(
      `SELECT id FROM "${tableName}" WHERE id = ?`,
      [id]
    );
    if (duplicateId.length > 0) {
      return yield* new DuplicateError({ message: `Record ${idx}: id '${id}' already exists on model '${modelApiKey}'` });
    }
    const record: DynamicRow = {
      id,
      _status: initialStatus,
      _created_at: now,
      _updated_at: now,
      ...(!model.has_draft ? { _published_at: now, _first_published_at: now } : {}),
    };
    applyActorColumns(record, actor, {
      created: true,
      updated: true,
      published: !model.has_draft,
    });
    applyRecordOverrides(record, undefined);

    if (model.sortable || model.tree) {
      record._position = nextPosition++;
    }

    yield* processCreateLikeRecordFields({
      modelApiKey: model.api_key,
      tableName,
      recordId: id,
      data,
      record,
      modelFields,
      errorPrefix: `Record ${idx}`,
    });

    yield* insertRecord(tableName, record);
    yield* SearchService.indexRecord(modelApiKey, id, record, modelFields).pipe(Effect.ignore);
    yield* fireHook("onRecordCreate", { modelApiKey, recordId: id });
    created.push({ id });
  }

  return { created: created.length, records: created };
});

function isStructuredTextEnvelopeLike(value: unknown): value is { value: unknown; blocks: Record<string, unknown> } {
  return isJsonRecord(value) && "value" in value && isJsonRecord(value.blocks);
}

function getPrunableDast(value: unknown): { schema: string; document: { type: string; children: readonly unknown[] } } | null {
  if (!isJsonRecord(value)) return null;
  if (typeof value.schema !== "string") return null;
  if (!isJsonRecord(value.document)) return null;
  if (typeof value.document.type !== "string") return null;
  if (!Array.isArray(value.document.children)) return null;
  return {
    schema: value.schema,
    document: {
      type: value.document.type,
      children: value.document.children,
    },
  };
}

function applyPatchToNestedStructuredText(
  target: Record<string, unknown>,
  blockId: string,
  patchValue: unknown,
): { applied: boolean; ambiguous: boolean } {
  let matches = 0;

  const visitObject = (value: Record<string, unknown>) => {
    for (const nestedValue of Object.values(value)) {
      if (isStructuredTextEnvelopeLike(nestedValue)) {
        const blocks = nestedValue.blocks;
        if (Object.hasOwn(blocks, blockId)) {
          matches++;
          if (patchValue === null) {
            delete blocks[blockId];
            const dast = getPrunableDast(nestedValue.value);
            if (dast) {
              nestedValue.value = pruneBlockNodes(dast, new Set([blockId]));
            }
          } else if (typeof patchValue === "string") {
            // keep unchanged
          } else if (isJsonRecord(patchValue)) {
            const existingBlock = blocks[blockId];
            if (isJsonRecord(existingBlock)) {
              blocks[blockId] = { ...existingBlock, ...patchValue };
            }
          }
        }

        for (const childBlock of Object.values(blocks)) {
          if (isJsonRecord(childBlock)) visitObject(childBlock);
        }
        continue;
      }

      if (isJsonRecord(nestedValue)) visitObject(nestedValue);
    }
  };

  visitObject(target);
  return { applied: matches > 0, ambiguous: matches > 1 };
}

/**
 * Partial block update for a structured text field.
 *
 * Patch map semantics:
 * - Key with string value (equal to the block ID) → keep block unchanged
 * - Key with object value → partial merge into existing block (only specified fields updated)
 * - Key with null → delete block and prune from DAST
 * - Key absent from patch → keep block unchanged
 *
 * Optionally accepts a new DAST `value`. If omitted, keeps existing DAST
 * (with deleted blocks auto-pruned).
 */
export const patchBlocksForField = Effect.fn("patchBlocksForField")(function* (body: PatchBlocksInput, actor?: RequestActor | null) {

  const model = yield* getModelByApiKey(body.modelApiKey);
  if (!model) return yield* new NotFoundError({ entity: "Model", id: body.modelApiKey });

  const tableName = contentTableName(model.api_key);
  const existing = yield* selectById(tableName, body.recordId);
  if (!existing) return yield* new NotFoundError({ entity: "Record", id: body.recordId });

  const modelFields = yield* getModelFields(model.id);
  const field = modelFields.find((f) => f.api_key === body.fieldApiKey);
  if (!field) return yield* new NotFoundError({ entity: "Field", id: body.fieldApiKey });
  if (field.field_type !== "structured_text") {
    return yield* new ValidationError({
      message: `Field '${body.fieldApiKey}' is not a structured_text field`,
      field: body.fieldApiKey,
    });
  }

  // Materialize existing structured text to get current blocks
  const existingEnvelope = yield* materializeStructuredTextValue({
    allowedBlockApiKeys: getBlockWhitelist(field.validators) ?? [],
    parentContainerModelApiKey: model.api_key,
    parentBlockId: null,
    parentFieldApiKey: field.api_key,
    rootRecordId: body.recordId,
    rootFieldApiKey: field.api_key,
    rawValue: existing[field.api_key],
  });

  if (!existingEnvelope) {
    return yield* new ValidationError({
      message: `Field '${body.fieldApiKey}' has no structured text content to patch`,
      field: body.fieldApiKey,
    });
  }

  const existingBlocks = existingEnvelope.blocks;
  const blockIdsToDelete = new Set<string>();
  const mergedBlocks: Record<string, Record<string, unknown>> = {};

  // Start with all existing blocks as-is
  for (const [blockId, blockData] of Object.entries(existingBlocks)) {
    mergedBlocks[blockId] = blockData;
  }

  // Apply patch
  for (const [blockId, patchValue] of Object.entries(body.blocks)) {
    if (patchValue === null) {
      if (Object.hasOwn(existingBlocks, blockId)) {
        blockIdsToDelete.add(blockId);
        delete mergedBlocks[blockId];
        continue;
      }

      let nestedMatched = false;
      for (const topLevelBlock of Object.values(mergedBlocks)) {
        const result = applyPatchToNestedStructuredText(topLevelBlock, blockId, patchValue);
        if (result.ambiguous) {
          return yield* new ValidationError({
            message: `Block '${blockId}' matched multiple nested structured_text locations in field '${body.fieldApiKey}'. Patch the parent block explicitly instead.`,
            field: body.fieldApiKey,
          });
        }
        nestedMatched = nestedMatched || result.applied;
      }
      if (!nestedMatched) {
        return yield* new ValidationError({
          message: `Block '${blockId}' does not exist in field '${body.fieldApiKey}'.`,
          field: body.fieldApiKey,
        });
      }
    } else if (typeof patchValue === "string") {
      return yield* new ValidationError({
        message: `Invalid patch value for block '${blockId}': use an object to update fields, null to delete, or omit the key to keep unchanged.`,
        field: body.fieldApiKey,
      });
    } else if (typeof patchValue === "object" && !Array.isArray(patchValue)) {
      // Partial merge
      if (!Object.hasOwn(existingBlocks, blockId)) {
        let nestedMatched = false;
        for (const topLevelBlock of Object.values(mergedBlocks)) {
          const result = applyPatchToNestedStructuredText(topLevelBlock, blockId, patchValue);
          if (result.ambiguous) {
            return yield* new ValidationError({
              message: `Block '${blockId}' matched multiple nested structured_text locations in field '${body.fieldApiKey}'. Patch the parent block explicitly instead.`,
              field: body.fieldApiKey,
            });
          }
          nestedMatched = nestedMatched || result.applied;
        }
        if (!nestedMatched) {
          return yield* new ValidationError({
            message: `Block '${blockId}' does not exist in field '${body.fieldApiKey}'.`,
            field: body.fieldApiKey,
          });
        }
        continue;
      }
      const existingBlock = existingBlocks[blockId];
      if (!isJsonRecord(existingBlock)) {
        return yield* new ValidationError({
          message: `Block '${blockId}' has invalid stored data and cannot be patched.`,
          field: body.fieldApiKey,
        });
      }
      // Merge: existing block data + patch (patch wins)
      mergedBlocks[blockId] = {
        ...existingBlock,
        ...patchValue,
      };
    } else {
      return yield* new ValidationError({
        message: `Invalid patch value for block '${blockId}': expected string, object, or null`,
        field: body.fieldApiKey,
      });
    }
  }

  // Process append entries — add new blocks with auto-generated IDs
  const appendedIds: string[] = [];
  for (const entry of body.append ?? []) {
    const id = generateId();
    appendedIds.push(id);
    mergedBlocks[id] = entry;
  }

  // Build final DAST value
  let finalDastValue: unknown;
  if (body.order) {
    // order is only valid on blocks_only fields
    const blocksOnlyFlag = getBlocksOnly(field.validators);
    if (!blocksOnlyFlag) {
      return yield* new ValidationError({
        message: "The 'order' parameter is only supported on blocks_only structured_text fields. Use the 'value' parameter to provide a custom DAST for mixed prose+block fields.",
        field: body.fieldApiKey,
      });
    }
    // order and value are mutually exclusive
    if (body.value !== undefined) {
      return yield* new ValidationError({
        message: "Cannot use both 'order' and 'value' — they both control the DAST document structure.",
        field: body.fieldApiKey,
      });
    }
    // Build DAST from order
    finalDastValue = {
      schema: "dast",
      document: {
        type: "root",
        children: body.order.map((id) => ({ type: "block", item: id })),
      },
    };
  } else if (body.value !== undefined && appendedIds.length > 0) {
    return yield* new ValidationError({
      message: "Cannot use both 'value' and 'append' — appended blocks need auto-generated DAST nodes which conflict with a custom DAST value.",
      field: body.fieldApiKey,
    });
  } else if (body.value !== undefined) {
    finalDastValue = body.value;
  } else if (blockIdsToDelete.size > 0 || appendedIds.length > 0) {
    // Clone existing DAST, prune deleted blocks, append new block nodes
    const existingDast = existingEnvelope.value;
    const pruned = blockIdsToDelete.size > 0
      ? pruneBlockNodes(existingDast, blockIdsToDelete)
      : existingDast;
    if (appendedIds.length > 0) {
      const prunedDoc = pruned;
      finalDastValue = {
        ...prunedDoc,
        document: {
          ...prunedDoc.document,
          children: [
            ...prunedDoc.document.children,
            ...appendedIds.map((id) => ({ type: "block", item: id })),
          ],
        },
      };
    } else {
      finalDastValue = pruned;
    }
  } else {
    finalDastValue = existingEnvelope.value;
  }

  // Now do the standard delete-all + rewrite using the merged data
  yield* deleteBlocksForField({ rootRecordId: body.recordId, fieldApiKey: field.api_key });

  const allowedBlockTypes = getBlockWhitelist(field.validators);
  const blocksOnly = getBlocksOnly(field.validators);

  const dast = yield* writeStructuredText({
    rootModelApiKey: model.api_key,
    fieldApiKey: field.api_key,
    rootRecordId: body.recordId,
    value: finalDastValue,
    blocks: mergedBlocks,
    allowedBlockTypes: allowedBlockTypes ?? [],
    allowedInlineBlockTypes: getInlineBlockWhitelist(field.validators),
    allowedLinkModels: getStructuredTextLinkModels(field.validators),
    blocksOnly,
  });

  // Update the content table
  const sql = yield* SqlClient.SqlClient;
  const now = new Date().toISOString();
  yield* sql.unsafe(
    `UPDATE "${tableName}" SET "${field.api_key}" = ?, _updated_at = ?, _updated_by = ? WHERE id = ?`,
    [encodeJson(dast), now, actor?.label ?? null, body.recordId]
  );

  // Status transition: published → updated on content edit (draft models only)
  if (isContentRow(existing) && existing._status === "published" && model.has_draft) {
    yield* sql.unsafe(
      `UPDATE "${tableName}" SET _status = 'updated' WHERE id = ?`,
      [body.recordId]
    );
  }

  // Auto-re-publish for has_draft=false models
  if (!model.has_draft) {
    if (existing._published_snapshot) {
      const prevSnapshot = typeof existing._published_snapshot === "string"
        ? existing._published_snapshot
        : encodeJson(existing._published_snapshot);
      yield* VersionService.createVersion(body.modelApiKey, body.recordId, prevSnapshot, {
        action: "auto_republish",
        actor,
      });
    }
    const updated = yield* selectById(tableName, body.recordId);
    if (updated) {
      const snap: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(updated)) {
        if (!key.startsWith("_") && key !== "id") snap[key] = value;
      }
      yield* sql.unsafe(
        `UPDATE "${tableName}" SET _published_snapshot = ?, _published_at = ?, _published_by = ?, _status = 'published' WHERE id = ?`,
        [encodeJson(snap), now, actor?.label ?? null, body.recordId]
      );
    }
  }

  yield* SearchService.reindexRecord(body.modelApiKey, body.recordId, modelFields).pipe(Effect.ignore);
  yield* fireHook("onRecordUpdate", { modelApiKey: body.modelApiKey, recordId: body.recordId });

  const updatedRecord = yield* selectById(tableName, body.recordId);
  if (!updatedRecord) return null;
  const materialized = yield* materializeRecordStructuredTextFields({
    modelApiKey: model.api_key,
    record: normalizeBooleanFields(updatedRecord, modelFields),
    fields: modelFields,
  });
  if (appendedIds.length > 0) {
    return { ...materialized, _appendedIds: appendedIds };
  }
  return materialized;
});

/**
 * Reorder records for a sortable/tree model.
 * Accepts an ordered array of record IDs — sets _position = index.
 */
export const reorderRecords = Effect.fn("reorderRecords")(function* (modelApiKey: string, recordIds: readonly string[], actor?: RequestActor | null) {
  const model = yield* getModelByApiKey(modelApiKey);
  if (!model) return yield* new NotFoundError({ entity: "Model", id: modelApiKey });
  if (!model.sortable && !model.tree)
    return yield* new ValidationError({ message: `Model '${modelApiKey}' is not sortable` });

  const sql = yield* SqlClient.SqlClient;
  const tableName = contentTableName(model.api_key);

  for (let i = 0; i < recordIds.length; i++) {
    yield* sql.unsafe(
      `UPDATE "${tableName}" SET "_position" = ?, "_updated_at" = ?, "_updated_by" = ? WHERE id = ?`,
      [i, new Date().toISOString(), actor?.label ?? null, recordIds[i]]
    );
  }

  return { reordered: recordIds.length };
});

// ===========================================================================
// Queryable list — filtered/paginated/sorted list with total count
// ===========================================================================

/**
 * System meta columns accepted in `filter`/`orderBy`. Both the camelCase forms
 * the GraphQL compiler maps (e.g. `_createdAt`) and the raw snake_case DB
 * columns (e.g. `_created_at`) are allowed, since the compiler resolves either.
 */
const QUERY_META_KEYS: ReadonlySet<string> = new Set([
  "id",
  "_status",
  "_position",
  "_parent",
  "_parent_id",
  "_createdAt", "_created_at",
  "_updatedAt", "_updated_at",
  "_publishedAt", "_published_at",
  "_firstPublishedAt", "_first_published_at",
  "_publicationScheduledAt", "_scheduled_publish_at",
  "_unpublishingScheduledAt", "_scheduled_unpublish_at",
]);

function buildFilterCompilerOpts(fields: readonly ParsedFieldRow[], locale?: string): FilterCompilerOpts {
  const localizedDbColumns = fields.filter((f) => f.localized).map((f) => f.api_key);
  const jsonArrayFields = new Set(
    fields.filter((f) => f.field_type === "links" || f.field_type === "media_gallery").map((f) => f.api_key),
  );
  const jsonObjectIdFields = new Set(
    fields.filter((f) => f.field_type === "media").map((f) => f.api_key),
  );
  const localizedKeys = new Set(localizedDbColumns);
  return {
    fieldIsLocalized: (field: string) => localizedKeys.has(field),
    localizedDbColumns,
    jsonArrayFields,
    jsonObjectIdFields,
    locale,
  };
}

function allowedQueryColumns(fields: readonly ParsedFieldRow[]): ReadonlySet<string> {
  return new Set<string>([...QUERY_META_KEYS, ...fields.map((f) => f.api_key)]);
}

/** Reject filter keys that are not real field api_keys or system meta columns. */
const assertFilterColumns = Effect.fn("assertFilterColumns")(function* (filter: unknown, allowed: ReadonlySet<string>): Effect.fn.Return<void, ValidationError> {
  if (!isJsonRecord(filter)) return;
  for (const [key, value] of Object.entries(filter)) {
    if (key === "AND" || key === "OR") {
      if (Array.isArray(value)) {
        for (const sub of value) yield* assertFilterColumns(sub, allowed);
      }
      continue;
    }
    if (key === "_locales") continue;
    if (!allowed.has(key)) {
      return yield* new ValidationError({ message: `Unknown filter field '${key}'`, field: key });
    }
  }
});

/** Reject orderBy specs whose field is not a real field api_key or meta column. */
const assertOrderByColumns = Effect.fn("assertOrderByColumns")(function* (orderBy: readonly string[] | undefined, allowed: ReadonlySet<string>): Effect.fn.Return<void, ValidationError> {
  for (const spec of orderBy ?? []) {
    const match = spec.match(/^(.+)_(ASC|DESC)$/);
    if (!match) {
      return yield* new ValidationError({ message: `Invalid orderBy spec '${spec}' (expected '<field>_ASC' or '<field>_DESC')` });
    }
    const field = match[1];
    if (field === "_locales" || !allowed.has(field)) {
      return yield* new ValidationError({ message: `Unknown orderBy field '${field}'` });
    }
  }
});

export interface QueryRecordsOptions {
  filter?: Record<string, unknown>;
  orderBy?: readonly string[];
  page?: { limit?: number; offset?: number };
  status?: "draft" | "published" | "updated";
  locale?: string;
}

/**
 * Filtered/sorted/paginated record list plus a total count for the same filter.
 * Reuses the generic GraphQL SQL compiler for filter/orderBy. Unlike the
 * GraphQL delivery path this returns records of every status (admin list view);
 * pass `status` to narrow. Records are materialized identically to listRecords.
 */
export function queryRecords(modelApiKey: string, opts: QueryRecordsOptions) {
  return Effect.gen(function* () {
    if (!modelApiKey)
      return yield* new ValidationError({ message: "modelApiKey is required" });
    const model = yield* getModelByApiKey(modelApiKey);
    if (!model) return yield* new NotFoundError({ entity: "Model", id: modelApiKey });

    const fields = yield* getModelFields(model.id);
    const allowed = allowedQueryColumns(fields);
    yield* assertFilterColumns(opts.filter, allowed);
    yield* assertOrderByColumns(opts.orderBy, allowed);

    const sql = yield* SqlClient.SqlClient;
    const tableName = contentTableName(model.api_key);
    const filterOpts = buildFilterCompilerOpts(fields, opts.locale);

    const conditions: string[] = [];
    const whereParams: unknown[] = [];
    if (opts.status) {
      conditions.push(`"_status" = ?`);
      whereParams.push(opts.status);
    }
    const compiled = compileFilterToSql(opts.filter, filterOpts);
    if (compiled) {
      conditions.push(compiled.where);
      whereParams.push(...compiled.params);
    }
    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";

    const totalRows = yield* sql.unsafe<{ count: number }>(
      `SELECT COUNT(*) as count FROM "${tableName}"${whereClause}`,
      whereParams,
    );
    const total = totalRows[0]?.count ?? 0;

    const limit = Math.min(Math.max(opts.page?.limit ?? 50, 1), 500);
    const offset = Math.max(opts.page?.offset ?? 0, 0);

    let query = `SELECT * FROM "${tableName}"${whereClause}`;
    const orderBy = compileOrderBy(opts.orderBy ? [...opts.orderBy] : undefined, filterOpts);
    if (orderBy) {
      query += ` ORDER BY ${orderBy}`;
    }
    query += ` LIMIT ? OFFSET ?`;

    const rawRows = yield* sql.unsafe<Record<string, unknown>>(query, [...whereParams, limit, offset]);
    const mediaSites: MediaSite[] = [];
    const records = yield* Effect.all(
      rawRows.map((row) => materializeRecordStructuredTextFields({
        modelApiKey: model.api_key,
        record: normalizeBooleanFields(deserializeRow(row), fields),
        fields,
        mediaSites,
      })),
      { concurrency: "unbounded" },
    );
    yield* enrichRecordSetMedia(records, fields, mediaSites);

    return { records, total };
  }).pipe(
    Effect.withSpan("record.query"),
    Effect.annotateSpans({ modelApiKey }),
  );
}

// ===========================================================================
// Model-scoped picker search — presentation rows for record-picker UIs
// ===========================================================================

const TITLE_FIELD_NAMES: ReadonlySet<string> = new Set(["title", "name", "heading", "label"]);
const STRING_FIELD_TYPES: ReadonlySet<string> = new Set(["string", "text", "slug"]);

/**
 * Same order codegen bakes into each model's `<MODEL>_PRESENTATION`
 * (packages/codegen/src/generate.ts `resolvePresentation`), so a generated row
 * and a picker row title the same record identically: explicit hint → a field
 * named title/name/heading/label → the first required string → the first
 * string → the record id (codegen emits `null` there, meaning "use the id").
 */
function resolveTitleFieldKey(model: ModelRow, fields: readonly ParsedFieldRow[]): string {
  if (model.title_field && fields.some((f) => f.api_key === model.title_field)) {
    return model.title_field;
  }
  const named = fields.find((f) => TITLE_FIELD_NAMES.has(f.api_key));
  if (named) return named.api_key;
  const strings = fields.filter((f) => STRING_FIELD_TYPES.has(f.field_type));
  const requiredString = strings.find((f) => isRequired(f.validators));
  if (requiredString) return requiredString.api_key;
  if (strings.length > 0) return strings[0].api_key;
  return "id";
}

function resolveImageFieldKey(model: ModelRow, fields: readonly ParsedFieldRow[]): string | null {
  if (model.image_preview_field && fields.some((f) => f.api_key === model.image_preview_field)) {
    return model.image_preview_field;
  }
  const media = fields.find((f) => f.field_type === "media");
  return media ? media.api_key : null;
}

export interface PickerSearchRow {
  id: string;
  title: unknown;
  /** The preview asset's id (unchanged — pickers key on it). */
  image: string | null;
  /** The preview asset's canonical URL, so a picker row can render a thumbnail. */
  imageUrl: string | null;
  status: unknown;
  updatedAt: unknown;
}

export interface PickerSearchPage {
  limit?: number;
  offset?: number;
}

/**
 * Model-scoped picker search returning presentation rows for record-picker UIs.
 * Matches `q` case-insensitively (SQL LIKE) against the model's resolved title
 * field. Title/image fields come from the model's presentation hints
 * (title_field / image_preview_field) with sensible fallbacks.
 */
export function searchRecords(modelApiKey: string, q: string, page?: PickerSearchPage) {
  return Effect.gen(function* () {
    if (!modelApiKey)
      return yield* new ValidationError({ message: "modelApiKey is required" });
    const model = yield* getModelByApiKey(modelApiKey);
    if (!model) return yield* new NotFoundError({ entity: "Model", id: modelApiKey });

    const fields = yield* getModelFields(model.id);
    const titleKey = resolveTitleFieldKey(model, fields);
    const imageKey = resolveImageFieldKey(model, fields);

    const sql = yield* SqlClient.SqlClient;
    const tableName = contentTableName(model.api_key);

    const conditions: string[] = [];
    const params: unknown[] = [];
    const trimmed = q.trim();
    if (trimmed.length > 0) {
      conditions.push(`"${titleKey}" LIKE ? ESCAPE '\\'`);
      params.push(likeContains(trimmed));
    }
    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";

    const limit = Math.min(Math.max(page?.limit ?? 20, 1), 100);
    const offset = Math.max(page?.offset ?? 0, 0);

    const rawRows = yield* sql.unsafe<Record<string, unknown>>(
      `SELECT * FROM "${tableName}"${whereClause} ORDER BY "_updated_at" DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    const partial = rawRows.map((raw) => {
      const row = deserializeRow(raw);
      const image = imageKey ? (parseMediaFieldReference(row[imageKey])?.uploadId ?? null) : null;
      return {
        id: String(row.id),
        title: titleKey === "id" ? String(row.id) : row[titleKey],
        image,
        status: row._status,
        updatedAt: row._updated_at,
      };
    });

    // One batched asset lookup for the whole page — never one per row.
    const imageIds = Array.from(new Set(partial.map((row) => row.image).filter((id): id is string => id !== null)));
    const urlById = new Map<string, string>();
    if (imageIds.length > 0) {
      const resolveUrl = yield* assetUrlResolver;
      const assetRows = yield* sql.unsafe<AssetRow>(
        `SELECT * FROM assets WHERE id IN (${imageIds.map(() => "?").join(", ")})`,
        imageIds,
      );
      for (const asset of assetRows) urlById.set(asset.id, resolveUrl(asset));
    }

    const rows: PickerSearchRow[] = partial.map((row) => ({
      ...row,
      imageUrl: row.image ? (urlById.get(row.image) ?? null) : null,
    }));

    return rows;
  }).pipe(
    Effect.withSpan("record.picker_search"),
    Effect.annotateSpans({ modelApiKey }),
  );
}

// ===========================================================================
// Duplicate — deep-copy a record, minting fresh block ids for block subtrees
// ===========================================================================

function isRichTextBlockArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => isJsonRecord(entry) && typeof entry.block_type === "string");
}

/**
 * Recursively re-key a materialized structured_text envelope so every block id
 * (top-level and nested) is replaced by a fresh generated id, keeping the DAST
 * `item` references in sync. Nested structured_text envelopes and nested
 * rich_text arrays inside block data are remapped too.
 */
function remapStructuredTextEnvelopeIds(
  envelope: { value: unknown; blocks: Record<string, unknown> },
): { value: unknown; blocks: Record<string, unknown> } {
  const idMap = new Map(Object.keys(envelope.blocks).map((oldId) => [oldId, generateId()]));

  const rewriteNode = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(rewriteNode);
    if (!isJsonRecord(node)) return node;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) next[key] = rewriteNode(child);
    if ((next.type === "block" || next.type === "inlineBlock") && typeof next.item === "string") {
      next.item = idMap.get(next.item) ?? next.item;
    }
    return next;
  };

  const newBlocks: Record<string, unknown> = {};
  for (const [oldId, blockData] of Object.entries(envelope.blocks)) {
    newBlocks[idMap.get(oldId) ?? oldId] = remapBlockDataIds(blockData);
  }

  return { value: rewriteNode(envelope.value), blocks: newBlocks };
}

/** Remap block ids inside a single block's field data (nested containers). */
function remapBlockDataIds(blockData: unknown): unknown {
  if (!isJsonRecord(blockData)) return blockData;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(blockData)) {
    if (isStructuredTextEnvelopeLike(value)) {
      next[key] = remapStructuredTextEnvelopeIds(value);
    } else if (isRichTextBlockArray(value)) {
      next[key] = remapRichTextBlockIds(value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

/** Remap block ids for a materialized rich_text array (each block gets a fresh id). */
function remapRichTextBlockIds(blocks: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return blocks.map((block) => {
    const remapped = remapBlockDataIds(block);
    return isJsonRecord(remapped) ? { ...remapped, id: generateId() } : block;
  });
}

function remapLocalizedFieldValue(
  value: unknown,
  remap: (inner: unknown) => unknown,
): unknown {
  if (!isJsonRecord(value)) return remap(value);
  // A localized value is a { [locale]: value } map.
  const next: Record<string, unknown> = {};
  for (const [locale, localeValue] of Object.entries(value)) {
    next[locale] = localeValue === null || localeValue === undefined ? localeValue : remap(localeValue);
  }
  return next;
}

/**
 * Duplicate a record. The copy starts in Draft status (for draft-enabled
 * models), all field values are copied, and every structured_text / rich_text
 * block subtree is deep-copied with fresh block ids. Slug fields uniquify via
 * the standard create path (a suffix is appended when the value would collide).
 * Block writes reuse the same writeStructuredText / writeRichText machinery as
 * normal creates — only the block ids are re-minted beforehand.
 */
export function duplicateRecord(modelApiKey: string, id: string, actor?: RequestActor | null) {
  return Effect.gen(function* () {
    if (!modelApiKey)
      return yield* new ValidationError({ message: "modelApiKey is required" });
    const model = yield* getModelByApiKey(modelApiKey);
    if (!model) return yield* new NotFoundError({ entity: "Model", id: modelApiKey });
    if (model.is_block)
      return yield* new ValidationError({ message: "Cannot duplicate records of block types" });
    if (model.singleton)
      return yield* new ValidationError({ message: "Cannot duplicate a singleton record" });

    const tableName = contentTableName(model.api_key);
    const source = yield* selectById(tableName, id);
    if (!source) return yield* new NotFoundError({ entity: "Record", id });

    const fields = yield* getModelFields(model.id);
    const materialized = yield* materializeRecordStructuredTextFields({
      modelApiKey: model.api_key,
      record: normalizeBooleanFields(source, fields),
      fields,
    });

    const data: Record<string, unknown> = {};
    for (const field of fields) {
      const value = materialized[field.api_key];
      if (value === undefined || value === null) continue;

      if (field.field_type === "structured_text") {
        data[field.api_key] = field.localized
          ? remapLocalizedFieldValue(value, (inner) =>
              isStructuredTextEnvelopeLike(inner) ? remapStructuredTextEnvelopeIds(inner) : inner)
          : (isStructuredTextEnvelopeLike(value) ? remapStructuredTextEnvelopeIds(value) : value);
      } else if (field.field_type === "rich_text") {
        data[field.api_key] = field.localized
          ? remapLocalizedFieldValue(value, (inner) =>
              isRichTextBlockArray(inner) ? remapRichTextBlockIds(inner) : inner)
          : (isRichTextBlockArray(value) ? remapRichTextBlockIds(value) : value);
      } else {
        data[field.api_key] = value;
      }
    }

    if (model.tree && source._parent_id !== undefined && source._parent_id !== null) {
      data._parent_id = source._parent_id;
    }

    const created = yield* createRecord({ modelApiKey, data }, actor);
    return yield* getRecord(modelApiKey, String(created.id));
  }).pipe(
    Effect.withSpan("record.duplicate"),
    Effect.annotateSpans({
      modelApiKey,
      recordId: id,
      actorType: actor?.type ?? "anonymous",
    }),
  );
}

// ===========================================================================
// Bulk status ops — per-id best-effort, no cross-id transaction
// ===========================================================================

export interface BulkOpResult {
  id: string;
  ok: boolean;
  error?: string;
}

function describeCmsError(error: unknown): string {
  if (isCmsError(error)) {
    const body = errorToResponse(error).body;
    return body.error;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function runBulkOp<R>(
  ids: readonly string[],
  op: (id: string) => Effect.Effect<unknown, unknown, R>,
): Effect.Effect<BulkOpResult[], never, R> {
  return Effect.forEach(
    ids,
    (id) =>
      op(id).pipe(
        Effect.as<BulkOpResult>({ id, ok: true }),
        Effect.catch((error) => Effect.succeed<BulkOpResult>({ id, ok: false, error: describeCmsError(error) })),
      ),
    { concurrency: 1 },
  );
}

/** Publish many records; per-id best-effort (no transaction across ids). */
export function publishRecords(modelApiKey: string, ids: readonly string[], actor?: RequestActor | null) {
  return runBulkOp(ids, (id) => PublishService.publishRecord(modelApiKey, id, actor)).pipe(
    Effect.withSpan("record.bulk_publish"),
    Effect.annotateSpans({ modelApiKey }),
  );
}

/** Unpublish many records; per-id best-effort (no transaction across ids). */
export function unpublishRecords(modelApiKey: string, ids: readonly string[], actor?: RequestActor | null) {
  return runBulkOp(ids, (id) => PublishService.unpublishRecord(modelApiKey, id, actor)).pipe(
    Effect.withSpan("record.bulk_unpublish"),
    Effect.annotateSpans({ modelApiKey }),
  );
}

/** Delete many records; per-id best-effort (no transaction across ids). */
export function deleteRecords(modelApiKey: string, ids: readonly string[], _actor?: RequestActor | null) {
  return runBulkOp(ids, (id) => removeRecord(modelApiKey, id)).pipe(
    Effect.withSpan("record.bulk_delete"),
    Effect.annotateSpans({ modelApiKey }),
  );
}

// ===========================================================================
// Backlinks — records that reference this record via link / links fields
// ===========================================================================

export interface RecordBacklink {
  modelApiKey: string;
  recordId: string;
  fieldApiKey: string;
}

/**
 * Build the SQL predicate that matches rows whose `field` references `recordId`.
 * `link` columns hold a scalar id; `links` columns hold a JSON array of ids
 * (matched via json_each — the same shape the GraphQL reverse-reference loader
 * uses). Localized columns store a { locale: value } map, so a substring match
 * on the JSON text is used (best-effort).
 */
function backlinkCondition(field: ParsedFieldRow, recordId: string): { sql: string; params: unknown[] } {
  if (field.localized) {
    return { sql: `"${field.api_key}" LIKE ?`, params: [`%"${recordId}"%`] };
  }
  if (field.field_type === "link") {
    return { sql: `"${field.api_key}" = ?`, params: [recordId] };
  }
  return {
    sql: `EXISTS (SELECT 1 FROM json_each("${field.api_key}") WHERE value = ?)`,
    params: [recordId],
  };
}

/**
 * Inbound references: every record (across all content models) whose `link` /
 * `links` field points at the given record. A link/links field is scanned when
 * it is unconstrained OR its target-model whitelist includes this record's
 * model. Returns one entry per (referencing record, referencing field).
 *
 * NOTE: there is no record-level delete guard in the CMS today (removeRecord
 * deletes unconditionally), so there is no delete-guard caller to share this
 * with — the model-delete guard in model-service is a *field*-reference scan, a
 * different query. This is the single source of truth for record backlinks.
 */
export function getRecordBacklinks(modelApiKey: string, id: string) {
  return Effect.gen(function* () {
    if (!modelApiKey)
      return yield* new ValidationError({ message: "modelApiKey is required" });
    const model = yield* getModelByApiKey(modelApiKey);
    if (!model) return yield* new NotFoundError({ entity: "Model", id: modelApiKey });
    const existing = yield* selectById(contentTableName(model.api_key), id);
    if (!existing) return yield* new NotFoundError({ entity: "Record", id });

    const sql = yield* SqlClient.SqlClient;
    const contentModels = yield* sql.unsafe<ModelRow>("SELECT * FROM models WHERE is_block = 0");

    const results: RecordBacklink[] = [];
    for (const sourceModel of contentModels) {
      const fields = yield* getModelFields(sourceModel.id);
      const linkFields = fields.filter((f) => f.field_type === "link" || f.field_type === "links");
      for (const field of linkFields) {
        const targets = field.field_type === "link"
          ? getLinkTargets(field.validators)
          : getLinksTargets(field.validators);
        // Skip fields constrained to other models; scan unconstrained fields.
        if (targets !== undefined && !targets.includes(modelApiKey)) continue;

        const condition = backlinkCondition(field, id);
        const rows = yield* sql.unsafe<{ id: string }>(
          `SELECT id FROM "${contentTableName(sourceModel.api_key)}" WHERE ${condition.sql}`,
          condition.params,
        );
        for (const row of rows) {
          results.push({ modelApiKey: sourceModel.api_key, recordId: row.id, fieldApiKey: field.api_key });
        }
      }
    }

    return results;
  }).pipe(
    Effect.withSpan("record.backlinks"),
    Effect.annotateSpans({ modelApiKey, recordId: id }),
  );
}

// ===========================================================================
// Validation dry-run — run the create/patch validation with ZERO persistence
// ===========================================================================

/**
 * The shared dry-run body behind {@link validateRecord} / {@link validateRecordUpdate}.
 * Runs exactly the checks the write paths run, accumulating issues from every
 * gate (rather than short-circuiting at the first, the way a single write does)
 * so a form can mark every bad field at once:
 *
 *  1. scalar-value validation (required / enum / length / range / format) via the
 *     same `collectValueValidationIssues` the publish gate uses;
 *  2. field processing (composite decode, localized-map decode, structured_text
 *     DAST + block/inline whitelist + structured_text_links, rich_text blocks,
 *     link/asset existence) via `processCreateLikeRecordFields({ dryRun: true })`
 *     — the identical code path a create runs, minus the block-row inserts;
 *  3. unique constraints via the same `findUniqueConstraintViolations`.
 *
 * `requireAllRequired` distinguishes create-shaped (every required field must be
 * present) from patch-shaped (only fields present in `data` are checked).
 */
const runDryRunValidation = Effect.fn("runDryRunValidation")(function* (params: {
  model: ModelRow;
  modelFields: readonly ParsedFieldRow[];
  tableName: string;
  data: Record<string, unknown>;
  recordId: string;
  excludeId: string | null;
  requireAllRequired: boolean;
}) {
  const sql = yield* SqlClient.SqlClient;
  const issues: ValidationIssue[] = [];

  const localeRows = yield* sql.unsafe<{ code: string }>("SELECT code FROM locales ORDER BY position", []);
  const defaultLocale = localeRows.length > 0 ? localeRows[0].code : null;
  const allLocales = params.model.all_locales_required && localeRows.length > 0
    ? localeRows.map((l) => l.code)
    : undefined;

  // 1. Scalar-value validation. Create-shaped enforces required on every field;
  // patch-shaped only inspects the fields actually present in the payload.
  const valueCheckFields = params.requireAllRequired
    ? params.modelFields
    : params.modelFields.filter((field) => field.api_key in params.data);
  for (const issue of collectValueValidationIssues(params.data, valueCheckFields, defaultLocale, allLocales)) {
    issues.push({
      field: issue.field,
      code: issue.code,
      message: `Field '${issue.field}' failed '${issue.code}' validation`,
    });
  }

  // 2. Field processing (no persistence). Uses a private copy of `data` because
  // the create path mutates it (slug generation etc.); the scalar checks above
  // ran against the untouched original.
  const record: Record<string, unknown> = {};
  const processIssues = yield* processCreateLikeRecordFields({
    modelApiKey: params.model.api_key,
    tableName: params.tableName,
    recordId: params.recordId,
    data: { ...params.data },
    record,
    modelFields: params.modelFields,
    dryRun: true,
  }).pipe(
    Effect.as<ValidationIssue[]>([]),
    Effect.catchTag("AggregateValidationError", (error) => Effect.succeed([...error.issues])),
  );
  issues.push(...processIssues);

  // 3. Unique constraints — only for unique fields present in the payload
  // (matching the write paths), excluding the record itself on update.
  const uniqueFields = new Set(
    params.modelFields
      .filter((field) => isUnique(field.validators) && params.data[field.api_key] !== undefined)
      .map((field) => field.api_key),
  );
  if (uniqueFields.size > 0) {
    const uniqueViolations = yield* findUniqueConstraintViolations({
      tableName: params.tableName,
      record,
      fields: params.modelFields,
      excludeId: params.excludeId,
      onlyFieldApiKeys: uniqueFields,
    });
    for (const field of uniqueViolations) {
      issues.push({ field, code: "unique", message: `Unique constraint violation for field '${field}'` });
    }
  }

  return issues;
});

/**
 * Create-shaped validation dry-run: answers "would creating a record with this
 * data be valid?" without writing anything. Required fields are enforced for the
 * whole model (unlike a draft create, which defers required to publish) because
 * the dry-run's job is live form validation — the same question Dato's
 * `POST /items/validate` answers. Succeeds with `{ valid: true }`, or fails with
 * the same `AggregateValidationError` a real create would raise (every offending
 * field, each carrying its machine-readable `code`).
 */
export function validateRecord(modelApiKey: string, data: Record<string, unknown>) {
  return Effect.gen(function* () {
    if (!modelApiKey) return yield* new ValidationError({ message: "modelApiKey is required" });
    const model = yield* getModelByApiKey(modelApiKey);
    if (!model) return yield* new NotFoundError({ entity: "Model", id: modelApiKey });
    if (model.is_block) {
      return yield* new ValidationError({ message: "Cannot validate records for block types directly" });
    }

    const modelFields = yield* getModelFields(model.id);
    const issues = yield* runDryRunValidation({
      model,
      modelFields,
      tableName: contentTableName(model.api_key),
      data,
      recordId: generateId(),
      excludeId: null,
      requireAllRequired: true,
    });
    if (issues.length > 0) return yield* new AggregateValidationError({ issues });
    return { valid: true as const };
  }).pipe(
    Effect.withSpan("record.validate"),
    Effect.annotateSpans({ modelApiKey }),
  );
}

/**
 * Patch-shaped validation dry-run: validates a partial update against an existing
 * record without writing anything. Only fields present in `data` are checked
 * (required is not re-imposed on absent fields), the record must exist (404
 * otherwise), and unique checks exclude the record itself.
 *
 * Boundary note: the real patch path deletes the field's existing blocks before
 * writing the new ones; the dry-run only validates the NEW value (via the shared
 * `processCreateLikeRecordFields({ dryRun: true })`) and never touches stored
 * blocks — validation is equivalent, with no destructive side effect.
 */
export function validateRecordUpdate(modelApiKey: string, id: string, data: Record<string, unknown>) {
  return Effect.gen(function* () {
    if (!modelApiKey) return yield* new ValidationError({ message: "modelApiKey is required" });
    const model = yield* getModelByApiKey(modelApiKey);
    if (!model) return yield* new NotFoundError({ entity: "Model", id: modelApiKey });

    const tableName = contentTableName(model.api_key);
    const existing = yield* selectById(tableName, id);
    if (!existing) return yield* new NotFoundError({ entity: "Record", id });

    const modelFields = yield* getModelFields(model.id);
    const issues = yield* runDryRunValidation({
      model,
      modelFields,
      tableName,
      data,
      recordId: id,
      excludeId: id,
      requireAllRequired: false,
    });
    if (issues.length > 0) return yield* new AggregateValidationError({ issues });
    return { valid: true as const };
  }).pipe(
    Effect.withSpan("record.validate_update"),
    Effect.annotateSpans({ modelApiKey, recordId: id }),
  );
}

// ===========================================================================
// Sync state — sidebar status cluster: publish/schedule timestamps + field diff
// ===========================================================================

/** Recursively key-sorted JSON, so two structurally-equal values compare equal. */
function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (isJsonRecord(input)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(input).sort()) sorted[key] = normalize(input[key]);
      return sorted;
    }
    return input;
  };
  return JSON.stringify(normalize(value) ?? null);
}

/** Decode a stored column value to its comparable JSON form (null if absent). */
function snapshotComparable(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  const decoded = decodeJsonIfString(value);
  return decoded === undefined ? null : decoded;
}

export interface RecordSyncState {
  status: unknown;
  publishedAt: unknown;
  firstPublishedAt: unknown;
  scheduledPublishAt: unknown;
  scheduledUnpublishAt: unknown;
  changedFields: string[];
}

/**
 * Sidebar status cluster for a record: its publication status, publish/first-
 * publish timestamps, any scheduled publish/unpublish times, and which field
 * api_keys differ from the last published snapshot.
 *
 * `changedFields` diffs each field's current stored value against the matching
 * key in `_published_snapshot` (canonical-JSON compared). A record that was
 * never published (no snapshot) reports every field that currently holds a
 * meaningful value.
 *
 * structured_text / rich_text are compared like-for-like: the published
 * snapshot stores those fields *materialized* (block payloads inlined) while the
 * live column stores raw DAST plus block ids, so the record is materialized with
 * the very function publish uses before diffing. Without it every record with a
 * structured_text field read as permanently changed (examples/admin FRICTION #18).
 * The extra work is skipped entirely for models with no such field.
 */
export function getSyncState(modelApiKey: string, id: string) {
  return Effect.gen(function* () {
    if (!modelApiKey) return yield* new ValidationError({ message: "modelApiKey is required" });
    const model = yield* getModelByApiKey(modelApiKey);
    if (!model) return yield* new NotFoundError({ entity: "Model", id: modelApiKey });

    const tableName = contentTableName(model.api_key);
    const existing = yield* selectById(tableName, id);
    if (!existing) return yield* new NotFoundError({ entity: "Record", id });

    const modelFields = yield* getModelFields(model.id);

    const decodedSnapshot = snapshotComparable(existing._published_snapshot);
    const snapshotRecord = isJsonRecord(decodedSnapshot) ? decodedSnapshot : null;

    // Compare like-for-like: the snapshot holds materialized structured_text /
    // rich_text, so materialize the live row the same way before diffing.
    const hasMaterializedField = modelFields.some(
      (field) => field.field_type === "structured_text" || field.field_type === "rich_text",
    );
    const comparableRow = hasMaterializedField
      ? yield* materializeRecordStructuredTextFields({
          modelApiKey,
          record: existing,
          fields: modelFields,
        })
      : existing;

    const changedFields: string[] = [];
    for (const field of modelFields) {
      const current = snapshotComparable(comparableRow[field.api_key]);
      if (snapshotRecord === null) {
        if (current !== null && current !== "") changedFields.push(field.api_key);
      } else {
        const snapshotValue = snapshotComparable(snapshotRecord[field.api_key]);
        if (canonicalJson(current) !== canonicalJson(snapshotValue)) changedFields.push(field.api_key);
      }
    }

    return {
      status: existing._status ?? null,
      publishedAt: existing._published_at ?? null,
      firstPublishedAt: existing._first_published_at ?? null,
      scheduledPublishAt: existing._scheduled_publish_at ?? null,
      scheduledUnpublishAt: existing._scheduled_unpublish_at ?? null,
      changedFields,
    } satisfies RecordSyncState;
  }).pipe(
    Effect.withSpan("record.sync_state"),
    Effect.annotateSpans({ modelApiKey, recordId: id }),
  );
}
