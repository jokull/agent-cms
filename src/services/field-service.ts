import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { ulid } from "ulidx";
import { FIELD_TYPES, isFieldType } from "../types.js";
import { NotFoundError, ValidationError, DuplicateError, ReferenceConflictError } from "../errors.js";
import { migrateContentTable } from "../schema-engine/sql-ddl.js";
import type { ModelRow, FieldRow } from "../db/row-types.js";
import { parseFieldValidators } from "../db/row-types.js";
import type { CreateFieldInput, UpdateFieldInput } from "./input-schemas.js";
import { deleteBlockSubtrees } from "./structured-text-service.js";
import { isUnique, supportsUniqueValidation } from "../db/validators.js";
import { decodeJsonRecordStringOr, encodeJson } from "../json.js";

const ALLOWED_FIELD_VALIDATOR_KEYS = new Set([
  "required",
  "unique",
  "enum",
  "length",
  "number_range",
  "format",
  "date_range",
  "slug_source",
  "item_item_type",
  "items_item_type",
  "structured_text_blocks",
  "blocks_only",
  "searchable",
]);

function validateFieldValidators(
  fieldType: string,
  apiKey: string,
  validators: Record<string, unknown>,
) {
  return Effect.gen(function* () {
    const unknownKeys = Object.keys(validators).filter((key) => !ALLOWED_FIELD_VALIDATOR_KEYS.has(key));
    if (unknownKeys.length > 0) {
      return yield* new ValidationError({
        message: `Unknown validator key(s): ${unknownKeys.join(", ")}`,
        field: apiKey,
      });
    }

    if (validators.required !== undefined && typeof validators.required !== "boolean") {
      return yield* new ValidationError({
        message: `required validator must be a boolean`,
        field: apiKey,
      });
    }

    if (isUnique(validators) && !supportsUniqueValidation(fieldType)) {
      return yield* new ValidationError({
        message: `unique validator is not supported for field type '${fieldType}'`,
        field: apiKey,
      });
    }
    if (validators.unique !== undefined && typeof validators.unique !== "boolean") {
      return yield* new ValidationError({
        message: `unique validator must be a boolean`,
        field: apiKey,
      });
    }

    if (validators.searchable !== undefined && typeof validators.searchable !== "boolean") {
      return yield* new ValidationError({
        message: `searchable validator must be a boolean`,
        field: apiKey,
      });
    }

    const enumValues = validators.enum;
    if (enumValues !== undefined) {
      if (!["string", "text", "slug"].includes(fieldType)) {
        return yield* new ValidationError({
          message: `enum validator is only supported for string, text, and slug fields`,
          field: apiKey,
        });
      }
      if (!Array.isArray(enumValues) || !enumValues.every((value) => typeof value === "string")) {
        return yield* new ValidationError({
          message: `enum validator must be an array of strings`,
          field: apiKey,
        });
      }
    }

    const length = validators.length;
    if (length !== undefined) {
      if (!["string", "text", "slug"].includes(fieldType)) {
        return yield* new ValidationError({
          message: `length validator is only supported for string, text, and slug fields`,
          field: apiKey,
        });
      }
      if (typeof length !== "object" || length === null || Array.isArray(length)) {
        return yield* new ValidationError({
          message: `length validator must be an object`,
          field: apiKey,
        });
      }
      const lengthConfig = length as { min?: unknown; max?: unknown };
      if (lengthConfig.min !== undefined && (typeof lengthConfig.min !== "number" || lengthConfig.min < 0)) {
        return yield* new ValidationError({
          message: `length.min must be a non-negative number`,
          field: apiKey,
        });
      }
      if (lengthConfig.max !== undefined && (typeof lengthConfig.max !== "number" || lengthConfig.max < 0)) {
        return yield* new ValidationError({
          message: `length.max must be a non-negative number`,
          field: apiKey,
        });
      }
    }

    const slugSource = validators.slug_source;
    if (slugSource !== undefined) {
      if (fieldType !== "slug") {
        return yield* new ValidationError({
          message: `slug_source validator is only supported for slug fields`,
          field: apiKey,
        });
      }
      if (typeof slugSource !== "string" || slugSource.length === 0) {
        return yield* new ValidationError({
          message: `slug_source validator must be a non-empty string`,
          field: apiKey,
        });
      }
    }

    const itemItemType = validators.item_item_type;
    if (itemItemType !== undefined) {
      if (fieldType !== "link") {
        return yield* new ValidationError({
          message: `item_item_type validator is only supported for link fields`,
          field: apiKey,
        });
      }
      if (!Array.isArray(itemItemType) || !itemItemType.every((value) => typeof value === "string")) {
        return yield* new ValidationError({
          message: `item_item_type validator must be an array of strings`,
          field: apiKey,
        });
      }
    }

    const itemsItemType = validators.items_item_type;
    if (itemsItemType !== undefined) {
      if (fieldType !== "links") {
        return yield* new ValidationError({
          message: `items_item_type validator is only supported for links fields`,
          field: apiKey,
        });
      }
      if (!Array.isArray(itemsItemType) || !itemsItemType.every((value) => typeof value === "string")) {
        return yield* new ValidationError({
          message: `items_item_type validator must be an array of strings`,
          field: apiKey,
        });
      }
    }

    const blocksOnly = validators.blocks_only;
    if (blocksOnly !== undefined) {
      if (fieldType !== "structured_text") {
        return yield* new ValidationError({
          message: `blocks_only validator is only supported for structured_text fields`,
          field: apiKey,
        });
      }
      if (typeof blocksOnly !== "boolean") {
        return yield* new ValidationError({
          message: `blocks_only validator must be a boolean`,
          field: apiKey,
        });
      }
    }

    const structuredTextBlocks = validators.structured_text_blocks;
    if (structuredTextBlocks !== undefined) {
      if (fieldType !== "structured_text") {
        return yield* new ValidationError({
          message: `structured_text_blocks validator is only supported for structured_text fields`,
          field: apiKey,
        });
      }
      if (!Array.isArray(structuredTextBlocks) || !structuredTextBlocks.every((value) => typeof value === "string")) {
        return yield* new ValidationError({
          message: `structured_text_blocks validator must be an array of strings`,
          field: apiKey,
        });
      }
    }

    const numberRange = validators.number_range;
    if (numberRange !== undefined) {
      if (!["integer", "float"].includes(fieldType)) {
        return yield* new ValidationError({
          message: `number_range validator is only supported for integer and float fields`,
          field: apiKey,
        });
      }
      if (typeof numberRange !== "object" || numberRange === null || Array.isArray(numberRange)) {
        return yield* new ValidationError({
          message: `number_range validator must be an object`,
          field: apiKey,
        });
      }
      const rangeConfig = numberRange as { min?: unknown; max?: unknown };
      if (rangeConfig.min !== undefined && typeof rangeConfig.min !== "number") {
        return yield* new ValidationError({
          message: `number_range.min must be a number`,
          field: apiKey,
        });
      }
      if (rangeConfig.max !== undefined && typeof rangeConfig.max !== "number") {
        return yield* new ValidationError({
          message: `number_range.max must be a number`,
          field: apiKey,
        });
      }
    }

    const format = validators.format;
    if (format !== undefined) {
      if (!["string", "text", "slug"].includes(fieldType)) {
        return yield* new ValidationError({
          message: `format validator is only supported for string, text, and slug fields`,
          field: apiKey,
        });
      }
      const isPreset = format === "email" || format === "url";
      const isCustom = typeof format === "object"
        && format !== null
        && !Array.isArray(format)
        && typeof (format as { custom_pattern?: unknown }).custom_pattern === "string";
      if (!isPreset && !isCustom) {
        return yield* new ValidationError({
          message: `format validator must be 'email', 'url', or { custom_pattern: string }`,
          field: apiKey,
        });
      }
    }

    const dateRange = validators.date_range;
    if (dateRange !== undefined) {
      if (!["date", "date_time"].includes(fieldType)) {
        return yield* new ValidationError({
          message: `date_range validator is only supported for date and date_time fields`,
          field: apiKey,
        });
      }
      if (typeof dateRange !== "object" || dateRange === null || Array.isArray(dateRange)) {
        return yield* new ValidationError({
          message: `date_range validator must be an object`,
          field: apiKey,
        });
      }
      const dateRangeConfig = dateRange as { min?: unknown; max?: unknown };
      for (const key of ["min", "max"] as const) {
        const boundary = dateRangeConfig[key];
        if (boundary !== undefined && boundary !== "now" && typeof boundary !== "string") {
          return yield* new ValidationError({
            message: `date_range.${key} must be an ISO datetime string or 'now'`,
            field: apiKey,
          });
        }
      }
    }
  });
}

