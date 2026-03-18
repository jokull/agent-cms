import { Effect, Schema } from "effect";
import { SqlClient } from "@effect/sql";
import { ulid } from "ulidx";
import { NotFoundError, ValidationError, DuplicateError } from "../errors.js";
import { generateSlug } from "../slug.js";
import {
  insertRecord,
  selectAll,
  selectById,
  updateRecord as sqlUpdateRecord,
  deleteRecord as sqlDeleteRecord,
} from "../schema-engine/sql-records.js";
import { writeStructuredText, deleteBlocksForField, getStructuredTextStorageKey, materializeStructuredTextValue } from "./structured-text-service.js";
import type { ModelRow, FieldRow, ParsedFieldRow } from "../db/row-types.js";
import { parseFieldValidators, isContentRow } from "../db/row-types.js";
import { getSlugSource, getBlockWhitelist, getBlocksOnly, isRequired, findUniqueConstraintViolations, isUnique } from "../db/validators.js";
import * as SearchService from "../search/search-service.js";
import type { CreateRecordInput, PatchRecordInput, BulkCreateRecordsInput, PatchBlocksInput } from "./input-schemas.js";
import { getFieldTypeDef } from "../field-types.js";
import { isFieldType } from "../types.js";
import { StructuredTextWriteInput } from "../dast/schema.js";
import { pruneBlockNodes } from "../dast/index.js";
import { fireHook } from "../hooks.js";
import * as VersionService from "./version-service.js";
import { decodeJsonIfString, encodeJson } from "../json.js";

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

function getModelByApiKey(apiKey: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const models = yield* sql.unsafe<ModelRow>(
      "SELECT * FROM models WHERE api_key = ?",
      [apiKey]
    );
    return models.length > 0 ? models[0] : null;
  });
}

function getModelFields(modelId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fields = yield* sql.unsafe<FieldRow>(
      "SELECT * FROM fields WHERE model_id = ? ORDER BY position",
      [modelId]
    );
    return fields.map(parseFieldValidators);
  });
}

function decodeLocalizedStructuredTextMap(field: ParsedFieldRow, rawValue: unknown) {
  return Schema.decodeUnknown(
    Schema.Record({ key: Schema.String, value: Schema.NullOr(Schema.Unknown) })
  )(rawValue).pipe(
    Effect.mapError((e) => new ValidationError({
      message: `Invalid localized StructuredText for field '${field.api_key}': ${e.message}`,
      field: field.api_key,
    }))
  );
}

function decodeLocalizedFieldMap(field: ParsedFieldRow, rawValue: unknown) {
  return Schema.decodeUnknown(
    Schema.Record({ key: Schema.String, value: Schema.Unknown })
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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return sanitizeLocaleMap(parsed as Record<string, unknown>);
}

function sanitizeLocaleMap(localeMap: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(localeMap).filter(([key]) => isLocaleKey(key))
  );
}

