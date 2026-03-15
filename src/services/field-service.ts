import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { ulid } from "ulidx";
import { FIELD_TYPES, type FieldType } from "../types.js";
import { NotFoundError, ValidationError, DuplicateError } from "../errors.js";
import { migrateContentTable } from "../schema-engine/sql-ddl.js";

function getModelFields(sql: SqlClient.SqlClient, modelId: string) {
  return sql.unsafe<{ api_key: string; field_type: string }>(
    "SELECT api_key, field_type FROM fields WHERE model_id = ? ORDER BY position",
    [modelId]
  );
}

function syncTable(modelId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const models = yield* sql.unsafe<{ api_key: string; is_block: number }>(
      "SELECT api_key, is_block FROM models WHERE id = ?",
      [modelId]
    );
    if (models.length === 0) return;
    const model = models[0];

    const fields = yield* getModelFields(sql, modelId);
    yield* migrateContentTable(
      model.api_key,
      !!model.is_block,
      fields.map((f) => ({ apiKey: f.api_key, fieldType: f.field_type as FieldType }))
    );
  });
}

export function listFields(modelId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const models = yield* sql.unsafe<{ id: string }>("SELECT id FROM models WHERE id = ?", [modelId]);
    if (models.length === 0) return yield* new NotFoundError({ entity: "Model", id: modelId });

    const fields = yield* sql.unsafe<Record<string, any>>(
      "SELECT * FROM fields WHERE model_id = ? ORDER BY position",
      [modelId]
    );
    return fields.map((f) => ({ ...f, validators: JSON.parse(f.validators || "{}") }));
  });
}

export function createField(modelId: string, body: any) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const models = yield* sql.unsafe<{ id: string }>("SELECT id FROM models WHERE id = ?", [modelId]);
    if (models.length === 0) return yield* new NotFoundError({ entity: "Model", id: modelId });

    if (!body.label || typeof body.label !== "string")
      return yield* new ValidationError({ message: "label is required and must be a string" });
    if (!body.apiKey || typeof body.apiKey !== "string")
      return yield* new ValidationError({ message: "apiKey is required and must be a string" });
    if (!/^[a-z][a-z0-9_]*$/.test(body.apiKey))
      return yield* new ValidationError({ message: "apiKey must start with a lowercase letter and contain only lowercase letters, numbers, and underscores" });
    if (!body.fieldType || !FIELD_TYPES.includes(body.fieldType as FieldType))
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

    // Sync the dynamic table
    yield* syncTable(modelId);

    return {
      id, modelId, label: body.label, apiKey: body.apiKey, fieldType: body.fieldType,
      position, localized: body.localized ?? false, validators: body.validators ?? {},
      defaultValue: body.defaultValue ?? null, appearance: body.appearance ?? null,
      hint: body.hint ?? null, fieldsetId: body.fieldsetId ?? null,
      createdAt: now, updatedAt: now,
    };
  });
}

export function updateField(fieldId: string, body: any) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fields = yield* sql.unsafe<Record<string, any>>("SELECT * FROM fields WHERE id = ?", [fieldId]);
    if (fields.length === 0) return yield* new NotFoundError({ entity: "Field", id: fieldId });

    const now = new Date().toISOString();
    const sets: string[] = ["updated_at = ?"];
    const values: any[] = [now];

    if (body.label !== undefined) { sets.push("label = ?"); values.push(body.label); }
    if (body.position !== undefined) { sets.push("position = ?"); values.push(body.position); }
    if (body.localized !== undefined) { sets.push("localized = ?"); values.push(body.localized ? 1 : 0); }
    if (body.validators !== undefined) { sets.push("validators = ?"); values.push(JSON.stringify(body.validators)); }
    if (body.hint !== undefined) { sets.push("hint = ?"); values.push(body.hint); }
    if (body.appearance !== undefined) { sets.push("appearance = ?"); values.push(JSON.stringify(body.appearance)); }

    yield* sql.unsafe(`UPDATE fields SET ${sets.join(", ")} WHERE id = ?`, [...values, fieldId]);

    const updated = yield* sql.unsafe<Record<string, any>>("SELECT * FROM fields WHERE id = ?", [fieldId]);
    return { ...updated[0], validators: JSON.parse(updated[0].validators || "{}") };
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
