import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { NotFoundError, ValidationError } from "../errors.js";
import type { ModelRow } from "../db/row-types.js";
import type { RequestActor } from "../attribution.js";
import * as PublishService from "./publish-service.js";
import { selectById } from "../schema-engine/sql-records.js";

function getContentModel(modelApiKey: string) {
  return Effect.gen(function* () {
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
}

function validateScheduleAt(at: string | null) {
  return Effect.gen(function* () {
    if (at === null) return null;
    if (Number.isNaN(Date.parse(at))) {
      return yield* new ValidationError({ message: "Schedule time must be a valid ISO datetime string" });
    }
    return at;
  });
}

export function schedulePublish(modelApiKey: string, recordId: string, at: string | null, actor?: RequestActor | null) {
  return Effect.gen(function* () {
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
}

export function scheduleUnpublish(modelApiKey: string, recordId: string, at: string | null, actor?: RequestActor | null) {
  return Effect.gen(function* () {
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
}

export function clearSchedule(modelApiKey: string, recordId: string, actor?: RequestActor | null) {
  return Effect.gen(function* () {
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
}

export function runScheduledTransitions(now = new Date(), actor: RequestActor = { type: "admin", label: "scheduler" }) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const nowIso = now.toISOString();
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
}
