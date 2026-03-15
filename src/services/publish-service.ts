import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { NotFoundError } from "../errors.js";
import { selectById } from "../schema-engine/sql-records.js";
import type { ModelRow, ContentRow } from "../db/row-types.js";

export function publishRecord(modelApiKey: string, recordId: string) {
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

    // Build snapshot from current field values (exclude system columns)
    const snapshot: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
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

    return yield* selectById(tableName, recordId);
  });
}
