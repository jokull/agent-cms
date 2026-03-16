import { Effect, Schema } from "effect";
import { SqlClient } from "@effect/sql";
import { ulid } from "ulidx";
import { FIELD_TYPES, isFieldType, type FieldType } from "../types.js";
import { NotFoundError, ValidationError, DuplicateError } from "../errors.js";
import { migrateContentTable } from "../schema-engine/sql-ddl.js";
import type { ModelRow, FieldRow } from "../db/row-types.js";
import { parseFieldValidators } from "../db/row-types.js";
import { CreateFieldInput } from "./input-schemas.js";

function syncTable(modelId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const models = yield* sql.unsafe<Pick<ModelRow, "api_key" | "is_block">>(
      "SELECT api_key, is_block FROM models WHERE id = ?",
      [modelId]
    );
    if (models.length === 0) return;
    const model = models[0];

    const fields = yield* sql.unsafe<Pick<FieldRow, "api_key" | "field_type">>(
      "SELECT api_key, field_type FROM fields WHERE model_id = ? ORDER BY position",
      [modelId]
    );
    yield* migrateContentTable(
      model.api_key,
      !!model.is_block,
      fields.map((f) => ({ apiKey: f.api_key, fieldType: isFieldType(f.field_type) ? f.field_type : "string" }))
    );
  });
}

export function listFields(modelId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const models = yield* sql.unsafe<{ id: string }>("SELECT id FROM models WHERE id = ?", [modelId]);
    if (models.length === 0) return yield* new NotFoundError({ entity: "Model", id: modelId });

    const fields = yield* sql.unsafe<FieldRow>(
      "SELECT * FROM fields WHERE model_id = ? ORDER BY position",
      [modelId]
    );
    return fields.map(parseFieldValidators);
  });
}