function isLocaleKey(key: string): boolean {
  return /^[a-z]{2,3}(?:[_-][A-Za-z0-9]{2,8})*$/.test(key);
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toSlugSourceString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function scopeStructuredTextIds<T>(value: T, scope: string): T {
  if (!value || typeof value !== "object") return value;

  const clone = structuredClone(value);
  if (!isJsonRecord(clone)) return clone;
  const mutableClone: Record<string, unknown> = clone;
  const blocks = isJsonRecord(mutableClone.blocks) ? mutableClone.blocks : undefined;
  const originalIds = Object.keys(blocks ?? {});
  if (originalIds.length === 0) return clone as T;

  const idMap = new Map(originalIds.map((id) => [id, `${scope}:${id}`]));

  const rewriteNode = (node: unknown): unknown => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(rewriteNode);

    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
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

  return clone as T;
}

export function createRecord(body: CreateRecordInput) {
  return Effect.gen(function* () {

    const model = yield* getModelByApiKey(body.modelApiKey);
    if (!model) return yield* new NotFoundError({ entity: "Model", id: body.modelApiKey });
    if (model.is_block)
      return yield* new ValidationError({ message: "Cannot create records for block types directly" });

    const tableName = `content_${model.api_key}`;

    // Singleton check
    if (model.singleton) {
      const existing = yield* selectAll(tableName);
      if (existing.length > 0)
        return yield* new DuplicateError({ message: `Model '${model.api_key}' is a singleton and already has a record` });
    }

    const modelFields = yield* getModelFields(model.id);
    const data: Record<string, unknown> = { ...(body.data ?? {}) };

    // Validate required fields only for non-draft models (has_draft=false auto-publishes)
    // Draft models defer required validation to publish time
    if (!model.has_draft) {
      for (const field of modelFields) {
        if (isRequired(field.validators) && (data[field.api_key] === undefined || data[field.api_key] === null || data[field.api_key] === ""))
          return yield* new ValidationError({ message: `Field '${field.api_key}' is required`, field: field.api_key });
      }
    }

    const now = new Date().toISOString();
    const requestedId = validateRequestedId(body.id);
    const id = requestedId ?? ulid();
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
    const record: Record<string, unknown> = {
      id,
      _status: initialStatus,
      _created_at: now,
      _updated_at: now,
      ...(!model.has_draft ? { _published_at: now, _first_published_at: now } : {}),
    };
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

    // Process fields
    for (const field of modelFields) {
      // StructuredText: validate DAST + write blocks
      if (field.field_type === "structured_text" && data[field.api_key] !== undefined && data[field.api_key] !== null) {
        if (field.localized) {
          const localeMap = yield* decodeLocalizedStructuredTextMap(field, data[field.api_key]);
          const localizedDast: Record<string, unknown> = {};
          for (const [localeCode, localeValue] of Object.entries(localeMap)) {
            if (localeValue === null) {
              localizedDast[localeCode] = null;
              continue;
            }
            const stInput = yield* Schema.decodeUnknown(StructuredTextWriteInput)(scopeStructuredTextIds(localeValue, `${field.api_key}:${localeCode}`)).pipe(
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
              blocksOnly,
            });

            localizedDast[localeCode] = dast;
          }
          data[field.api_key] = localizedDast;
          record[field.api_key] = localizedDast;
          continue;
        }

        const stInput = yield* Schema.decodeUnknown(StructuredTextWriteInput)(data[field.api_key]).pipe(
          Effect.mapError((e) => new ValidationError({
            message: `Invalid StructuredText for field '${field.api_key}': ${e.message}`,
            field: field.api_key,
          }))
        );

        const allowedBlockTypes = getBlockWhitelist(field.validators);
        const blocksOnly = getBlocksOnly(field.validators);

        const dast = yield* writeStructuredText({
          rootModelApiKey: model.api_key,
          fieldApiKey: field.api_key,
          rootRecordId: id,
          value: stInput.value,
          blocks: stInput.blocks,
          allowedBlockTypes: allowedBlockTypes ?? [],
          blocksOnly,
        });

        data[field.api_key] = dast;
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
        // Enforce uniqueness
        if (data[field.api_key]) {
          let slug = String(data[field.api_key]);
          const baseSlug = slug;
          let suffix = 1;
          while (true) {
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

      // Validate composite field types using registry schemas
      if (isFieldType(field.field_type) && data[field.api_key] !== undefined && data[field.api_key] !== null) {
        const fieldDef = getFieldTypeDef(field.field_type);
        if (fieldDef.inputSchema) {
          if (field.localized) {
            const localeMap = yield* decodeLocalizedFieldMap(field, data[field.api_key]);
            for (const [localeCode, localeValue] of Object.entries(localeMap)) {
              if (localeValue === null) continue;
              yield* Schema.decodeUnknown(fieldDef.inputSchema)(localeValue).pipe(
                Effect.mapError((e) => new ValidationError({
                  message: `Invalid ${field.field_type} for field '${field.api_key}' locale '${localeCode}': ${e.message}`,
                  field: field.api_key,
                }))
              );
            }
          } else {
            yield* Schema.decodeUnknown(fieldDef.inputSchema)(data[field.api_key]).pipe(
              Effect.mapError((e) => new ValidationError({
                message: `Invalid ${field.field_type} for field '${field.api_key}': ${e.message}`,
                field: field.api_key,
              }))
            );
          }
        }
      }

      if (data[field.api_key] !== undefined) {
        record[field.api_key] = data[field.api_key];
      }
    }

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
      return yield* new ValidationError({
        message: `Unique constraint violation for field(s): ${createUniqueViolations.join(", ")}`,
        field: createUniqueViolations[0],
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

    return { id, ...record };
  });
}

export function listRecords(modelApiKey: string) {
  return Effect.gen(function* () {
    if (!modelApiKey)
      return yield* new ValidationError({ message: "modelApiKey query parameter is required" });
    const model = yield* getModelByApiKey(modelApiKey);
    if (!model) return yield* new NotFoundError({ entity: "Model", id: modelApiKey });
    return yield* selectAll(`content_${model.api_key}`);
  });
}

export function getRecord(modelApiKey: string, id: string) {
  return Effect.gen(function* () {
    if (!modelApiKey)
      return yield* new ValidationError({ message: "modelApiKey query parameter is required" });
    const model = yield* getModelByApiKey(modelApiKey);
    if (!model) return yield* new NotFoundError({ entity: "Model", id: modelApiKey });
    const record = yield* selectById(`content_${model.api_key}`, id);
    if (!record) return yield* new NotFoundError({ entity: "Record", id });
    return record;
  });
}

export function patchRecord(id: string, body: PatchRecordInput) {
  return Effect.gen(function* () {
    const model = yield* getModelByApiKey(body.modelApiKey);
    if (!model) return yield* new NotFoundError({ entity: "Model", id: body.modelApiKey });

    const tableName = `content_${model.api_key}`;
    const existing = yield* selectById(tableName, id);
    if (!existing) return yield* new NotFoundError({ entity: "Record", id });

    const modelFields = yield* getModelFields(model.id);
    const data: Record<string, unknown> = { ...(body.data ?? {}) };
    const updates: Record<string, unknown> = { _updated_at: new Date().toISOString() };

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
          yield* VersionService.createVersion(body.modelApiKey, id, prevSnapshot);
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

    for (const field of modelFields) {
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

              const stInput = yield* Schema.decodeUnknown(StructuredTextWriteInput)(scopeStructuredTextIds(localeValue, `${field.api_key}:${localeCode}`)).pipe(
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
                blocksOnly,
              });

              nextLocaleMap[localeCode] = dast;
            }

            data[field.api_key] = nextLocaleMap;
            updates[field.api_key] = nextLocaleMap;
            continue;
          }

          const stInput = yield* Schema.decodeUnknown(StructuredTextWriteInput)(data[field.api_key]).pipe(
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
            blocksOnly,
          });

          data[field.api_key] = dast;
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
        while (true) {
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
        if (fieldDef.inputSchema) {
          if (field.localized) {
            const localeMap = yield* decodeLocalizedFieldMap(field, data[field.api_key]);
            const existingLocaleMap = parseExistingLocaleMap(existing[field.api_key]);
            const nextLocaleMap = { ...existingLocaleMap, ...localeMap };
            for (const [localeCode, localeValue] of Object.entries(localeMap)) {
              if (localeValue === null) continue;
              yield* Schema.decodeUnknown(fieldDef.inputSchema)(localeValue).pipe(
                Effect.mapError((e) => new ValidationError({
                  message: `Invalid ${field.field_type} for field '${field.api_key}' locale '${localeCode}': ${e.message}`,
                  field: field.api_key,
                }))
              );
            }
            data[field.api_key] = nextLocaleMap;
          } else {
            yield* Schema.decodeUnknown(fieldDef.inputSchema)(data[field.api_key]).pipe(
              Effect.mapError((e) => new ValidationError({
                message: `Invalid ${field.field_type} for field '${field.api_key}': ${e.message}`,
                field: field.api_key,
              }))
            );
          }
        }
      }

      if (
        field.localized &&
        field.field_type !== "structured_text" &&
        data[field.api_key] !== undefined
      ) {
        const localeMap = yield* decodeLocalizedFieldMap(field, data[field.api_key]);
        const existingLocaleMap = parseExistingLocaleMap(existing[field.api_key]);
        data[field.api_key] = { ...existingLocaleMap, ...localeMap };
      }

      if (data[field.api_key] !== undefined) {
        updates[field.api_key] = data[field.api_key];
      }
    }

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
        return yield* new ValidationError({
          message: `Unique constraint violation for field(s): ${patchUniqueViolations.join(", ")}`,
          field: patchUniqueViolations[0],
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
          `UPDATE "${tableName}" SET _published_snapshot = ?, _published_at = ?, _status = 'published' WHERE id = ?`,
          [encodeJson(snap), new Date().toISOString(), id]
        );
      }
    }

    yield* SearchService.reindexRecord(body.modelApiKey, id, modelFields).pipe(Effect.ignore);
    yield* fireHook("onRecordUpdate", { modelApiKey: body.modelApiKey, recordId: id });
    return yield* selectById(tableName, id);
  });
}

