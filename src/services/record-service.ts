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
import { CreateRecordInput, PatchRecordInput } from "./input-schemas.js";
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
    const record: Record<string, unknown> = {
      id,
      _status: "draft",
      _created_at: now,
      _updated_at: now,
    };

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
          allowedBlockTypes,
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
            allowedBlockTypes,
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

    yield* sqlDeleteRecord(tableName, id);
    yield* fireWebhooks("record.delete", { modelApiKey, recordId: id });
    return { deleted: true };
  });
}

// Input schemas imported from ./input-schemas.ts and ../dast/schema.ts
