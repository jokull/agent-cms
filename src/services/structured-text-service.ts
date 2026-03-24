import { Effect, ParseResult, Schema } from "effect";
import { SqlClient, SqlError } from "@effect/sql";
import { validateBlocksOnly, extractAllBlockIds } from "../dast/index.js";
import { ValidationError } from "../errors.js";
import { DastDocumentInput, DastDocumentSchema, StructuredTextWriteInput } from "../dast/schema.js";
import { runBatchedQueries, type BatchedQuery } from "../db/run-batched-queries.js";
import type { FieldRow, ParsedFieldRow } from "../db/row-types.js";
import { parseFieldValidators } from "../db/row-types.js";
import { getBlockWhitelist, getBlocksOnly } from "../db/validators.js";
import { getFieldTypeDef } from "../field-types.js";
import { isFieldType } from "../types.js";
import { decodeJsonIfString, decodeJsonStringOr, encodeJson } from "../json.js";

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
  dast: { readonly schema: "dast"; readonly document: { readonly type: "root"; readonly children: ReadonlyArray<unknown> } };
  rowsByTable: Map<string, DynamicRow[]>;
}

interface BlockModelSchema {
  id: string;
  apiKey: string;
  fields: ParsedFieldRow[];
  structuredTextAllowedBlockApiKeysByField: Map<string, readonly string[]>;
}

interface MaterializeContext {
  blockModels?: ReadonlyArray<{ api_key: string }>;
  candidateBlockModels: Map<string, ReadonlyArray<{ api_key: string }>>;
  blockModelSchemas: Map<string, BlockModelSchema>;
}

export interface StructuredTextEnvelope {
  value: DastDocumentInput;
  blocks: Record<string, DynamicRow>;
}

export function getStructuredTextStorageKey(fieldApiKey: string, localeCode?: string | null) {
  return localeCode ? `${fieldApiKey}:${localeCode}` : fieldApiKey;
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
  if (typeof value === "object") return encodeJson(value);
  return value;
}

function deserializeValue(value: unknown): unknown {
  if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
    return decodeJsonStringOr(value, value);
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
    const structuredTextAllowedBlockApiKeysByField = new Map<string, readonly string[]>();
    for (const field of fields) {
      if (field.field_type !== "structured_text") continue;
      structuredTextAllowedBlockApiKeysByField.set(field.api_key, getBlockWhitelist(field.validators) ?? []);
    }
    return {
      id: model.id,
      apiKey: model.api_key,
      fields,
      structuredTextAllowedBlockApiKeysByField,
    } satisfies BlockModelSchema;
  });
}

function getBlockModelSchemaCached(ctx: MaterializeContext, sql: SqlClient.SqlClient, blockApiKey: string) {
  return Effect.gen(function* () {
    const cached = ctx.blockModelSchemas.get(blockApiKey);
    if (cached) return cached;
    const schema = yield* getBlockModelSchema(sql, blockApiKey);
    ctx.blockModelSchemas.set(blockApiKey, schema);
    return schema;
  });
}

function fetchBlockModelsCached(ctx: MaterializeContext, sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    if (ctx.blockModels) return ctx.blockModels;
    const blockModels = yield* fetchBlockModels(sql);
    ctx.blockModels = blockModels;
    return blockModels;
  });
}

function getCandidateBlockModelsCached(
  ctx: MaterializeContext,
  blockModels: ReadonlyArray<{ api_key: string }>,
  allowedBlockApiKeys?: readonly string[]
) {
  const cacheKey = allowedBlockApiKeys && allowedBlockApiKeys.length > 0
    ? allowedBlockApiKeys.join(",")
    : "*";
  const cached = ctx.candidateBlockModels.get(cacheKey);
  if (cached) return cached;

  const candidateBlockModels = allowedBlockApiKeys && allowedBlockApiKeys.length > 0
    ? blockModels.filter((model) => allowedBlockApiKeys.includes(model.api_key))
    : blockModels;
  ctx.candidateBlockModels.set(cacheKey, candidateBlockModels);
  return candidateBlockModels;
}

function runHotBlockQueries<T extends object>(queries: ReadonlyArray<BatchedQuery>) {
  return runBatchedQueries<T>(queries, { phase: "st_frontier" });
}

function formatDastParseErrors(error: ParseResult.ParseError): string {
  const formatted = ParseResult.ArrayFormatter.formatErrorSync(error);
  return formatted.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}

