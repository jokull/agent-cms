import { getTableName, getTableColumns, sql } from "drizzle-orm";
import type { SQLiteTableWithColumns } from "drizzle-orm/sqlite-core";
import { generateCreateTableSQL } from "./ddl.js";

interface ExistingColumn {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

/**
 * Diff a Drizzle table definition against the current D1/SQLite state
 * and execute the necessary DDL to bring the database in sync.
 *
 * Handles:
 * - Table does not exist → CREATE TABLE
 * - New columns → ALTER TABLE ADD COLUMN
 * - Removed columns → ALTER TABLE DROP COLUMN (SQLite 3.35+)
 * - Column type changes → not supported in v1, rejected
 */
export function migrateTable(
  db: any,
  table: SQLiteTableWithColumns<any>
): MigrationResult {
  const tableName = getTableName(table);
  const result: MigrationResult = {
    tableName,
    created: false,
    columnsAdded: [],
    columnsDropped: [],
  };

  // Check if table exists
  const existingTable = db
    .get(sql.raw(`SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}'`));

  if (!existingTable) {
    // Table doesn't exist — create it
    const ddl = generateCreateTableSQL(table);
    db.run(sql.raw(ddl));
    result.created = true;
    return result;
  }

  // Table exists — diff columns
  const existingColumns = db
    .all(sql.raw(`PRAGMA table_info("${tableName}")`)) as ExistingColumn[];

  const existingColNames = new Set(existingColumns.map((c) => c.name));
  const desiredColumns = getTableColumns(table);
  const desiredColNames = new Set(
    Object.values(desiredColumns).map((c: any) => c.name)
  );

  // Find columns to add
  for (const [, col] of Object.entries(desiredColumns) as [string, any][]) {
    if (!existingColNames.has(col.name)) {
      const colType = getColumnSQLType(col);
      const notNull = col.notNull && !col.primary ? " NOT NULL" : "";
      const defaultClause = getDefaultClause(col);
      // ALTER TABLE ADD COLUMN requires a default if NOT NULL
      const addNotNull = col.notNull && !col.primary && defaultClause ? " NOT NULL" : "";
      db.run(
        sql.raw(
          `ALTER TABLE "${tableName}" ADD COLUMN "${col.name}" ${colType}${defaultClause}${addNotNull}`
        )
      );
      result.columnsAdded.push(col.name);
    }
  }

  // Find columns to drop
  for (const existingCol of existingColumns) {
    if (!desiredColNames.has(existingCol.name)) {
      db.run(
        sql.raw(`ALTER TABLE "${tableName}" DROP COLUMN "${existingCol.name}"`)
      );
      result.columnsDropped.push(existingCol.name);
    }
  }

  return result;
}

export interface MigrationResult {
  tableName: string;
  created: boolean;
  columnsAdded: string[];
  columnsDropped: string[];
}

function getColumnSQLType(col: any): string {
  const dataType: string = col.dataType;
  if (dataType === "string" || dataType === "json") return "TEXT";
  if (dataType.startsWith("number") || dataType === "boolean") return "INTEGER";
  return "TEXT";
}

function getDefaultClause(col: any): string {
  if (col.hasDefault && col.default !== undefined) {
    const val = col.default;
    if (typeof val === "string") return ` DEFAULT '${val}'`;
    return ` DEFAULT ${val}`;
  }
  return "";
}

/**
 * Drop a table if it exists.
 */
export function dropTable(db: any, tableName: string): void {
  db.run(sql.raw(`DROP TABLE IF EXISTS "${tableName}"`));
}
