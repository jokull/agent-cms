import { Effect } from "effect";
import { contentTableName } from "../dynamic/tables.js";
import { SqlClient } from "effect/unstable/sql";
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

/**
 * List indexes currently defined on a table (via sqlite_master / PRAGMA index_list).
 * Used to reconcile away stale indexes left behind by table/column renames — a renamed
 * table keeps its old-named indexes (SQLite indexes follow the renamed object but keep
 * their own name), so name-generation alone can't find them; we have to look at what's
 * actually on the table.
 */
function listIndexesOnTable(tableName: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<{ name: string }>(`PRAGMA index_list("${tableName}")`);
    return rows.map((r) => r.name);
  });
}

/**
 * Drop any index on `tableName` whose name looks like one of ours (matches `namePrefix`)
 * but isn't in the current `desiredNames` set. This is what mops up stale indexes left
 * under old names after a model/field rename (#62): the rename statement (ALTER TABLE
 * RENAME / RENAME COLUMN) carries the index along, but its name still embeds the old
 * api_key, so `CREATE INDEX IF NOT EXISTS` under the new name just creates a duplicate
 * instead of replacing it. It also mops up indexes left behind when a field's type
 * changes to one `shouldIndexField` no longer covers, since such a field's name simply
 * drops out of `desiredNames`.
 */
function dropStaleIndexes(tableName: string, namePrefix: string, desiredNames: ReadonlySet<string>) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const existingNames = yield* listIndexesOnTable(tableName);
    for (const name of existingNames) {
      if (name.startsWith(namePrefix) && !desiredNames.has(name)) {
        yield* sql.unsafe(`DROP INDEX "${name}"`);
      }
    }
  });
}

/**
 * Drop any index referencing `columnName` on `tableName`, keyed off the index's actual
 * columns (PRAGMA index_info) rather than the naming scheme. SQLite refuses `ALTER TABLE
 * ... DROP COLUMN` when an index still references the column (#64), and after a rename
 * the index name may not match the naming scheme at all (#62), so this has to inspect
 * the index definition rather than guess a name to drop.
 */
function dropIndexesReferencingColumn(tableName: string, columnName: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const indexNames = yield* listIndexesOnTable(tableName);
    for (const indexName of indexNames) {
      const columns = yield* sql.unsafe<{ name: string | null }>(`PRAGMA index_info("${indexName}")`);
      if (columns.some((c) => c.name === columnName)) {
        yield* sql.unsafe(`DROP INDEX "${indexName}"`);
      }
    }
  });
}

export function ensureBlockLookupIndex(blockApiKey: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tableName = `block_${blockApiKey}`;
    const indexName = blockLookupIndexName(blockApiKey);
    yield* dropStaleIndexes(tableName, "idx_block_", new Set([indexName]));
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
  return `idx_${contentTableName(modelApiKey)}_${fieldApiKey}`;
}

function contentCompositeIndexName(modelApiKey: string, leftFieldApiKey: string, rightFieldApiKey: string): string {
  return `idx_${contentTableName(modelApiKey)}_${leftFieldApiKey}_${rightFieldApiKey}`;
}

/** The full set of index names `ensureContentFieldIndexes` wants to exist for `fields`. */
function desiredContentIndexNames(modelApiKey: string, fields: FieldDef[]): Set<string> {
  const desired = new Set<string>();
  for (const field of fields) {
    if (shouldIndexField(field.fieldType)) {
      desired.add(contentFieldIndexName(modelApiKey, field.apiKey));
    }
  }
  const linkFields = fields.filter((field) => field.fieldType === "link");
  const temporalFields = fields.filter((field) => field.fieldType === "date" || field.fieldType === "date_time");
  for (const linkField of linkFields) {
    for (const temporalField of temporalFields) {
      desired.add(contentCompositeIndexName(modelApiKey, linkField.apiKey, temporalField.apiKey));
    }
  }
  return desired;
}

export function ensureContentFieldIndexes(modelApiKey: string, fields: FieldDef[]) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tableName = contentTableName(modelApiKey);

    // Reconcile before (re)creating: drops indexes left behind under old names by a
    // model/field rename (#62), and indexes for fields whose type changed to one
    // `shouldIndexField` no longer covers. See dropStaleIndexes for details.
    yield* dropStaleIndexes(tableName, "idx_content_", desiredContentIndexNames(modelApiKey, fields));

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
    const tableName = contentTableName(modelApiKey);
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
    const tableName = isBlock ? `block_${modelApiKey}` : contentTableName(modelApiKey);
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

    // Drop extra columns (that aren't system columns).
    // SQLite refuses DROP COLUMN while an index still references the column (#64), so
    // any index over it — by current name, stale renamed name, or composite index that
    // includes it (#62) — has to be dropped first. Found via PRAGMA index_info rather
    // than the naming scheme, since renamed leftovers won't match it.
    for (const col of existingCols) {
      if (!systemColNames.has(col.name) && !desiredFieldNames.has(col.name)) {
        yield* dropIndexesReferencingColumn(tableName, col.name);
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
