import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import type { FieldType } from "../types.js";
import { getFieldTypeDef } from "../field-types.js";

/** Map CMS field type to SQLite column type */
function fieldTypeToSQLite(fieldType: FieldType): string {
  return getFieldTypeDef(fieldType).sqliteType;
}

/** System columns for content tables */
const CONTENT_SYSTEM_COLUMNS = [
  `"id" TEXT PRIMARY KEY`,
  `"_status" TEXT NOT NULL DEFAULT 'draft'`,
  `"_published_at" TEXT`,
  `"_first_published_at" TEXT`,
  `"_published_snapshot" TEXT`,
  `"_created_at" TEXT NOT NULL`,
  `"_updated_at" TEXT NOT NULL`,
  `"_created_by" TEXT`,
  `"_updated_by" TEXT`,
  `"_published_by" TEXT`,
  `"_scheduled_publish_at" TEXT`,
  `"_scheduled_unpublish_at" TEXT`,
];

/** System columns for block tables */
const BLOCK_SYSTEM_COLUMNS = [
  `"id" TEXT PRIMARY KEY`,
  `"_root_record_id" TEXT NOT NULL`,
  `"_root_field_api_key" TEXT NOT NULL`,
  `"_parent_container_model_api_key" TEXT NOT NULL`,
  `"_parent_block_id" TEXT`,
  `"_parent_field_api_key" TEXT NOT NULL`,
  `"_depth" INTEGER NOT NULL DEFAULT 0`,
];

function blockLookupIndexName(blockApiKey: string): string {
  return `idx_block_${blockApiKey}_lookup`;
}

export function ensureBlockLookupIndex(blockApiKey: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tableName = `block_${blockApiKey}`;
    const indexName = blockLookupIndexName(blockApiKey);
    yield* sql.unsafe(
      `CREATE INDEX IF NOT EXISTS "${indexName}"
       ON "${tableName}" (
         "_root_record_id",
         "_root_field_api_key",
         "_parent_container_model_api_key",
         "_parent_field_api_key",
         "_parent_block_id"
       )`
    );
  });
}

interface FieldDef {
  apiKey: string;
  fieldType: FieldType;
}

function shouldIndexField(fieldType: FieldType): boolean {
  return fieldType === "slug"
    || fieldType === "link"
    || fieldType === "date"
    || fieldType === "date_time"
    || fieldType === "integer";
}

function contentFieldIndexName(modelApiKey: string, fieldApiKey: string): string {
  return `idx_content_${modelApiKey}_${fieldApiKey}`;
}

function contentCompositeIndexName(modelApiKey: string, leftFieldApiKey: string, rightFieldApiKey: string): string {
  return `idx_content_${modelApiKey}_${leftFieldApiKey}_${rightFieldApiKey}`;
}

export function ensureContentFieldIndexes(modelApiKey: string, fields: FieldDef[]) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tableName = `content_${modelApiKey}`;
    for (const field of fields) {
      if (!shouldIndexField(field.fieldType)) continue;
      yield* sql.unsafe(
        `CREATE INDEX IF NOT EXISTS "${contentFieldIndexName(modelApiKey, field.apiKey)}"
         ON "${tableName}" ("${field.apiKey}")`
      );
    }

    const linkFields = fields.filter((field) => field.fieldType === "link");
    const temporalFields = fields.filter((field) => field.fieldType === "date" || field.fieldType === "date_time");
    for (const linkField of linkFields) {
      for (const temporalField of temporalFields) {
        yield* sql.unsafe(
          `CREATE INDEX IF NOT EXISTS "${contentCompositeIndexName(modelApiKey, linkField.apiKey, temporalField.apiKey)}"
           ON "${tableName}" ("${linkField.apiKey}", "${temporalField.apiKey}" DESC)`
        );
      }
    }
  });
}

interface CreateContentTableOptions {
  sortable?: boolean;
  tree?: boolean;
}

/**
 * Create a content table for a model using @effect/sql.
 */
