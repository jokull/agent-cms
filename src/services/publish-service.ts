import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { NotFoundError, ValidationError } from "../errors.js";
import { selectById } from "../schema-engine/sql-records.js";
import type { ModelRow, FieldRow } from "../db/row-types.js";
import { parseFieldValidators } from "../db/row-types.js";
import { computeIsValid, findUniqueConstraintViolations } from "../db/validators.js";
import { materializeRecordStructuredTextFields } from "./structured-text-service.js";
import { fireHook } from "../hooks.js";
import * as VersionService from "./version-service.js";
import { encodeJson } from "../json.js";
import type { RequestActor } from "../attribution.js";

export function publishRecord(modelApiKey: string, recordId: string, actor?: RequestActor | null) {
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
    // Get locales for validation
    const localeRows = yield* sql.unsafe<{ code: string }>(
      "SELECT code FROM locales ORDER BY position", []
    );
    const defaultLocale = localeRows.length > 0 ? localeRows[0].code : null;
    // When all_locales_required, validate all locales; otherwise just default
    const allLocales = model.all_locales_required && localeRows.length > 0
      ? localeRows.map((l) => l.code)
      : undefined;
    const { valid, missingFields } = computeIsValid(record, parsedFields, defaultLocale, allLocales);
    const uniqueViolations = yield* findUniqueConstraintViolations({
      tableName,
      record,
      fields: parsedFields,
      excludeId: recordId,
    });
    if (!valid || uniqueViolations.length > 0) {
      return yield* new ValidationError({
        message: `Cannot publish: invalid fields: ${[
          ...missingFields.map((field) => `${field} (required)`),
          ...uniqueViolations.map((field) => `${field} (unique)`),
        ].join(", ")}`,
      });
    }

    const materialized = yield* materializeRecordStructuredTextFields({
      modelApiKey,
      record,
      fields: parsedFields,
    });

    // Version the previous published state (skip on first publish)
    if (record._published_snapshot) {
      const prevSnapshot = typeof record._published_snapshot === "string"
        ? record._published_snapshot
        : encodeJson(record._published_snapshot);
      yield* VersionService.createVersion(modelApiKey, recordId, prevSnapshot, {
        action: "publish",
        actor,
      });
    }

    // Build snapshot from current field values (exclude system columns)
    const snapshot: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(materialized)) {
      if (!key.startsWith("_") && key !== "id") {
        snapshot[key] = value;
      }
    }

    const now = new Date().toISOString();
    yield* sql.unsafe(
      `UPDATE "${tableName}" SET _status = 'published', _published_at = ?, _first_published_at = COALESCE(_first_published_at, ?), _published_snapshot = ?, _updated_at = ?, _updated_by = ?, _published_by = ?, _scheduled_publish_at = NULL WHERE id = ?`,
      [now, now, encodeJson(snapshot), now, actor?.label ?? null, actor?.label ?? null, recordId]
    );

    yield* fireHook("onPublish", { modelApiKey, recordId });
    return yield* selectById(tableName, recordId);
  });
}

export function unpublishRecord(modelApiKey: string, recordId: string, actor?: RequestActor | null) {
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
      `UPDATE "${tableName}" SET _status = 'draft', _published_snapshot = NULL, _updated_at = ?, _updated_by = ?, _scheduled_unpublish_at = NULL WHERE id = ?`,
      [now, actor?.label ?? null, recordId]
    );

    yield* fireHook("onUnpublish", { modelApiKey, recordId });
    return yield* selectById(tableName, recordId);
  });
}
