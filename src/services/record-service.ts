import { Effect } from "effect";
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

export function createRecord(body: unknown) {
  return Effect.gen(function* () {
    if (!isCreateRecordInput(body))
      return yield* new ValidationError({ message: "modelApiKey is required" });

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
    const record: Record<string, unknown> = {
      id,
      _status: "draft",
      _created_at: now,
      _updated_at: now,
    };

    // Process fields
    for (const field of modelFields) {
      // StructuredText: validate DAST + write blocks
      if (field.field_type === "structured_text" && data[field.api_key] !== undefined) {
        const stInput = data[field.api_key];
        if (isStructuredTextInput(stInput)) {
          const allowedBlockTypes = getBlockWhitelist(field.validators);
          const blocksOnly = getBlocksOnly(field.validators);

          const dast = yield* writeStructuredText({
            fieldApiKey: field.api_key,
            rootRecordId: id,
            value: stInput.value,
            blocks: stInput.blocks ?? {},
            allowedBlockTypes,
            blocksOnly,
          });

          data[field.api_key] = dast;
        }
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
          const sql = yield* SqlClient.SqlClient;
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

      if (data[field.api_key] !== undefined) {
        record[field.api_key] = data[field.api_key];
      }
    }

    yield* insertRecord(tableName, record);
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

export function patchRecord(id: string, body: unknown) {
  return Effect.gen(function* () {
    if (!isPatchRecordInput(body))
      return yield* new ValidationError({ message: "modelApiKey is required" });
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
    for (const field of modelFields) {
      // StructuredText update: delete old blocks, write new ones
      if (field.field_type === "structured_text" && data[field.api_key] !== undefined) {
        const stInput = data[field.api_key];
        if (isStructuredTextInput(stInput)) {
          yield* deleteBlocksForField({ rootRecordId: id, fieldApiKey: field.api_key });

          const allowedBlockTypes = getBlockWhitelist(field.validators);
          const blocksOnly = getBlocksOnly(field.validators);

          const dast = yield* writeStructuredText({
            fieldApiKey: field.api_key,
            rootRecordId: id,
            value: stInput.value,
            blocks: stInput.blocks ?? {},
            allowedBlockTypes,
            blocksOnly,
          });

          data[field.api_key] = dast;
        } else if (stInput === null) {
          yield* deleteBlocksForField({ rootRecordId: id, fieldApiKey: field.api_key });
        }
      }

      if (data[field.api_key] !== undefined) {
        updates[field.api_key] = data[field.api_key];
      }
    }

    yield* sqlUpdateRecord(tableName, id, updates);
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

    yield* sqlDeleteRecord(tableName, id);
    return { deleted: true };
  });
}

// --- Input type guards ---

interface CreateRecordInput {
  modelApiKey: string;
  data?: Record<string, unknown>;
}

function isCreateRecordInput(input: unknown): input is CreateRecordInput {
  if (typeof input !== "object" || input === null) return false;
  const obj = input as Record<string, unknown>;
  return typeof obj.modelApiKey === "string" && obj.modelApiKey.length > 0;
}

interface PatchRecordInput {
  modelApiKey: string;
  data?: Record<string, unknown>;
}

function isPatchRecordInput(input: unknown): input is PatchRecordInput {
  if (typeof input !== "object" || input === null) return false;
  const obj = input as Record<string, unknown>;
  return typeof obj.modelApiKey === "string";
}

interface StructuredTextInput {
  value: unknown;
  blocks?: Record<string, unknown>;
}

function isStructuredTextInput(input: unknown): input is StructuredTextInput {
  if (typeof input !== "object" || input === null) return false;
  const obj = input as Record<string, unknown>;
  return "value" in obj && obj.value !== undefined;
}