export function createContentTable(modelApiKey: string, fields: FieldDef[], options?: CreateContentTableOptions) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tableName = `content_${modelApiKey}`;
    const fieldCols = fields.map(
      (f) => `"${f.apiKey}" ${fieldTypeToSQLite(f.fieldType)}`
    );
    const systemCols = [...CONTENT_SYSTEM_COLUMNS];
    if (options?.sortable || options?.tree) {
      systemCols.push(`"_position" INTEGER NOT NULL DEFAULT 0`);
    }
    if (options?.tree) {
      systemCols.push(`"_parent_id" TEXT`);
    }
    const allCols = [...systemCols, ...fieldCols].join(", ");
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS "${tableName}" (${allCols})`);
    yield* ensureContentFieldIndexes(modelApiKey, fields);
    return tableName;
  });
}

/**
 * Create a block table for a block type using @effect/sql.
 */
export function createBlockTable(blockApiKey: string, fields: FieldDef[]) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tableName = `block_${blockApiKey}`;
    const fieldCols = fields.map(
      (f) => `"${f.apiKey}" ${fieldTypeToSQLite(f.fieldType)}`
    );
    const allCols = [...BLOCK_SYSTEM_COLUMNS, ...fieldCols].join(", ");
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS "${tableName}" (${allCols})`);
    yield* ensureBlockLookupIndex(blockApiKey);
    return tableName;
  });
}

/**
 * Add a column to a dynamic table.
 */
export function addColumn(tableName: string, apiKey: string, fieldType: FieldType) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const colType = fieldTypeToSQLite(fieldType);
    yield* sql.unsafe(`ALTER TABLE "${tableName}" ADD COLUMN "${apiKey}" ${colType}`);
  });
}

/**
 * Drop a column from a dynamic table.
 */
export function dropColumn(tableName: string, apiKey: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`ALTER TABLE "${tableName}" DROP COLUMN "${apiKey}"`);
  });
}

/**
 * Drop an entire table.
 */
export function dropTableSql(tableName: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`DROP TABLE IF EXISTS "${tableName}"`);
  });
}

/**
 * Check if a table exists.
 */
export function tableExists(tableName: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}'`
    );
    return rows.length > 0;
  });
}

/**
 * Get existing column names for a table.
 */
export function getTableColumns(tableName: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<{ name: string; type: string }>(
      `PRAGMA table_info("${tableName}")`
    );
    return rows.map((r) => ({ name: r.name, type: r.type }));
  });
}

/**
 * Migrate a dynamic table: create if missing, add/drop columns as needed.
 */
export function migrateContentTable(
  modelApiKey: string,
  isBlock: boolean,
  fields: FieldDef[],
  options?: CreateContentTableOptions
) {
  return Effect.gen(function* () {
    const tableName = isBlock ? `block_${modelApiKey}` : `content_${modelApiKey}`;
    const exists = yield* tableExists(tableName);

    if (!exists) {
      if (isBlock) {
        yield* createBlockTable(modelApiKey, fields);
      } else {
        yield* createContentTable(modelApiKey, fields, options);
      }
      const columnsAdded: string[] = [];
      const columnsDropped: string[] = [];
      return { created: true, columnsAdded, columnsDropped };
    }

    // Table exists — diff columns
    const existingCols = yield* getTableColumns(tableName);
    const existingColNames = new Set(existingCols.map((c) => c.name));

    const systemColNames = isBlock
      ? new Set(["id", "_root_record_id", "_root_field_api_key", "_parent_container_model_api_key", "_parent_block_id", "_parent_field_api_key", "_depth"])
      : new Set([
          "id",
          "_status",
          "_published_at",
          "_first_published_at",
          "_published_snapshot",
          "_created_at",
          "_updated_at",
          "_created_by",
          "_updated_by",
          "_published_by",
          "_scheduled_publish_at",
          "_scheduled_unpublish_at",
          "_position",
          "_parent_id",
        ]);

    const desiredFieldNames = new Set(fields.map((f) => f.apiKey));

    const columnsAdded: string[] = [];
    const columnsDropped: string[] = [];

    // Add missing columns
    for (const field of fields) {
      if (!existingColNames.has(field.apiKey)) {
        yield* addColumn(tableName, field.apiKey, field.fieldType);
        columnsAdded.push(field.apiKey);
      }
    }

    // Drop extra columns (that aren't system columns)
    for (const col of existingCols) {
      if (!systemColNames.has(col.name) && !desiredFieldNames.has(col.name)) {
        yield* dropColumn(tableName, col.name);
        columnsDropped.push(col.name);
      }
    }

    if (isBlock) {
      yield* ensureBlockLookupIndex(modelApiKey);
    } else {
      yield* ensureContentFieldIndexes(modelApiKey, fields);
    }

    return { created: false, columnsAdded, columnsDropped };
  });
}