function serializeDefaultValueForFieldMetadata(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value === "string") return value;
  return encodeJson(value);
}

function serializeDefaultValueForRecordColumn(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "object" && value !== null) return encodeJson(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

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

export function createField(modelId: string, body: CreateFieldInput) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const models = yield* sql.unsafe<{ id: string }>("SELECT id FROM models WHERE id = ?", [modelId]);
    if (models.length === 0) return yield* new NotFoundError({ entity: "Model", id: modelId });

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
    const parsedValidators = body.validators;
    yield* validateFieldValidators(body.fieldType, body.apiKey, parsedValidators);
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
    const validators = encodeJson(body.validators);

    yield* sql.unsafe(
      `INSERT INTO fields (id, model_id, label, api_key, field_type, position, localized, validators, default_value, appearance, hint, fieldset_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, modelId, body.label, body.apiKey, body.fieldType,
        position, body.localized ? 1 : 0, validators,
        serializeDefaultValueForFieldMetadata(body.defaultValue),
        body.appearance ? encodeJson(body.appearance) : null,
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
        const serialized = serializeDefaultValueForRecordColumn(body.defaultValue);
        yield* sql.unsafe(
          `UPDATE "${tableName}" SET "${body.apiKey}" = ? WHERE "${body.apiKey}" IS NULL`,
          [serialized]
        );
      }
    }

    return {
      id, modelId, label: body.label, apiKey: body.apiKey, fieldType: body.fieldType,
      position, localized: body.localized, validators: body.validators,
      defaultValue: body.defaultValue ?? null, appearance: body.appearance ?? null,
      hint: body.hint ?? null, fieldsetId: body.fieldsetId ?? null,
      createdAt: now, updatedAt: now,
    };
  });
}

export function updateField(fieldId: string, body: UpdateFieldInput) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fields = yield* sql.unsafe<FieldRow>("SELECT * FROM fields WHERE id = ?", [fieldId]);
    if (fields.length === 0) return yield* new NotFoundError({ entity: "Field", id: fieldId });

    const field = fields[0];
    const nextFieldType = body.fieldType ?? field.field_type;
    const nextValidators = body.validators ?? parseFieldValidators(field).validators;
    yield* validateFieldValidators(nextFieldType, field.api_key, nextValidators);

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
    if (body.validators !== undefined) { sets.push("validators = ?"); values.push(encodeJson(body.validators)); }
    if (body.hint !== undefined) { sets.push("hint = ?"); values.push(body.hint); }
    if (body.appearance !== undefined) { sets.push("appearance = ?"); values.push(encodeJson(body.appearance)); }

    // Handle api_key rename → rename the column + update block references
    if (body.apiKey !== undefined && body.apiKey !== field.api_key) {
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
          if (modelInfo[0].is_block) {
            yield* sql.unsafe(
              `UPDATE "block_${bm.api_key}"
               SET _parent_field_api_key = ?
               WHERE _parent_container_model_api_key = ? AND _parent_field_api_key = ?`,
              [newApiKey, modelInfo[0].api_key, field.api_key]
            );
          } else {
            yield* sql.unsafe(
              `UPDATE "block_${bm.api_key}"
               SET _root_field_api_key = ?
               WHERE _root_field_api_key = ?`,
              [newApiKey, field.api_key]
            );
            yield* sql.unsafe(
              `UPDATE "block_${bm.api_key}"
               SET _parent_field_api_key = ?
               WHERE _parent_container_model_api_key = ? AND _parent_block_id IS NULL AND _parent_field_api_key = ?`,
              [newApiKey, modelInfo[0].api_key, field.api_key]
            );
          }
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
    const fields = yield* sql.unsafe<FieldRow>("SELECT * FROM fields WHERE id = ?", [fieldId]);
    if (fields.length === 0) return yield* new NotFoundError({ entity: "Field", id: fieldId });

    const field = fields[0];
    const modelId = field.model_id;

    // Check if any slug field in the same model depends on this field via slug_source
    const siblingFields = yield* sql.unsafe<FieldRow>(
      "SELECT * FROM fields WHERE model_id = ? AND field_type = 'slug' AND id != ?",
      [modelId, fieldId]
    );
    for (const slugField of siblingFields) {
      const validators = decodeJsonRecordStringOr(slugField.validators || "{}", {});
      if (validators.slug_source === field.api_key) {
        return yield* new ReferenceConflictError({
          message: `Cannot delete field '${field.api_key}': slug field '${slugField.api_key}' depends on it via slug_source`,
          references: [`${slugField.api_key}.slug_source`],
        });
      }
    }

    // Get model info for table operations
    const modelInfo = yield* sql.unsafe<ModelRow>(
      "SELECT * FROM models WHERE id = ?", [modelId]
    );

    if (modelInfo.length > 0) {
      const tableName = modelInfo[0].is_block ? `block_${modelInfo[0].api_key}` : `content_${modelInfo[0].api_key}`;

      // Strip deleted field from all published snapshots
      const publishedRecords = yield* sql.unsafe<{ id: string; _published_snapshot: string }>(
        `SELECT id, _published_snapshot FROM "${tableName}" WHERE _published_snapshot IS NOT NULL`
      );
      for (const record of publishedRecords) {
        let snapshot: Record<string, unknown>;
        snapshot = decodeJsonRecordStringOr(record._published_snapshot, {});
        if (Object.keys(snapshot).length === 0) continue;
        if (field.api_key in snapshot) {
          delete snapshot[field.api_key];
          yield* sql.unsafe(
            `UPDATE "${tableName}" SET _published_snapshot = ? WHERE id = ?`,
            [encodeJson(snapshot), record.id]
          );
        }
      }

      // Clean up orphaned block rows if this is a structured_text field
      if (field.field_type === "structured_text") {
        const blockModels = yield* sql.unsafe<{ api_key: string }>("SELECT api_key FROM models WHERE is_block = 1");
        if (modelInfo[0].is_block) {
          const directChildIds: string[] = [];
          for (const bm of blockModels) {
            const rows = yield* sql.unsafe<{ id: string }>(
              `SELECT id FROM "block_${bm.api_key}"
               WHERE _parent_container_model_api_key = ?
                 AND _parent_field_api_key = ?
                 AND _parent_block_id IN (SELECT id FROM "${tableName}")`,
              [modelInfo[0].api_key, field.api_key]
            );
            directChildIds.push(...rows.map((r) => r.id));
          }
          yield* deleteBlockSubtrees({ blockIds: directChildIds });
        } else {
          for (const bm of blockModels) {
            yield* sql.unsafe(
              `DELETE FROM "block_${bm.api_key}" WHERE _root_field_api_key = ? AND _root_record_id IN (SELECT id FROM "${tableName}")`,
              [field.api_key]
            );
          }
        }
      }
    }

    yield* sql.unsafe("DELETE FROM fields WHERE id = ?", [fieldId]);
    yield* syncTable(modelId);

    return { deleted: true };
  });
}

// Input schema imported from ./input-schemas.ts
