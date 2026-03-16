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
import { writeStructuredText, deleteBlocksForField } from "./structured-text-service.js";
import type { ModelRow, FieldRow, ParsedFieldRow, ContentRow } from "../db/row-types.js";
import { parseFieldValidators, isContentRow } from "../db/row-types.js";
import { getSlugSource, getBlockWhitelist, getBlocksOnly, isRequired } from "../db/validators.js";
import { fireWebhooks } from "./webhook-service.js";
import * as SearchService from "../search/search-service.js";
import { CreateRecordInput, PatchRecordInput } from "./input-schemas.js";
import { getFieldTypeDef } from "../field-types.js";
import { isFieldType } from "../types.js";
import { StructuredTextWriteInput } from "../dast/schema.js";

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

export function createRecord(rawBody: unknown) {
  return Effect.gen(function* () {
    const body = yield* Schema.decodeUnknown(CreateRecordInput)(rawBody).pipe(
      Effect.mapError((e) => new ValidationError({ message: `Invalid input: ${e.message}` }))
    );

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

    // Validate required fields
    for (const field of modelFields) {
      if (isRequired(field.validators) && (data[field.api_key] === undefined || data[field.api_key] === null || data[field.api_key] === ""))
        return yield* new ValidationError({ message: `Field '${field.api_key}' is required`, field: field.api_key });
    }

    const now = new Date().toISOString();
    const id = ulid();
    const sql = yield* SqlClient.SqlClient;
    // Models with hasDraft=false skip draft state, publish immediately
    const initialStatus = model.has_draft ? "draft" : "published";
    const record: Record<string, unknown> = {
      id,
      _status: initialStatus,
      _created_at: now,
      _updated_at: now,
      ...(!model.has_draft ? { _published_at: now, _first_published_at: now } : {}),
    };

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
        const stInput = yield* Schema.decodeUnknown(StructuredTextWriteInput)(data[field.api_key]).pipe(
          Effect.mapError((e) => new ValidationError({
            message: `Invalid StructuredText for field '${field.api_key}': ${e.message}`,
            field: field.api_key,
          }))
        );

        const allowedBlockTypes = getBlockWhitelist(field.validators);
        const blocksOnly = getBlocksOnly(field.validators);

        const dast = yield* writeStructuredText({
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
        if (!data[field.api_key] && sourceFieldKey && data[sourceFieldKey]) {
          data[field.api_key] = generateSlug(String(data[sourceFieldKey]));
        } else if (data[field.api_key]) {
          data[field.api_key] = generateSlug(String(data[field.api_key]));
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
          yield* Schema.decodeUnknown(fieldDef.inputSchema)(data[field.api_key]).pipe(
            Effect.mapError((e) => new ValidationError({
              message: `Invalid ${field.field_type} for field '${field.api_key}': ${e.message}`,
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

    // Index for search
    yield* SearchService.indexRecord(body.modelApiKey, id, record, modelFields).pipe(Effect.ignore);

    // Fire webhook (non-blocking)
    yield* fireWebhooks("record.create", { modelApiKey: body.modelApiKey, recordId: id });

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

export function patchRecord(id: string, rawBody: unknown) {
  return Effect.gen(function* () {
    const body = yield* Schema.decodeUnknown(PatchRecordInput)(rawBody).pipe(
      Effect.mapError((e) => new ValidationError({ message: `Invalid input: ${e.message}` }))
    );
    const model = yield* getModelByApiKey(body.modelApiKey);
    if (!model) return yield* new NotFoundError({ entity: "Model", id: body.modelApiKey });

    const tableName = `content_${model.api_key}`;
    const existing = yield* selectById(tableName, id);
    if (!existing) return yield* new NotFoundError({ entity: "Record", id });

    const modelFields = yield* getModelFields(model.id);
    const updates: Record<string, unknown> = { _updated_at: new Date().toISOString() };

    // Status transition: published → updated on edit
    if (isContentRow(existing) && existing._status === "published") {
      updates._status = "updated";
    }

    const data: Record<string, unknown> = { ...(body.data ?? {}) };

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

    for (const field of modelFields) {
      // StructuredText update: delete old blocks, write new ones
      if (field.field_type === "structured_text" && data[field.api_key] !== undefined) {
        if (data[field.api_key] === null) {
          // Clearing the field
          yield* deleteBlocksForField({ rootRecordId: id, fieldApiKey: field.api_key });
        } else {
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

      if (data[field.api_key] !== undefined) {
        updates[field.api_key] = data[field.api_key];
      }
    }

    yield* sqlUpdateRecord(tableName, id, updates);
    yield* SearchService.reindexRecord(body.modelApiKey, id, modelFields).pipe(Effect.ignore);
    yield* fireWebhooks("record.update", { modelApiKey: body.modelApiKey, recordId: id });
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
    yield* SearchService.deindexRecord(modelApiKey, id).pipe(Effect.ignore);
    yield* fireWebhooks("record.delete", { modelApiKey, recordId: id });
    return { deleted: true };
  });
}

/**
 * Bulk create records in a single operation.
 * All records must belong to the same model. Runs in a logical batch
 * (individual inserts, but avoids per-record overhead of schema lookups).
 */
export function bulkCreateRecords(rawBody: unknown) {
  return Effect.gen(function* () {
    if (typeof rawBody !== "object" || rawBody === null || !("modelApiKey" in rawBody) || !("records" in rawBody)) {
      return yield* new ValidationError({ message: "Expected { modelApiKey: string, records: Array<Record<string, unknown>> }" });
    }
    const { modelApiKey, records } = rawBody as { modelApiKey: string; records: unknown[] };

    if (!modelApiKey || typeof modelApiKey !== "string")
      return yield* new ValidationError({ message: "modelApiKey is required" });
    if (!Array.isArray(records) || records.length === 0)
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

    for (const rawRecord of records) {
      if (typeof rawRecord !== "object" || rawRecord === null) continue;
      const data: Record<string, unknown> = { ...(rawRecord as Record<string, unknown>) };

      const id = ulid();
      const record: Record<string, unknown> = {
        id,
        _status: initialStatus,
        _created_at: now,
        _updated_at: now,
        ...(!model.has_draft ? { _published_at: now, _first_published_at: now } : {}),
      };

      if (model.sortable || model.tree) {
        record._position = nextPosition++;
      }

      // Process slug fields
      for (const field of modelFields) {
        if (field.field_type === "slug") {
          const sourceFieldKey = getSlugSource(field.validators);
          if (!data[field.api_key] && sourceFieldKey && data[sourceFieldKey]) {
            data[field.api_key] = generateSlug(String(data[sourceFieldKey]));
          } else if (data[field.api_key]) {
            data[field.api_key] = generateSlug(String(data[field.api_key]));
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

        if (data[field.api_key] !== undefined) {
          record[field.api_key] = data[field.api_key];
        }
      }

      yield* insertRecord(tableName, record);
      yield* SearchService.indexRecord(modelApiKey, id, record, modelFields).pipe(Effect.ignore);
      created.push({ id });
    }

    // Fire a single webhook for the batch
    yield* fireWebhooks("record.create", { modelApiKey, recordIds: created.map((r) => r.id), bulk: true });

    return { created: created.length, records: created };
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
