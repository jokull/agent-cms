import { Effect } from "effect";
import { isBoolean, isString, isObject, type DynamicRow } from "../dynamic/row-types.js";
import { SqlClient } from "effect/unstable/sql";

/**
 * Insert a record into a dynamic content table.
 */
export function insertRecord(
  tableName: string,
  record: DynamicRow
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const columns = Object.keys(record);
    const colList = columns.map((c) => `"${c}"`).join(", ");
    const placeholders = columns.map(() => "?").join(", ");
    const values = columns.map((c) => record[c]);

    yield* sql.unsafe(
      `INSERT INTO "${tableName}" (${colList}) VALUES (${placeholders})`,
      values.map(serializeValue)
    );
  });
}

/**
 * Select all records from a dynamic table.
 */
export function selectAll(tableName: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<DynamicRow>(
      `SELECT * FROM "${tableName}"`
    );
    return rows.map(deserializeRow);
  });
}

/**
 * Select a single record by ID.
 */
export function selectById(tableName: string, id: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<DynamicRow>(
      `SELECT * FROM "${tableName}" WHERE "id" = ?`,
      [id]
    );
    return rows.length > 0 ? deserializeRow(rows[0]) : null;
  });
}

/**
 * Select records matching a column value.
 */
export function selectWhere(tableName: string, column: string, value: unknown) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<DynamicRow>(
      `SELECT * FROM "${tableName}" WHERE "${column}" = ?`,
      [serializeValue(value)]
    );
    return rows.map(deserializeRow);
  });
}

/**
 * Update a record by ID.
 */
export function updateRecord(
  tableName: string,
  id: string,
  updates: DynamicRow
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const columns = Object.keys(updates);
    if (columns.length === 0) return;

    const setClauses = columns.map((c) => `"${c}" = ?`).join(", ");
    const values = [...columns.map((c) => serializeValue(updates[c])), id];

    yield* sql.unsafe(
      `UPDATE "${tableName}" SET ${setClauses} WHERE "id" = ?`,
      values
    );
  });
}

/**
 * Delete a record by ID.
 */
export function deleteRecord(tableName: string, id: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`DELETE FROM "${tableName}" WHERE "id" = ?`, [id]);
  });
}

/**
 * Count records in a table, optionally matching a condition.
 */
export function countRecords(tableName: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(
      `SELECT COUNT(*) as count FROM "${tableName}"`
    );
    return rows[0]?.count ?? 0;
  });
}

// --- Serialization helpers ---

/** Serialize a JS value for SQLite storage */
function serializeValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (isBoolean(value)) return value ? 1 : 0;
  if (isObject(value)) return JSON.stringify(value);
  return value;
}

/** Deserialize a row from SQLite — parse JSON columns */
export function deserializeRow(row: DynamicRow): DynamicRow {
  const result: DynamicRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (isString(value) && (value.startsWith("{") || value.startsWith("["))) {
      try {
        result[key] = JSON.parse(value);
      } catch {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}
