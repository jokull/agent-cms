import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { NotFoundError, ValidationError } from "../errors.js";
import { selectById } from "../schema-engine/sql-records.js";

/**
 * Publish a record: copy current columns to _published_snapshot, set status.
 */
export function publishRecord(modelApiKey: string, recordId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Get model
    const models = yield* sql.unsafe<Record<string, any>>(
      "SELECT * FROM models WHERE api_key = ? AND is_block = 0",
      [modelApiKey]
    );
    if (models.length === 0) return yield* new NotFoundError({ entity: "Model", id: modelApiKey });
    const model = models[0];

    const tableName = `content_${model.api_key}`;
    const record = yield* selectById(tableName, recordId);
    if (!record) return yield* new NotFoundError({ entity: "Record", id: recordId });

    // Build snapshot from current record (excluding system columns)
    const snapshot: Record<string, any> = {};
    for (const [key, value] of Object.entries(record as Record<string, any>)) {
      if (!key.startsWith("_") && key !== "id") {
        snapshot[key] = value;
      }
    }

    const now = new Date().toISOString();
    yield* sql.unsafe(
      `UPDATE "${tableName}" SET _status = 'published', _published_at = ?, _first_published_at = COALESCE(_first_published_at, ?), _published_snapshot = ?, _updated_at = ? WHERE id = ?`,
      [now, now, JSON.stringify(snapshot), now, recordId]
    );

    return yield* selectById(tableName, recordId);
  });
}

/**
 * Unpublish a record: revert to draft, clear snapshot.
 */
export function unpublishRecord(modelApiKey: string, recordId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const models = yield* sql.unsafe<Record<string, any>>(
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

    return yield* selectById(tableName, recordId);
  });
}