function validateDastForField(fieldApiKey: string, value: unknown, blocksOnly: boolean) {
  return Effect.gen(function* () {
    const dast = yield* Schema.decodeUnknown(DastDocumentSchema)(value).pipe(
      Effect.mapError((e) => new ValidationError({
        message: `Invalid DAST document: ${formatDastParseErrors(e)}`,
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
): Effect.Effect<CompiledStructuredText, ValidationError | SqlError.SqlError> {
  return Effect.gen(function* () {
    const { sql, seenBlockIds } = ctx;
    const { fieldApiKey, input, allowedBlockTypes, blocksOnly } = params;

    const dast = yield* validateDastForField(fieldApiKey, input.value, blocksOnly);
    const referencedBlockIds = extractAllBlockIds(dast);
    const providedBlockIds = Object.keys(input.blocks);

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
        if (value === null) {
          row[field.api_key] = null;
          continue;
        }

        if (field.field_type === "structured_text") {

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
  rootFieldStorageKey?: string;
  rootRecordId: string;
  value: unknown;
  blocks?: Record<string, unknown>;
  allowedBlockTypes?: string[];
  blocksOnly?: boolean;
}) {
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
        rootFieldApiKey: params.rootFieldStorageKey ?? params.fieldApiKey,
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
  includeLocalizedVariants?: boolean;
}): Effect.Effect<void, unknown, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const blockModels = yield* fetchBlockModels(sql);
    for (const model of blockModels) {
      if (params.includeLocalizedVariants) {
        yield* sql.unsafe(
          `DELETE FROM "block_${model.api_key}"
           WHERE _root_record_id = ?
             AND (_root_field_api_key = ? OR _root_field_api_key LIKE ?)`,
          [params.rootRecordId, params.fieldApiKey, `${params.fieldApiKey}:%`]
        );
      } else {
        yield* sql.unsafe(
          `DELETE FROM "block_${model.api_key}" WHERE _root_record_id = ? AND _root_field_api_key = ?`,
          [params.rootRecordId, params.fieldApiKey]
        );
      }
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

interface MaterializeStructuredTextParams {
  materializeContext?: MaterializeContext;
  allowedBlockApiKeys?: readonly string[];
  selectedNestedFieldsPlan?: StructuredTextMaterializePlan;
  parentContainerModelApiKey: string;
  parentBlockId: string | null;
  parentFieldApiKey: string;
  rootRecordId: string;
  rootFieldApiKey: string;
  rawValue: unknown;
}

export interface StructuredTextMaterializePlan {
  fieldsByBlockApiKey: ReadonlyMap<string, ReadonlyMap<string, StructuredTextMaterializePlan>>;
}

interface MaterializeStructuredTextRequest extends MaterializeStructuredTextParams {
  requestKey: string;
}

interface ParsedMaterializeStructuredTextRequest {
  requestKey: string;
  params: MaterializeStructuredTextParams;
  doc: DastDocumentInput;
  blockIds: readonly string[];
  blockIdSet: ReadonlySet<string>;
}

function parseMaterializeStructuredTextRequest(request: MaterializeStructuredTextRequest) {
  const dast = decodeJsonIfString(request.rawValue);
  if (!dast || typeof dast !== "object") return null;
  if (!("document" in dast) || typeof dast.document !== "object" || dast.document === null || !("children" in dast.document)) {
    return null;
  }

  const doc = dast as DastDocumentInput;
  const blockIds = extractAllBlockIds(doc);
  return {
    requestKey: request.requestKey,
    params: request,
    doc,
    blockIds,
    blockIdSet: new Set(blockIds),
  } satisfies ParsedMaterializeStructuredTextRequest;
}

function getMaterializeBatchGroupKey(params: MaterializeStructuredTextParams) {
  const allowed = params.allowedBlockApiKeys?.join(",") ?? "*";
  const planKey = serializeMaterializePlan(params.selectedNestedFieldsPlan);
  return [
    params.parentContainerModelApiKey,
    params.parentFieldApiKey,
    params.rootFieldApiKey,
    params.parentBlockId === null ? "root" : "nested",
    allowed,
    planKey,
  ].join(":");
}

function serializeMaterializePlan(plan: StructuredTextMaterializePlan | undefined): string {
  if (!plan) return "*";
  const blockEntries = [...plan.fieldsByBlockApiKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([blockApiKey, fieldPlans]) => [
      blockApiKey,
      [...fieldPlans.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([fieldApiKey, nestedPlan]) => `${fieldApiKey}(${serializeMaterializePlan(nestedPlan)})`)
        .join(","),
    ]);
  return blockEntries.map(([blockApiKey, nested]) => `${blockApiKey}[${nested}]`).join("|");
}

function buildMaterializeQueries(params: {
  blockModels: readonly BlockModelSchema[];
  rootRecordIds: readonly string[];
  rootFieldApiKey: string;
  parentContainerModelApiKey: string;
  parentFieldApiKey: string;
  parentBlockIds: readonly string[];
  blockIds: readonly string[];
}) {
  const rootRecordPlaceholders = params.rootRecordIds.map(() => "?").join(", ");
  const blockPlaceholders = params.blockIds.map(() => "?").join(", ");
  const parentBlockPlaceholders = params.parentBlockIds.map(() => "?").join(", ");
  return params.blockModels.map((model) => {
    const payloadParts = model.fields.map((field) => `'${field.api_key}', "${field.api_key}"`).join(", ");
    return {
      sql: `SELECT id, _root_record_id, _root_field_api_key, _parent_block_id, '${model.apiKey}' AS __block_api_key, json_object(${payloadParts}) AS __payload
       FROM "block_${model.apiKey}"
       WHERE _root_record_id IN (${rootRecordPlaceholders})
         AND _root_field_api_key = ?
         AND _parent_container_model_api_key = ?
         AND _parent_field_api_key = ?
         AND ${params.parentBlockIds.length === 0 ? "_parent_block_id IS NULL" : `_parent_block_id IN (${parentBlockPlaceholders})`}
         AND id IN (${blockPlaceholders})`,
      params: [
      ...params.rootRecordIds,
      params.rootFieldApiKey,
      params.parentContainerModelApiKey,
      params.parentFieldApiKey,
      ...(params.parentBlockIds.length === 0 ? [] : params.parentBlockIds),
      ...params.blockIds,
      ],
    };
  });
}

export function materializeStructuredTextValues(params: {
  materializeContext?: MaterializeContext;
  requests: readonly MaterializeStructuredTextRequest[];
}): Effect.Effect<Map<string, StructuredTextEnvelope | null>, unknown, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const materializeContext = params.materializeContext ?? {
      blockModelSchemas: new Map<string, BlockModelSchema>(),
      candidateBlockModels: new Map<string, ReadonlyArray<{ api_key: string }>>(),
    };
    const results = new Map<string, StructuredTextEnvelope | null>();
    const parsedRequests: ParsedMaterializeStructuredTextRequest[] = [];

    for (const request of params.requests) {
      const parsed = parseMaterializeStructuredTextRequest(request);
      if (!parsed) {
        results.set(request.requestKey, null);
        continue;
      }
      if (parsed.blockIds.length === 0) {
        results.set(parsed.requestKey, { value: parsed.doc, blocks: {} });
        continue;
      }
      parsedRequests.push(parsed);
    }

    if (parsedRequests.length === 0) {
      return results;
    }

    const blockModels = yield* fetchBlockModelsCached(materializeContext, sql);
    const requestsByGroup = new Map<string, ParsedMaterializeStructuredTextRequest[]>();

    for (const request of parsedRequests) {
      const groupKey = getMaterializeBatchGroupKey(request.params);
      const group = requestsByGroup.get(groupKey);
      if (group) group.push(request);
      else requestsByGroup.set(groupKey, [request]);
      results.set(request.requestKey, { value: request.doc, blocks: {} });
    }

    const nestedRequests: MaterializeStructuredTextRequest[] = [];
    const nestedAssignments: Array<{ requestKey: string; target: DynamicRow; fieldApiKey: string }> = [];

    for (const requests of requestsByGroup.values()) {
      const sample = requests[0];
      if (!sample) continue;

      const requestByParentKey = new Map<string, ParsedMaterializeStructuredTextRequest>();
      const requestBlockIds = new Map<string, ReadonlySet<string>>();
      const allBlockIds = new Set<string>();
      const rootRecordIds = new Set<string>();
      const parentBlockIds = new Set<string>();

      for (const request of requests) {
        const parentKey = `${request.params.rootRecordId}:${request.params.parentBlockId ?? "root"}`;
        requestByParentKey.set(parentKey, request);
        requestBlockIds.set(request.requestKey, request.blockIdSet);
        rootRecordIds.add(request.params.rootRecordId);
        if (request.params.parentBlockId !== null) {
          parentBlockIds.add(request.params.parentBlockId);
        }
        for (const blockId of request.blockIds) {
          allBlockIds.add(blockId);
        }
      }

      const candidateBlockModels = getCandidateBlockModelsCached(
        materializeContext,
        blockModels,
        sample.params.allowedBlockApiKeys
      );
      const blockModelSchemas = yield* Effect.all(
        candidateBlockModels.map((model) => getBlockModelSchemaCached(materializeContext, sql, model.api_key)),
        { concurrency: "unbounded" },
      );
      const blockModelByApiKey = new Map(blockModelSchemas.map((model) => [model.apiKey, model] as const));
      const rootRecordIdList = [...rootRecordIds];
      const blockIds = [...allBlockIds];
      const parentBlockIdList = [...parentBlockIds];
      const rowGroups = yield* runHotBlockQueries<DynamicRow>(buildMaterializeQueries({
        blockModels: blockModelSchemas,
        rootRecordIds: rootRecordIdList,
        rootFieldApiKey: sample.params.rootFieldApiKey,
        parentContainerModelApiKey: sample.params.parentContainerModelApiKey,
        parentFieldApiKey: sample.params.parentFieldApiKey,
        parentBlockIds: parentBlockIdList,
        blockIds,
      }));
      const rows = rowGroups.flat();
      if (rows.length === 0) continue;

      for (const row of rows) {
        const rootRecordId = String(row._root_record_id);
        const parentBlockId = typeof row._parent_block_id === "string" ? row._parent_block_id : "root";
        const request = requestByParentKey.get(`${rootRecordId}:${parentBlockId}`);
        if (!request) continue;

        const allowedBlockIds = requestBlockIds.get(request.requestKey);
        const rowId = String(row.id);
        if (!allowedBlockIds?.has(rowId)) continue;

        const blockApiKey = typeof row.__block_api_key === "string" ? row.__block_api_key : null;
        if (!blockApiKey) continue;
        const blockModel = blockModelByApiKey.get(blockApiKey);
        if (!blockModel) continue;
        const rawPayload = decodeJsonIfString(row.__payload);
        if (typeof rawPayload !== "object" || rawPayload === null || Array.isArray(rawPayload)) continue;

        const payload: DynamicRow = { _type: blockApiKey };
        const selectedFieldPlans = request.params.selectedNestedFieldsPlan?.fieldsByBlockApiKey.get(blockApiKey);
        for (const field of blockModel.fields) {
          const rawValue = deserializeValue(Reflect.get(rawPayload, field.api_key));
          if (rawValue === undefined) continue;
          if (field.field_type === "structured_text" && rawValue !== null) {
            const nestedPlan = selectedFieldPlans?.get(field.api_key);
            if (request.params.selectedNestedFieldsPlan && !nestedPlan) {
              continue;
            }
            const requestKey = `nested:${nestedAssignments.length}`;
            nestedRequests.push({
              requestKey,
              materializeContext,
              allowedBlockApiKeys: blockModel.structuredTextAllowedBlockApiKeysByField.get(field.api_key) ?? [],
              selectedNestedFieldsPlan: nestedPlan,
              parentContainerModelApiKey: blockApiKey,
              parentBlockId: rowId,
              parentFieldApiKey: field.api_key,
              rootRecordId,
              rootFieldApiKey: String(row._root_field_api_key),
              rawValue,
            });
            nestedAssignments.push({ requestKey, target: payload, fieldApiKey: field.api_key });
            continue;
          }
          payload[field.api_key] = rawValue;
        }

        const envelope = results.get(request.requestKey);
        if (envelope) {
          envelope.blocks[rowId] = payload;
        }
      }
    }

    if (nestedRequests.length > 0) {
      const nestedResults = yield* materializeStructuredTextValues({
        materializeContext,
        requests: nestedRequests,
      });
      for (const assignment of nestedAssignments) {
        assignment.target[assignment.fieldApiKey] = nestedResults.get(assignment.requestKey) ?? null;
      }
    }

    return results;
  });
}

export function materializeStructuredTextValue(params: MaterializeStructuredTextParams): Effect.Effect<StructuredTextEnvelope | null, unknown, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const results = yield* materializeStructuredTextValues({
      materializeContext: params.materializeContext,
      requests: [{ requestKey: "single", ...params }],
    });
    return results.get("single") ?? null;
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
      const materializeContext = {
        blockModelSchemas: new Map<string, BlockModelSchema>(),
        candidateBlockModels: new Map<string, ReadonlyArray<{ api_key: string }>>(),
      };
      if (field.localized) {
        const localeMap = decodeJsonIfString(rawValue);
        if (typeof localeMap !== "object" || localeMap === null || Array.isArray(localeMap)) {
          continue;
        }

        const localized: Record<string, unknown> = {};
        for (const [localeCode, localeValue] of Object.entries(localeMap as Record<string, unknown>)) {
          if (localeValue === null || localeValue === undefined) {
            localized[localeCode] = localeValue;
            continue;
          }
          const envelope = yield* materializeStructuredTextValue({
            allowedBlockApiKeys: getBlockWhitelist(field.validators) ?? [],
            parentContainerModelApiKey: params.modelApiKey,
            materializeContext,
            parentBlockId: null,
            parentFieldApiKey: field.api_key,
            rootRecordId: String(params.record.id),
            rootFieldApiKey: getStructuredTextStorageKey(field.api_key, localeCode),
            rawValue: localeValue,
          });
          localized[localeCode] = envelope;
        }
        materialized[field.api_key] = localized;
        continue;
      }

      const envelope = yield* materializeStructuredTextValue({
        allowedBlockApiKeys: getBlockWhitelist(field.validators) ?? [],
        parentContainerModelApiKey: params.modelApiKey,
        materializeContext,
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