export function createField(modelId: string, rawBody: unknown) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const models = yield* sql.unsafe<{ id: string }>("SELECT id FROM models WHERE id = ?", [modelId]);
    if (models.length === 0) return yield* new NotFoundError({ entity: "Model", id: modelId });

    const body = yield* Schema.decodeUnknown(CreateFieldInput)(rawBody).pipe(
      Effect.mapError((e) => new ValidationError({ message: `Invalid input: ${e.message}` }))
    );

    if (!/^[a-z][a-z0-9_]*$/.test(body.apiKey))
      return yield* new ValidationError({ message: "apiKey must start with a lowercase letter and contain only lowercase letters, numbers, and underscores" });
    if (!isFieldType(body.fieldType))
      return yield* new ValidationError({ message: `fieldType must be one of: ${FIELD_TYPES.join(", ")}` });

    const existing = yield* sql.unsafe<{ id: string }>(
      "SELECT id FROM fields WHERE model_id = ? AND api_key = ?",
      [modelId, body.apiKey]
    );
    if (existing.length > 0)
      return yield* new DuplicateError({ message: `Field with apiKey '${body.apiKey}' already exists on this model` });

    const allFields = yield* sql.unsafe<{ id: string }>(
      "SELECT id FROM fields WHERE model_id = ?",
      [modelId]
    );
    const position = body.position ?? allFields.length;

    // Validate required field + defaultValue BEFORE any mutations
    const parsedValidators = body.validators ?? {};
    if (parsedValidators.required) {
      const modelInfo = yield* sql.unsafe<{ api_key: string; is_block: number }>(
        "SELECT api_key, is_block FROM models WHERE id = ?", [modelId]
      );
      if (modelInfo.length > 0) {
        const tableName = modelInfo[0].is_block ? `block_${modelInfo[0].api_key}` : `content_${modelInfo[0].api_key}`;
        const recordCount = yield* sql.unsafe<{ c: number }>(
          `SELECT COUNT(*) as c FROM "${tableName}"`,
        );
        if (recordCount[0]?.c > 0 && body.defaultValue === undefined) {
          return yield* new ValidationError({
            message: `Cannot add required field '${body.apiKey}' to model with ${recordCount[0].c} existing record(s) without a default_value. Provide a default_value.`,
            field: body.apiKey,
          });
        }
      }
    }

    const now = new Date().toISOString();
    const id = ulid();
    const validators = JSON.stringify(body.validators ?? {});

    yield* sql.unsafe(
      `INSERT INTO fields (id, model_id, label, api_key, field_type, position, localized, validators, default_value, appearance, hint, fieldset_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, modelId, body.label, body.apiKey, body.fieldType,
        position, body.localized ? 1 : 0, validators,
        body.defaultValue ? JSON.stringify(body.defaultValue) : null,
        body.appearance ? JSON.stringify(body.appearance) : null,
        body.hint ?? null, body.fieldsetId ?? null,
        now, now,
      ]
    );

    yield* syncTable(modelId);

    // Apply default value to existing records if required field with default
    if (parsedValidators.required && body.defaultValue !== undefined) {
      const modelInfo = yield* sql.unsafe<{ api_key: string; is_block: number }>(
        "SELECT api_key, is_block FROM models WHERE id = ?", [modelId]
      );
      if (modelInfo.length > 0) {
        const tableName = modelInfo[0].is_block ? `block_${modelInfo[0].api_key}` : `content_${modelInfo[0].api_key}`;
        const serialized = typeof body.defaultValue === "object" && body.defaultValue !== null
          ? JSON.stringify(body.defaultValue)
          : typeof body.defaultValue === "boolean"
            ? (body.defaultValue ? 1 : 0)
            : body.defaultValue;
        yield* sql.unsafe(
          `UPDATE "${tableName}" SET "${body.apiKey}" = ? WHERE "${body.apiKey}" IS NULL`,
          [serialized]
        );
      }
    }

    return {
      id, modelId, label: body.label, apiKey: body.apiKey, fieldType: body.fieldType,
      position, localized: body.localized ?? false, validators: body.validators ?? {},
      defaultValue: body.defaultValue ?? null, appearance: body.appearance ?? null,
      hint: body.hint ?? null, fieldsetId: body.fieldsetId ?? null,
      createdAt: now, updatedAt: now,
    };
  });
}

export function updateField(fieldId: string, body: Record<string, unknown>) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fields = yield* sql.unsafe<FieldRow>("SELECT * FROM fields WHERE id = ?", [fieldId]);
    if (fields.length === 0) return yield* new NotFoundError({ entity: "Field", id: fieldId });

    const field = fields[0];

    // Reject field type changes if field has data
    if (body.fieldType !== undefined && body.fieldType !== field.field_type) {
      const model = yield* sql.unsafe<{ api_key: string; is_block: number }>(
        "SELECT api_key, is_block FROM models WHERE id = ?",
        [field.model_id]
      );
      if (model.length > 0) {
        const tableName = model[0].is_block ? `block_${model[0].api_key}` : `content_${model[0].api_key}`;
        const rows = yield* sql.unsafe<{ c: number }>(
          `SELECT COUNT(*) as c FROM "${tableName}" WHERE "${field.api_key}" IS NOT NULL`,
        );
        if (rows[0]?.c > 0) {
          return yield* new ValidationError({
            message: `Cannot change field type of '${field.api_key}' from '${field.field_type}' to '${body.fieldType}': field has data in ${rows[0].c} record(s). Clear the field data first.`,
            field: field.api_key,
          });
        }
      }
      // If no data, allow the type change
      // (Would need DDL column type change in a full implementation, but v1 simplification)
    }

    const now = new Date().toISOString();
    const sets: string[] = ["updated_at = ?"];
    const values: unknown[] = [now];

    if (body.label !== undefined) { sets.push("label = ?"); values.push(body.label); }
    if (body.position !== undefined) { sets.push("position = ?"); values.push(body.position); }
    if (body.localized !== undefined) { sets.push("localized = ?"); values.push(body.localized ? 1 : 0); }
    if (body.validators !== undefined) { sets.push("validators = ?"); values.push(JSON.stringify(body.validators)); }
    if (body.hint !== undefined) { sets.push("hint = ?"); values.push(body.hint); }
    if (body.appearance !== undefined) { sets.push("appearance = ?"); values.push(JSON.stringify(body.appearance)); }

    // Handle api_key rename → rename the column + update block references
    if (typeof body.apiKey === "string" && body.apiKey !== field.api_key) {
      const newApiKey = body.apiKey;
      if (!/^[a-z][a-z0-9_]*$/.test(newApiKey))
        return yield* new ValidationError({ message: "apiKey must start with a lowercase letter and contain only lowercase letters, numbers, and underscores" });

      // Check uniqueness within model
      const conflict = yield* sql.unsafe<{ id: string }>(
        "SELECT id FROM fields WHERE model_id = ? AND api_key = ? AND id != ?",
        [field.model_id, newApiKey, fieldId]
      );
      if (conflict.length > 0)
        return yield* new DuplicateError({ message: `Field with apiKey '${newApiKey}' already exists on this model` });

      // Rename column in the dynamic table
      const modelInfo = yield* sql.unsafe<{ api_key: string; is_block: number }>(
        "SELECT api_key, is_block FROM models WHERE id = ?", [field.model_id]
      );
      if (modelInfo.length > 0) {
        const tableName = modelInfo[0].is_block ? `block_${modelInfo[0].api_key}` : `content_${modelInfo[0].api_key}`;
        yield* sql.unsafe(`ALTER TABLE "${tableName}" RENAME COLUMN "${field.api_key}" TO "${newApiKey}"`);
      }

      // Update _root_field_api_key in block tables if this was a ST field
      if (field.field_type === "structured_text") {
        const blockModels = yield* sql.unsafe<{ api_key: string }>("SELECT api_key FROM models WHERE is_block = 1");
        for (const bm of blockModels) {
          yield* sql.unsafe(
            `UPDATE "block_${bm.api_key}" SET _root_field_api_key = ? WHERE _root_field_api_key = ?`,
            [newApiKey, field.api_key]
          );
        }
      }

      sets.push("api_key = ?");
      values.push(newApiKey);
    }

    yield* sql.unsafe(`UPDATE fields SET ${sets.join(", ")} WHERE id = ?`, [...values, fieldId]);

    const updated = yield* sql.unsafe<FieldRow>("SELECT * FROM fields WHERE id = ?", [fieldId]);
    return parseFieldValidators(updated[0]);
  });
}

export function deleteField(fieldId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fields = yield* sql.unsafe<{ model_id: string }>("SELECT model_id FROM fields WHERE id = ?", [fieldId]);
    if (fields.length === 0) return yield* new NotFoundError({ entity: "Field", id: fieldId });

    const modelId = fields[0].model_id;
    yield* sql.unsafe("DELETE FROM fields WHERE id = ?", [fieldId]);
    yield* syncTable(modelId);

    return { deleted: true };
  });
}

// Input schema imported from ./input-schemas.ts
