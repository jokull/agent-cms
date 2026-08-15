import { DateTime, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { NotFoundError, ValidationError } from "../errors.js";
import type { ModelRow } from "../db/row-types.js";
import type { RequestActor } from "../attribution.js";
import * as PublishService from "./publish-service.js";
import { selectById } from "../schema-engine/sql-records.js";

const getContentModel = Effect.fn("getContentModel")(function* (modelApiKey: string) {
  const sql = yield* SqlClient.SqlClient;
  const models = yield* sql.unsafe<ModelRow>(
    "SELECT * FROM models WHERE api_key = ? AND is_block = 0",
    [modelApiKey]
  );
  if (models.length === 0) {
    return yield* new NotFoundError({ entity: "Model", id: modelApiKey });
  }
  return models[0];
});

const validateScheduleAt = Effect.fn("validateScheduleAt")(function* (at: string | null) {
  if (at === null) return null;
  if (Number.isNaN(Date.parse(at))) {
    return yield* new ValidationError({ message: "Schedule time must be a valid ISO datetime string" });
  }
  return at;
});

export const schedulePublish = Effect.fn("schedulePublish")(function* (modelApiKey: string, recordId: string, at: string | null, actor?: RequestActor | null) {
  const model = yield* getContentModel(modelApiKey);
  const sql = yield* SqlClient.SqlClient;
  const tableName = `content_${model.api_key}`;
  const scheduleAt = yield* validateScheduleAt(at);

  const rows = yield* sql.unsafe<{ id: string }>(`SELECT id FROM "${tableName}" WHERE id = ?`, [recordId]);
  if (rows.length === 0) {
    return yield* new NotFoundError({ entity: "Record", id: recordId });
  }

  const now = new Date().toISOString();
  yield* sql.unsafe(
    `UPDATE "${tableName}" SET _scheduled_publish_at = ?, _updated_at = ?, _updated_by = ? WHERE id = ?`,
    [scheduleAt, now, actor?.label ?? null, recordId]
  );
  return yield* selectById(tableName, recordId);
});

export const scheduleUnpublish = Effect.fn("scheduleUnpublish")(function* (modelApiKey: string, recordId: string, at: string | null, actor?: RequestActor | null) {
  const model = yield* getContentModel(modelApiKey);
  const sql = yield* SqlClient.SqlClient;
  const tableName = `content_${model.api_key}`;
  const scheduleAt = yield* validateScheduleAt(at);

  const rows = yield* sql.unsafe<{ id: string }>(`SELECT id FROM "${tableName}" WHERE id = ?`, [recordId]);
  if (rows.length === 0) {
    return yield* new NotFoundError({ entity: "Record", id: recordId });
  }

  const now = new Date().toISOString();
  yield* sql.unsafe(
    `UPDATE "${tableName}" SET _scheduled_unpublish_at = ?, _updated_at = ?, _updated_by = ? WHERE id = ?`,
    [scheduleAt, now, actor?.label ?? null, recordId]
  );
  return yield* selectById(tableName, recordId);
});

export const clearSchedule = Effect.fn("clearSchedule")(function* (modelApiKey: string, recordId: string, actor?: RequestActor | null) {
  const model = yield* getContentModel(modelApiKey);
  const sql = yield* SqlClient.SqlClient;
  const tableName = `content_${model.api_key}`;

  const rows = yield* sql.unsafe<{ id: string }>(`SELECT id FROM "${tableName}" WHERE id = ?`, [recordId]);
  if (rows.length === 0) {
    return yield* new NotFoundError({ entity: "Record", id: recordId });
  }

  const now = new Date().toISOString();
  yield* sql.unsafe(
    `UPDATE "${tableName}" SET _scheduled_publish_at = NULL, _scheduled_unpublish_at = NULL, _updated_at = ?, _updated_by = ? WHERE id = ?`,
    [now, actor?.label ?? null, recordId]
  );
  return yield* selectById(tableName, recordId);
});

export const runScheduledTransitions = Effect.fn("runScheduledTransitions")(function* (now: DateTime.DateTime = DateTime.nowUnsafe(), actor: RequestActor = { type: "admin", label: "scheduler" }) {
  const sql = yield* SqlClient.SqlClient;
  const nowIso = DateTime.formatIso(now);
  const models = yield* sql.unsafe<Pick<ModelRow, "api_key">>(
    "SELECT api_key FROM models WHERE is_block = 0 ORDER BY created_at"
  );

  const published: Array<{ modelApiKey: string; recordId: string }> = [];
  const unpublished: Array<{ modelApiKey: string; recordId: string }> = [];

  for (const model of models) {
    const tableName = `content_${model.api_key}`;
    const duePublish = yield* sql.unsafe<{ id: string }>(
      `SELECT id FROM "${tableName}" WHERE _scheduled_publish_at IS NOT NULL AND _scheduled_publish_at <= ? ORDER BY _scheduled_publish_at ASC`,
      [nowIso]
    );
    for (const row of duePublish) {
      yield* PublishService.publishRecord(model.api_key, row.id, actor);
      published.push({ modelApiKey: model.api_key, recordId: row.id });
    }
  }

  for (const model of models) {
    const tableName = `content_${model.api_key}`;
    const dueUnpublish = yield* sql.unsafe<{ id: string }>(
      `SELECT id FROM "${tableName}" WHERE _scheduled_unpublish_at IS NOT NULL AND _scheduled_unpublish_at <= ? AND _status IN ('published', 'updated') ORDER BY _scheduled_unpublish_at ASC`,
      [nowIso]
    );
    for (const row of dueUnpublish) {
      yield* PublishService.unpublishRecord(model.api_key, row.id, actor);
      unpublished.push({ modelApiKey: model.api_key, recordId: row.id });
    }
  }

  return {
    now: nowIso,
    published,
    unpublished,
  };
});
