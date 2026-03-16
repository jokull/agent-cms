import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { NotFoundError, ValidationError } from "../errors.js";
import { selectById } from "../schema-engine/sql-records.js";
import type { ModelRow, ContentRow, FieldRow } from "../db/row-types.js";
import { parseFieldValidators } from "../db/row-types.js";
import { computeIsValid } from "../db/validators.js";
import { materializeRecordStructuredTextFields } from "./structured-text-service.js";
import { fireHook } from "../hooks.js";

export function publishRecord(modelApiKey: string, recordId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const models = yield* sql.unsafe<ModelRow>(
      "SELECT * FROM models WHERE api_key = ? AND is_block = 0",
      [modelApiKey]
    );
    if (models.length === 0) return yield* new NotFoundError({ entity: "Model", id: modelApiKey });

    const model = models[0];
    const tableName = `content_${model.api_key}`;
    const record = yield* selectById(tableName, recordId);
    if (!record) return yield* new NotFoundError({ entity: "Record", id: recordId });

    // Validate required fields before publishing
    const fieldRows = yield* sql.unsafe<FieldRow>(
      "SELECT * FROM fields WHERE model_id = ? ORDER BY position", [model.id]
    );
    const parsedFields = fieldRows.map(parseFieldValidators);
    // Get default locale for localized field validation
    const localeRows = yield* sql.unsafe<{ code: string }>(
      "SELECT code FROM locales ORDER BY position LIMIT 1", []
    );
    const defaultLocale = localeRows.length > 0 ? localeRows[0].code : null;
    const { valid, missingFields } = computeIsValid(record, parsedFields, defaultLocale);
    if (!valid) {
      return yield* new ValidationError({
        message: `Cannot publish: missing required fields: ${missingFields.join(", ")}`,
      });
    }

    const materialized = yield* materializeRecordStructuredTextFields({
      modelApiKey,
      record,
      fields: parsedFields,
    });

    // Build snapshot from current field values (exclude system columns)
    const snapshot: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(materialized)) {
      if (!key.startsWith("_") && key !== "id") {
        snapshot[key] = value;
      }
    }

    const now = new Date().toISOString();
    yield* sql.unsafe(
      `UPDATE "${tableName}" SET _status = 'published', _published_at = ?, _first_published_at = COALESCE(_first_published_at, ?), _published_snapshot = ?, _updated_at = ? WHERE id = ?`,
      [now, now, JSON.stringify(snapshot), now, recordId]
    );

    yield* fireHook("onPublish", { modelApiKey, recordId });
    return yield* selectById(tableName, recordId);
  });
}

export function unpublishRecord(modelApiKey: string, recordId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const models = yield* sql.unsafe<ModelRow>(
      "SELECT * FROM models WHERE api_key = ? AND is_block = 0",
      [modelApiKey]
    );
    if (models.length === 0) return yield* new NotFoundError({ entity: "Model", id: modelApiKey });

    const tableName = `content_${models[0].api_key}`;
    const record = yield* selectById(tableName, recordId);
    if (!record) return yield* new NotFoundError({ entity: "Record", id: recordId });

    const now = new Date().toISOString();
    yield* sql.unsafe(
      `UPDATE "${tableName}" SET _status = 'draft', _published_snapshot = NULL, _updated_at = ? WHERE id = ?`,
      [now, recordId]
    );

    yield* fireHook("onUnpublish", { modelApiKey, recordId });
    return yield* selectById(tableName, recordId);
  });
}
