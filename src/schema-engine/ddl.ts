import { getTableName, getTableColumns, sql } from "drizzle-orm";
import type { SQLiteTableWithColumns } from "drizzle-orm/sqlite-core";

/**
 * Generate CREATE TABLE IF NOT EXISTS SQL from a Drizzle table definition.
 */
export function generateCreateTableSQL(table: SQLiteTableWithColumns<any>): string {
  const tableName = getTableName(table);
  const columns = getTableColumns(table);
  const colDefs: string[] = [];

  for (const [, col] of Object.entries(columns) as [string, any][]) {
    const parts: string[] = [`"${col.name}"`];

    const dataType: string = col.dataType;
    if (dataType === "string" || dataType === "json") {
      parts.push("TEXT");
    } else if (dataType.startsWith("number") || dataType === "boolean") {
      parts.push("INTEGER");
    } else {
      parts.push("TEXT");
    }

    if (col.primary) parts.push("PRIMARY KEY");
    if (col.notNull) parts.push("NOT NULL");
    if (col.hasDefault && col.default !== undefined) {
      const val = col.default;
      if (typeof val === "string") parts.push(`DEFAULT '${val}'`);
      else parts.push(`DEFAULT ${val}`);
    }

    colDefs.push(parts.join(" "));
  }

  return `CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs.join(", ")})`;
}

/**
 * Execute CREATE TABLE for a Drizzle table definition.
 * MUST use the Drizzle db instance (not raw sqlite) so the table is visible to Drizzle queries.
 */
export function createTableFromSchema(
  db: any, // BetterSQLite3Database or D1Database via Drizzle
  table: SQLiteTableWithColumns<any>
): void {
  const ddl = generateCreateTableSQL(table);
  db.run(sql.raw(ddl));
}