export function removeRecord(modelApiKey: string, id: string) {
  return Effect.gen(function* () {
    if (!modelApiKey)
      return yield* new ValidationError({ message: "modelApiKey query parameter is required" });
    const model = yield* getModelByApiKey(modelApiKey);
    if (!model) return yield* new NotFoundError({ entity: "Model", id: modelApiKey });

    const tableName = `content_${model.api_key}`;
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
}

/**
 * Bulk create records in a single operation.
 * All records must belong to the same model. Runs in a logical batch
 * (individual inserts, but avoids per-record overhead of schema lookups).
 */
export function bulkCreateRecords({ modelApiKey, records }: BulkCreateRecordsInput) {
  return Effect.gen(function* () {
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

    const tableName = `content_${model.api_key}`;
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
      if (typeof rawRecord !== "object" || rawRecord === null) continue;
      const data: Record<string, unknown> = { ...(rawRecord as Record<string, unknown>) };

      // Validate required fields only for non-draft models
      if (!model.has_draft) {
        for (const field of modelFields) {
          if (isRequired(field.validators) && (data[field.api_key] === undefined || data[field.api_key] === null || data[field.api_key] === ""))
            return yield* new ValidationError({ message: `Record ${idx}: field '${field.api_key}' is required`, field: field.api_key });
        }
      }

      const requestedId = typeof data.id === "string" && data.id.trim().length > 0 ? data.id : undefined;
      if (requestedId) delete data.id;
      const id = requestedId ?? ulid();
      const duplicateId = yield* sql.unsafe<{ id: string }>(
        `SELECT id FROM "${tableName}" WHERE id = ?`,
        [id]
      );
      if (duplicateId.length > 0) {
        return yield* new DuplicateError({ message: `Record ${idx}: id '${id}' already exists on model '${modelApiKey}'` });
      }
      const record: Record<string, unknown> = {
        id,
        _status: initialStatus,
        _created_at: now,
        _updated_at: now,
        ...(!model.has_draft ? { _published_at: now, _first_published_at: now } : {}),
      };
      applyRecordOverrides(record, undefined);

      if (model.sortable || model.tree) {
        record._position = nextPosition++;
      }

      // Process fields: slug, structured_text, composite validation
      for (const field of modelFields) {
        // StructuredText: validate DAST + write blocks
        if (field.field_type === "structured_text" && data[field.api_key] !== undefined && data[field.api_key] !== null) {
          if (field.localized) {
            const localeMap = yield* decodeLocalizedStructuredTextMap(field, data[field.api_key]);
            const localizedDast: Record<string, unknown> = {};
            for (const [localeCode, localeValue] of Object.entries(localeMap)) {
              if (localeValue === null) {
                localizedDast[localeCode] = null;
                continue;
              }

              const stInput = yield* Schema.decodeUnknown(StructuredTextWriteInput)(scopeStructuredTextIds(localeValue, `${field.api_key}:${localeCode}`)).pipe(
                Effect.mapError((e) => new ValidationError({
                  message: `Record ${idx}: invalid StructuredText for field '${field.api_key}' locale '${localeCode}': ${e.message}`,
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
                blocksOnly,
              });

              localizedDast[localeCode] = dast;
            }

            data[field.api_key] = localizedDast;
            record[field.api_key] = localizedDast;
            continue;
          }

          const stInput = yield* Schema.decodeUnknown(StructuredTextWriteInput)(data[field.api_key]).pipe(
            Effect.mapError((e) => new ValidationError({
              message: `Record ${idx}: invalid StructuredText for field '${field.api_key}': ${e.message}`,
              field: field.api_key,
            }))
          );

          const allowedBlockTypes = getBlockWhitelist(field.validators);
          const blocksOnly = getBlocksOnly(field.validators);

          const dast = yield* writeStructuredText({
            rootModelApiKey: model.api_key,
            fieldApiKey: field.api_key,
            rootRecordId: id,
            value: stInput.value,
            blocks: stInput.blocks,
            allowedBlockTypes: allowedBlockTypes ?? [],
            blocksOnly,
          });

          data[field.api_key] = dast;
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
          // Uniqueness enforcement
          if (data[field.api_key]) {
            let slug = String(data[field.api_key]);
            const baseSlug = slug;
            let suffix = 1;
            while (true) {
              const existing = yield* sql.unsafe<{ id: string }>(
                `SELECT id FROM "${tableName}" WHERE "${field.api_key}" = ?`, [slug]
              );
              if (existing.length === 0) break;
              suffix++;
              slug = `${baseSlug}-${suffix}`;
            }
            data[field.api_key] = slug;
          }
        }

        // Validate composite field types using registry schemas
        if (isFieldType(field.field_type) && data[field.api_key] !== undefined && data[field.api_key] !== null) {
          const fieldDef = getFieldTypeDef(field.field_type);
          if (fieldDef.inputSchema) {
            yield* Schema.decodeUnknown(fieldDef.inputSchema)(data[field.api_key]).pipe(
              Effect.mapError((e) => new ValidationError({
                message: `Record ${idx}: invalid ${field.field_type} for field '${field.api_key}': ${e.message}`,
                field: field.api_key,
              }))
            );
          }
        }

        if (data[field.api_key] !== undefined) {
          record[field.api_key] = data[field.api_key];
        }
      }

      yield* insertRecord(tableName, record);
      yield* SearchService.indexRecord(modelApiKey, id, record, modelFields).pipe(Effect.ignore);
      yield* fireHook("onRecordCreate", { modelApiKey, recordId: id });
      created.push({ id });
    }

    return { created: created.length, records: created };
  });
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
export function patchBlocksForField(body: PatchBlocksInput) {
  return Effect.gen(function* () {

    const model = yield* getModelByApiKey(body.modelApiKey);
    if (!model) return yield* new NotFoundError({ entity: "Model", id: body.modelApiKey });

    const tableName = `content_${model.api_key}`;
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
      mergedBlocks[blockId] = blockData as Record<string, unknown>;
    }

    // Apply patch
    for (const [blockId, patchValue] of Object.entries(body.blocks)) {
      if (patchValue === null) {
        // Delete this block
        blockIdsToDelete.add(blockId);
        delete mergedBlocks[blockId];
      } else if (typeof patchValue === "string") {
        // Keep unchanged — verify it exists
        if (!existingBlocks[blockId]) {
          return yield* new ValidationError({
            message: `Block '${blockId}' referenced in patch does not exist`,
            field: body.fieldApiKey,
          });
        }
      } else if (typeof patchValue === "object" && !Array.isArray(patchValue)) {
        // Partial merge
        const patchObj = patchValue as Record<string, unknown>;
        const existingBlock = existingBlocks[blockId];
        if (!existingBlock) {
          return yield* new ValidationError({
            message: `Block '${blockId}' referenced in patch does not exist`,
            field: body.fieldApiKey,
          });
        }
        // Merge: existing block data + patch (patch wins)
        mergedBlocks[blockId] = {
          ...(existingBlock as Record<string, unknown>),
          ...patchObj,
        };
      } else {
        return yield* new ValidationError({
          message: `Invalid patch value for block '${blockId}': expected string, object, or null`,
          field: body.fieldApiKey,
        });
      }
    }

    // Build final DAST value
    let finalDastValue: unknown;
    if (body.value !== undefined) {
      finalDastValue = body.value;
    } else if (blockIdsToDelete.size > 0) {
      // Auto-prune deleted blocks from existing DAST
      const existingDast = existingEnvelope.value as {
        schema: string;
        document: { type: string; children: readonly unknown[] };
      };
      finalDastValue = pruneBlockNodes(existingDast, blockIdsToDelete);
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
      blocksOnly,
    });

    // Update the content table
    const sql = yield* SqlClient.SqlClient;
    const now = new Date().toISOString();
    yield* sql.unsafe(
      `UPDATE "${tableName}" SET "${field.api_key}" = ?, _updated_at = ? WHERE id = ?`,
      [encodeJson(dast), now, body.recordId]
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
      const updated = yield* selectById(tableName, body.recordId);
      if (updated) {
        const snap: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(updated)) {
          if (!key.startsWith("_") && key !== "id") snap[key] = value;
        }
        yield* sql.unsafe(
          `UPDATE "${tableName}" SET _published_snapshot = ?, _published_at = ?, _status = 'published' WHERE id = ?`,
          [encodeJson(snap), now, body.recordId]
        );
      }
    }

    yield* SearchService.reindexRecord(body.modelApiKey, body.recordId, modelFields).pipe(Effect.ignore);
    yield* fireHook("onRecordUpdate", { modelApiKey: body.modelApiKey, recordId: body.recordId });

    return yield* selectById(tableName, body.recordId);
  });
}

/**
 * Reorder records for a sortable/tree model.
 * Accepts an ordered array of record IDs — sets _position = index.
 */
export function reorderRecords(modelApiKey: string, recordIds: readonly string[]) {
  return Effect.gen(function* () {
    const model = yield* getModelByApiKey(modelApiKey);
    if (!model) return yield* new NotFoundError({ entity: "Model", id: modelApiKey });
    if (!model.sortable && !model.tree)
      return yield* new ValidationError({ message: `Model '${modelApiKey}' is not sortable` });

    const sql = yield* SqlClient.SqlClient;
    const tableName = `content_${model.api_key}`;

    for (let i = 0; i < recordIds.length; i++) {
      yield* sql.unsafe(
        `UPDATE "${tableName}" SET "_position" = ? WHERE id = ?`,
        [i, recordIds[i]]
      );
    }

    return { reordered: recordIds.length };
  });
}
