import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { ulid } from "ulidx";
import { NotFoundError } from "../errors.js";
import { selectById } from "../schema-engine/sql-records.js";
import type { ModelRow, FieldRow, VersionRow } from "../db/row-types.js";
import { parseFieldValidators } from "../db/row-types.js";
import { materializeRecordStructuredTextFields } from "./structured-text-service.js";
import { fireHook } from "../hooks.js";

/**
 * Create a version snapshot for a record.
 * Called internally by publish and auto-republish flows.
 */
export function createVersion(modelApiKey: string, recordId: string, snapshot: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const maxRows = yield* sql.unsafe<{ max_v: number | null }>(
      `SELECT MAX(version_number) as max_v FROM record_versions WHERE model_api_key = ? AND record_id = ?`,
      [modelApiKey, recordId]
    );
    const nextVersion = (maxRows[0]?.max_v ?? 0) + 1;

    const id = ulid();
    const now = new Date().toISOString();
    yield* sql.unsafe(
      `INSERT INTO record_versions (id, model_api_key, record_id, version_number, snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, modelApiKey, recordId, nextVersion, snapshot, now]
    );

    return { id, model_api_key: modelApiKey, record_id: recordId, version_number: nextVersion, created_at: now };
  });
}

/**
 * List all versions for a record, newest first.
 */
export function listVersions(modelApiKey: string, recordId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<VersionRow>(
      `SELECT * FROM record_versions WHERE model_api_key = ? AND record_id = ? ORDER BY version_number DESC`,
      [modelApiKey, recordId]
    );
    return rows.map((r) => ({
      ...r,
      snapshot: JSON.parse(r.snapshot),
    }));
  });
}

/**
 * Get a single version by ID.
 */
export function getVersion(versionId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<VersionRow>(
      `SELECT * FROM record_versions WHERE id = ?`,
      [versionId]
    );
    if (rows.length === 0) return yield* new NotFoundError({ entity: "Version", id: versionId });
    const row = rows[0];
    return { ...row, snapshot: JSON.parse(row.snapshot) };
  });
}

/**
 * Restore a record to a previous version.
 * Versions the current state first (so restore is reversible), then writes
 * the version's field values back to the content table.
 */
export function restoreVersion(modelApiKey: string, recordId: string, versionId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Fetch the version to restore
    const versionRows = yield* sql.unsafe<VersionRow>(
      `SELECT * FROM record_versions WHERE id = ?`,
      [versionId]
    );
    if (versionRows.length === 0) return yield* new NotFoundError({ entity: "Version", id: versionId });
    const version = versionRows[0];

    // Fetch model
    const models = yield* sql.unsafe<ModelRow>(
      `SELECT * FROM models WHERE api_key = ?`,
      [modelApiKey]
    );
    if (models.length === 0) return yield* new NotFoundError({ entity: "Model", id: modelApiKey });
    const model = models[0];
    const tableName = `content_${model.api_key}`;

    // Fetch current record
    const current = yield* selectById(tableName, recordId);
    if (!current) return yield* new NotFoundError({ entity: "Record", id: recordId });

    // Version the current state before overwriting (so restore is reversible)
    const currentSnap: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(current)) {
      if (!key.startsWith("_") && key !== "id") currentSnap[key] = value;
    }
    yield* createVersion(modelApiKey, recordId, JSON.stringify(currentSnap));

    // Get model fields to know which fields still exist
    const fieldRows = yield* sql.unsafe<FieldRow>(
      `SELECT * FROM fields WHERE model_id = ? ORDER BY position`,
      [model.id]
    );
    const existingFieldKeys = new Set(fieldRows.map((f) => f.api_key));

    // Parse version snapshot and filter to fields that still exist
    const versionSnapshot: Record<string, unknown> = JSON.parse(version.snapshot);
    const updates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(versionSnapshot)) {
      if (existingFieldKeys.has(key)) {
        updates[key] = value;
      }
    }

    const now = new Date().toISOString();
    updates._updated_at = now;

    if (model.has_draft) {
      // Needs re-publish after restore
      updates._status = "draft";
    } else {
      // Auto-republish: rebuild snapshot
      const parsedFields = fieldRows.map(parseFieldValidators);

      // Build a temporary record with restored values for materialization
      const tempRecord: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(updates)) {
        tempRecord[key] = value;
      }

      const materialized = yield* materializeRecordStructuredTextFields({
        modelApiKey,
        record: tempRecord,
        fields: parsedFields,
      });

      const snap: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(materialized)) {
        if (!key.startsWith("_") && key !== "id") snap[key] = value;
      }

      updates._published_snapshot = JSON.stringify(snap);
      updates._published_at = now;
      updates._status = "published";
    }

    // Build SET clause
    const setCols = Object.keys(updates);
    const setClauses = setCols.map((c) => `"${c}" = ?`).join(", ");
    const values = setCols.map((c) => {
      const v = updates[c];
      if (v === undefined || v === null) return null;
      if (typeof v === "object") return JSON.stringify(v);
      return v;
    });
    values.push(recordId);

    yield* sql.unsafe(
      `UPDATE "${tableName}" SET ${setClauses} WHERE id = ?`,
      values
    );

    yield* fireHook("onRecordUpdate", { modelApiKey, recordId });
    return yield* selectById(tableName, recordId);
  });
}

/**
 * Delete all versions for a record. Called when the record is deleted.
 */
export function deleteVersionsForRecord(modelApiKey: string, recordId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(
      `DELETE FROM record_versions WHERE model_api_key = ? AND record_id = ?`,
      [modelApiKey, recordId]
    );
  });
}
