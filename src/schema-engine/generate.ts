import { sqliteTable, text, integer, foreignKey } from "drizzle-orm/sqlite-core";
import type { SQLiteTableWithColumns } from "drizzle-orm/sqlite-core";
import type { FieldType } from "../types.js";
import { mapFieldToColumn } from "./field-mapper.js";

/** Row shape from the `models` system table */
export interface ModelRow {
  id: string;
  name: string;
  apiKey: string;
  isBlock: boolean;
  singleton: boolean;
  sortable: boolean;
  tree: boolean;
  hasDraft: boolean;
}

/** Row shape from the `fields` system table */
export interface FieldRow {
  id: string;
  modelId: string;
  label: string;
  apiKey: string;
  fieldType: string;
  position: number;
  localized: boolean;
  validators: Record<string, unknown>;
}

/** The result of generating a dynamic schema from system table metadata */
export interface GeneratedSchema {
  /** Map from model api_key to Drizzle table definition */
  tables: Map<string, SQLiteTableWithColumns<any>>;
  /** Map from model api_key to the model metadata */
  models: Map<string, ModelRow>;
  /** Map from model api_key to its field definitions */
  fields: Map<string, FieldRow[]>;
}

/**
 * Generate Drizzle table definitions from system table metadata.
 *
 * For each model:
 * - Content models get table `content_{api_key}` with system columns + field columns
 * - Block models get table `block_{api_key}` with ownership columns + field columns
 */
export function generateSchema(
  modelRows: ModelRow[],
  fieldRows: FieldRow[]
): GeneratedSchema {
  const result: GeneratedSchema = {
    tables: new Map(),
    models: new Map(),
    fields: new Map(),
  };

  // Index fields by model ID
  const fieldsByModelId = new Map<string, FieldRow[]>();
  for (const field of fieldRows) {
    const existing = fieldsByModelId.get(field.modelId) ?? [];
    existing.push(field);
    fieldsByModelId.set(field.modelId, existing);
  }

  // Sort fields by position
  for (const [, fields] of fieldsByModelId) {
    fields.sort((a, b) => a.position - b.position);
  }

  for (const model of modelRows) {
    const modelFields = fieldsByModelId.get(model.id) ?? [];
    result.models.set(model.apiKey, model);
    result.fields.set(model.apiKey, modelFields);

    const table = model.isBlock
      ? generateBlockTable(model, modelFields)
      : generateContentTable(model, modelFields);

    result.tables.set(model.apiKey, table);
  }

  return result;
}

function generateContentTable(
  model: ModelRow,
  fields: FieldRow[]
): SQLiteTableWithColumns<any> {
  const tableName = `content_${model.apiKey}`;

  // Build columns object: system columns + dynamic field columns
  const columns: Record<string, any> = {
    id: text("id").primaryKey(),
    _status: text("_status").notNull().default("draft"),
    _publishedAt: text("_published_at"),
    _firstPublishedAt: text("_first_published_at"),
    _publishedSnapshot: text("_published_snapshot", { mode: "json" }),
    _createdAt: text("_created_at").notNull(),
    _updatedAt: text("_updated_at").notNull(),
  };

  for (const field of fields) {
    columns[field.apiKey] = mapFieldToColumn(
      field.fieldType as FieldType,
      field.apiKey
    );
  }

  return sqliteTable(tableName, columns);
}

function generateBlockTable(
  model: ModelRow,
  fields: FieldRow[]
): SQLiteTableWithColumns<any> {
  const tableName = `block_${model.apiKey}`;

  const columns: Record<string, any> = {
    id: text("id").primaryKey(),
    _rootRecordId: text("_root_record_id").notNull(),
    _rootFieldApiKey: text("_root_field_api_key").notNull(),
  };

  for (const field of fields) {
    columns[field.apiKey] = mapFieldToColumn(
      field.fieldType as FieldType,
      field.apiKey
    );
  }

  return sqliteTable(tableName, columns);
}
