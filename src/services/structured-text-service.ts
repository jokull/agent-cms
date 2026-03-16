import { Effect, Schema } from "effect";
import { SqlClient } from "@effect/sql";
import { validateDast, validateBlocksOnly, extractAllBlockIds } from "../dast/index.js";
import { ValidationError } from "../errors.js";
import { DastDocumentInput, StructuredTextWriteInput } from "../dast/schema.js";
import type { FieldRow, ParsedFieldRow } from "../db/row-types.js";
import { parseFieldValidators } from "../db/row-types.js";
import { getBlockWhitelist, getBlocksOnly } from "../db/validators.js";
import { getFieldTypeDef } from "../field-types.js";
import { isFieldType } from "../types.js";

type DynamicRow = Record<string, unknown>;

interface CompileContext {
  sql: SqlClient.SqlClient;
  rootRecordId: string;
  rootFieldApiKey: string;
  rootModelApiKey: string;
  seenBlockIds: Set<string>;
}

interface ContainerRef {
  parentContainerModelApiKey: string;
  parentBlockId: string | null;
  parentFieldApiKey: string;
  depth: number;
}

interface CompiledStructuredText {
  dast: DastDocumentInput;
  rowsByTable: Map<string, DynamicRow[]>;
}

interface BlockModelSchema {
  id: string;
  apiKey: string;
  fields: ParsedFieldRow[];
}

export interface StructuredTextEnvelope {
  value: DastDocumentInput;
  blocks: Record<string, DynamicRow>;
}

function mergeRowMaps(target: Map<string, DynamicRow[]>, source: Map<string, DynamicRow[]>) {
  for (const [tableName, rows] of source) {
    const existing = target.get(tableName);
    if (existing) existing.push(...rows);
    else target.set(tableName, [...rows]);
  }
}

function serializeValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function deserializeValue(value: unknown): unknown {
  if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function decodeStructuredTextInput(fieldApiKey: string, value: unknown) {
  return Schema.decodeUnknown(StructuredTextWriteInput)(value).pipe(
    Effect.mapError((e) => new ValidationError({
      message: `Invalid StructuredText for field '${fieldApiKey}': ${e.message}`,
      field: fieldApiKey,
    }))
  );
}

function getParsedFields(sql: SqlClient.SqlClient, modelId: string) {
  return Effect.gen(function* () {
    const fieldRows = yield* sql.unsafe<FieldRow>(
      "SELECT * FROM fields WHERE model_id = ? ORDER BY position",
      [modelId]
    );
    return fieldRows.map(parseFieldValidators);
  });
}

function getBlockModelSchema(sql: SqlClient.SqlClient, blockApiKey: string) {
  return Effect.gen(function* () {
    const rows = yield* sql.unsafe<{ id: string; api_key: string }>(
      "SELECT id, api_key FROM models WHERE api_key = ? AND is_block = 1",
      [blockApiKey]
    );
    if (rows.length === 0) {
      return yield* new ValidationError({
        message: `Block type '${blockApiKey}' does not exist`,
      });
    }
    const model = rows[0];
    const fields = yield* getParsedFields(sql, model.id);
    return { id: model.id, apiKey: model.api_key, fields } satisfies BlockModelSchema;
  });
}

function validateDastForField(fieldApiKey: string, value: unknown, blocksOnly: boolean) {
  return Effect.gen(function* () {
    const dastErrors = validateDast(value);
    if (dastErrors.length > 0) {
      return yield* new ValidationError({
        message: `Invalid DAST document: ${dastErrors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
        field: fieldApiKey,
      });
    }

    const dast = yield* Schema.decodeUnknown(DastDocumentInput)(value).pipe(
      Effect.mapError((e) => new ValidationError({
        message: `Invalid DAST structure: ${e.message}`,
        field: fieldApiKey,
      }))
    );

    if (blocksOnly) {
      const blocksOnlyErrors = validateBlocksOnly(value);
      if (blocksOnlyErrors.length > 0) {
        return yield* new ValidationError({
          message: `Blocks-only field '${fieldApiKey}': ${blocksOnlyErrors.map((e) => e.message).join("; ")}`,
          field: fieldApiKey,
        });
      }
    }

    return dast;
  });
}

function compileStructuredText(
  ctx: CompileContext,
  container: ContainerRef,
  params: {
    fieldApiKey: string;
    input: StructuredTextWriteInput;
    allowedBlockTypes: string[];
    blocksOnly: boolean;
  }
): Effect.Effect<CompiledStructuredText, unknown, never> {
  return Effect.gen(function* () {
    const { sql, seenBlockIds } = ctx;
    const { fieldApiKey, input, allowedBlockTypes, blocksOnly } = params;

    const dast = yield* validateDastForField(fieldApiKey, input.value, blocksOnly);
    const referencedBlockIds = extractAllBlockIds(dast);
    const providedBlockIds = Object.keys(input.blocks ?? {});

    for (const blockId of referencedBlockIds) {
      if (!input.blocks[blockId]) {
        return yield* new ValidationError({
          message: `DAST references block '${blockId}' but no block data provided for it`,
          field: fieldApiKey,
        });
      }
    }

    for (const blockId of providedBlockIds) {
      if (!referencedBlockIds.includes(blockId)) {
        return yield* new ValidationError({
          message: `StructuredText field '${fieldApiKey}' includes unreferenced block '${blockId}'`,
          field: fieldApiKey,
        });
      }
    }

    const rowsByTable = new Map<string, DynamicRow[]>();

    for (const blockId of referencedBlockIds) {
      if (seenBlockIds.has(blockId)) {
        return yield* new ValidationError({
          message: `StructuredText graph reuses block id '${blockId}' multiple times`,
          field: fieldApiKey,
        });
      }
      seenBlockIds.add(blockId);

      const rawBlock = input.blocks[blockId];
      if (typeof rawBlock !== "object" || rawBlock === null || Array.isArray(rawBlock)) {
        return yield* new ValidationError({
          message: `Block '${blockId}' must be an object`,
          field: fieldApiKey,
        });
      }
      const blockData = rawBlock as DynamicRow;
      if (typeof blockData._type !== "string" || blockData._type.length === 0) {
        return yield* new ValidationError({
          message: `Block '${blockId}' must have a _type property`,
          field: fieldApiKey,
        });
      }
      if (allowedBlockTypes.length > 0 && !allowedBlockTypes.includes(blockData._type)) {
        return yield* new ValidationError({
          message: `Block type '${blockData._type}' is not allowed in field '${fieldApiKey}'. Allowed: ${allowedBlockTypes.join(", ")}`,
          field: fieldApiKey,
        });
      }

      const blockModel = yield* getBlockModelSchema(sql, blockData._type);
      const row: DynamicRow = {
        id: blockId,
        _root_record_id: ctx.rootRecordId,
        _root_field_api_key: ctx.rootFieldApiKey,
        _parent_container_model_api_key: container.parentContainerModelApiKey,
        _parent_block_id: container.parentBlockId,
        _parent_field_api_key: container.parentFieldApiKey,
        _depth: container.depth,
      };

      const nestedRows = new Map<string, DynamicRow[]>();

      for (const field of blockModel.fields) {
        const value = blockData[field.api_key];
        if (value === undefined) continue;

        if (field.field_type === "structured_text") {
          if (value === null) {
            row[field.api_key] = null;
            continue;
          }

          const nestedInput = yield* decodeStructuredTextInput(field.api_key, value);
          const nestedCompiled = yield* compileStructuredText(
            ctx,
            {
              parentContainerModelApiKey: blockModel.apiKey,
              parentBlockId: blockId,
              parentFieldApiKey: field.api_key,
              depth: container.depth + 1,
            },
            {
              fieldApiKey: field.api_key,
              input: nestedInput,
              allowedBlockTypes: getBlockWhitelist(field.validators) ?? [],
              blocksOnly: getBlocksOnly(field.validators),
            }
          );
          row[field.api_key] = nestedCompiled.dast;
          mergeRowMaps(nestedRows, nestedCompiled.rowsByTable);
          continue;
        }

        if (isFieldType(field.field_type)) {
          const fieldDef = getFieldTypeDef(field.field_type);
          if (fieldDef.inputSchema) {
            yield* Schema.decodeUnknown(fieldDef.inputSchema)(value).pipe(
              Effect.mapError((e) => new ValidationError({
                message: `Invalid ${field.field_type} for block field '${field.api_key}': ${e.message}`,
                field: field.api_key,
              }))
            );
          }
        }

        row[field.api_key] = value;
      }

      const tableName = `block_${blockModel.apiKey}`;
      const rows = rowsByTable.get(tableName);
      if (rows) rows.push(row);
      else rowsByTable.set(tableName, [row]);
      mergeRowMaps(rowsByTable, nestedRows);
    }

    return { dast, rowsByTable } satisfies CompiledStructuredText;
  });
}

function insertCompiledRows(sql: SqlClient.SqlClient, rowsByTable: Map<string, DynamicRow[]>) {
  return Effect.gen(function* () {
    for (const [tableName, rows] of rowsByTable) {
      for (const row of rows) {
        const columns = Object.keys(row);
        const colList = columns.map((c) => `"${c}"`).join(", ");
        const placeholders = columns.map(() => "?").join(", ");
        const values = columns.map((c) => serializeValue(row[c]));
        yield* sql.unsafe(
          `INSERT INTO "${tableName}" (${colList}) VALUES (${placeholders})`,
          values
        );
      }
    }
  });
}

function fetchBlockModels(sql: SqlClient.SqlClient) {
  return sql.unsafe<{ api_key: string }>(
    "SELECT api_key FROM models WHERE is_block = 1 ORDER BY api_key"
  );
}

function collectDescendantBlockIds(sql: SqlClient.SqlClient, startIds: string[]) {
  return Effect.gen(function* () {
    const blockModels = yield* fetchBlockModels(sql);
    const allIds = new Set(startIds);
    let frontier = [...startIds];

    while (frontier.length > 0) {
      const next = new Set<string>();
      const placeholders = frontier.map(() => "?").join(", ");
      for (const model of blockModels) {
        const rows = yield* sql.unsafe<{ id: string }>(
          `SELECT id FROM "block_${model.api_key}" WHERE _parent_block_id IN (${placeholders})`,
          frontier
        );
        for (const row of rows) {
          if (!allIds.has(row.id)) {
            allIds.add(row.id);
            next.add(row.id);
          }
        }
      }
      frontier = [...next];
    }

    return allIds;
  });
}

export function writeStructuredText(params: {
  rootModelApiKey: string;
  fieldApiKey: string;
  rootRecordId: string;
  value: unknown;
  blocks?: Record<string, unknown>;
  allowedBlockTypes?: string[];
  blocksOnly?: boolean;
}): Effect.Effect<DastDocumentInput, unknown, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const input = yield* decodeStructuredTextInput(params.fieldApiKey, {
      value: params.value,
      blocks: params.blocks ?? {},
    });
    const compiled = yield* compileStructuredText(
      {
        sql,
        rootRecordId: params.rootRecordId,
        rootFieldApiKey: params.fieldApiKey,
        rootModelApiKey: params.rootModelApiKey,
        seenBlockIds: new Set<string>(),
      },
      {
        parentContainerModelApiKey: params.rootModelApiKey,
        parentBlockId: null,
        parentFieldApiKey: params.fieldApiKey,
        depth: 0,
      },
      {
        fieldApiKey: params.fieldApiKey,
        input,
        allowedBlockTypes: params.allowedBlockTypes ?? [],
        blocksOnly: params.blocksOnly ?? false,
      }
    );
    yield* insertCompiledRows(sql, compiled.rowsByTable);
    return compiled.dast;
  });
}

export function deleteBlocksForField(params: {
  rootRecordId: string;
  fieldApiKey: string;
}): Effect.Effect<void, unknown, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const blockModels = yield* fetchBlockModels(sql);
    for (const model of blockModels) {
      yield* sql.unsafe(
        `DELETE FROM "block_${model.api_key}" WHERE _root_record_id = ? AND _root_field_api_key = ?`,
        [params.rootRecordId, params.fieldApiKey]
      );
    }
  });
}

export function deleteBlockSubtrees(params: {
  blockIds: string[];
}): Effect.Effect<void, unknown, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    if (params.blockIds.length === 0) return;
    const sql = yield* SqlClient.SqlClient;
    const blockModels = yield* fetchBlockModels(sql);
    const allIds = yield* collectDescendantBlockIds(sql, params.blockIds);
    const ids = [...allIds];
    const placeholders = ids.map(() => "?").join(", ");
    for (const model of blockModels) {
      yield* sql.unsafe(
        `DELETE FROM "block_${model.api_key}" WHERE id IN (${placeholders})`,
        ids
      );
    }
  });
}

function materializeBlockPayload(
  sql: SqlClient.SqlClient,
  blockApiKey: string,
  row: DynamicRow,
): Effect.Effect<DynamicRow, unknown, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const blockModel = yield* getBlockModelSchema(sql, blockApiKey);
    const payload: DynamicRow = { _type: blockApiKey };
    for (const field of blockModel.fields) {
      const rawValue = deserializeValue(row[field.api_key]);
      if (rawValue === undefined) continue;
      if (field.field_type === "structured_text" && rawValue !== null && rawValue !== undefined) {
        payload[field.api_key] = yield* materializeStructuredTextValue({
          parentContainerModelApiKey: blockApiKey,
          parentBlockId: String(row.id),
          parentFieldApiKey: field.api_key,
          rootRecordId: String(row._root_record_id),
          rootFieldApiKey: String(row._root_field_api_key),
          rawValue,
        });
      } else {
        payload[field.api_key] = rawValue;
      }
    }
    return payload;
  });
}

export function materializeStructuredTextValue(params: {
  parentContainerModelApiKey: string;
  parentBlockId: string | null;
  parentFieldApiKey: string;
  rootRecordId: string;
  rootFieldApiKey: string;
  rawValue: unknown;
}): Effect.Effect<StructuredTextEnvelope | null, unknown, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    let dast = params.rawValue;
    if (typeof dast === "string") {
      try {
        dast = JSON.parse(dast);
      } catch {
        return null;
      }
    }
    if (!dast || typeof dast !== "object") return null;

    const blockModels = yield* fetchBlockModels(sql);
    const blocks: Record<string, DynamicRow> = {};

    for (const model of blockModels) {
      const rows = yield* sql.unsafe<DynamicRow>(
        `SELECT * FROM "block_${model.api_key}"
         WHERE _root_record_id = ?
           AND _root_field_api_key = ?
           AND _parent_container_model_api_key = ?
           AND _parent_field_api_key = ?
           AND ${params.parentBlockId === null ? "_parent_block_id IS NULL" : "_parent_block_id = ?"}`,
        params.parentBlockId === null
          ? [params.rootRecordId, params.rootFieldApiKey, params.parentContainerModelApiKey, params.parentFieldApiKey]
          : [params.rootRecordId, params.rootFieldApiKey, params.parentContainerModelApiKey, params.parentFieldApiKey, params.parentBlockId]
      );
      for (const row of rows) {
        blocks[String(row.id)] = yield* materializeBlockPayload(sql, model.api_key, row);
      }
    }

    return { value: dast as DastDocumentInput, blocks } satisfies StructuredTextEnvelope;
  });
}

export function materializeRecordStructuredTextFields(params: {
  modelApiKey: string;
  record: DynamicRow;
  fields: ParsedFieldRow[];
}): Effect.Effect<DynamicRow, unknown, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const materialized: DynamicRow = { ...params.record };
    for (const field of params.fields) {
      if (field.field_type !== "structured_text") continue;
      const rawValue = params.record[field.api_key];
      if (rawValue === null || rawValue === undefined) continue;
      const envelope = yield* materializeStructuredTextValue({
        parentContainerModelApiKey: params.modelApiKey,
        parentBlockId: null,
        parentFieldApiKey: field.api_key,
        rootRecordId: String(params.record.id),
        rootFieldApiKey: field.api_key,
        rawValue,
      });
      materialized[field.api_key] = envelope;
    }
    return materialized;
  });
}
