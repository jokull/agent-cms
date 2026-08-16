import { Effect, Schema, SchemaIssue } from "effect";
import { contentTableName } from "../dynamic/tables.js";
import { isObjectRecord, type DynamicRow } from "../dynamic/row-types.js";
import { SqlClient, SqlError } from "effect/unstable/sql";
import { validateBlocksOnly, extractAllBlockIds, extractBlockIds, extractLinkIds } from "../dast/index.js";
import { ValidationError } from "../errors.js";
import { DastDocumentInput, DastDocumentSchema, StructuredTextWriteInput } from "../dast/schema.js";
import { runBatchedQueries, type BatchedQuery } from "../db/run-batched-queries.js";
import type { FieldRow, ParsedFieldRow } from "../db/row-types.js";
import { parseFieldValidators } from "../db/row-types.js";
import { getBlockWhitelist, getBlocksOnly, getRichTextBlockWhitelist, getInlineBlockWhitelist, getStructuredTextLinkModels } from "../db/validators.js";
import { getFieldTypeDef } from "../field-types.js";
import { isFieldType } from "../types.js";
import { decodeJsonIfString, decodeJsonStringOr, encodeJson } from "../json.js";
import { collectMediaSite, type MediaSite } from "../media-field.js";

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
  /**
   * Collector for media / media_gallery / seo values found in block payloads.
   * When the caller supplies one, every such value is registered here instead
   * of being resolved inline, so the whole record set can be enriched with a
   * single batched asset query (`enrichMediaSites`). Absent → no enrichment.
   */
  mediaSites?: MediaSite[];
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
  return Schema.decodeUnknownEffect(StructuredTextWriteInput)(value).pipe(
    Effect.mapError((e) => new ValidationError({
      message: `Invalid StructuredText for field '${fieldApiKey}': ${e.message}`,
      field: fieldApiKey,
      code: "structured_text",
    }))
  );
}

const getParsedFields = Effect.fn("getParsedFields")(function* (sql: SqlClient.SqlClient, modelId: string) {
  const fieldRows = yield* sql.unsafe<FieldRow>(
    "SELECT * FROM fields WHERE model_id = ? ORDER BY position",
    [modelId]
  );
  return fieldRows.map(parseFieldValidators);
});

const getBlockModelSchema = Effect.fn("getBlockModelSchema")(function* (sql: SqlClient.SqlClient, blockApiKey: string) {
  const rows = yield* sql.unsafe<{ id: string; api_key: string }>(
    "SELECT id, api_key FROM models WHERE api_key = ? AND is_block = 1",
    [blockApiKey]
  );
  if (rows.length === 0) {
    return yield* new ValidationError({
      message: `Block type '${blockApiKey}' does not exist`,
      code: "block_type",
    });
  }
  const model = rows[0];
  const fields = yield* getParsedFields(sql, model.id);
  const structuredTextAllowedBlockApiKeysByField = new Map<string, readonly string[]>();
  for (const field of fields) {
    if (field.field_type === "structured_text") {
      structuredTextAllowedBlockApiKeysByField.set(field.api_key, getBlockWhitelist(field.validators) ?? []);
    } else if (field.field_type === "rich_text") {
      structuredTextAllowedBlockApiKeysByField.set(field.api_key, getRichTextBlockWhitelist(field.validators) ?? []);
    }
  }
  return {
    id: model.id,
    apiKey: model.api_key,
    fields,
    structuredTextAllowedBlockApiKeysByField,
  } satisfies BlockModelSchema;
});

const getBlockModelSchemaCached = Effect.fn("getBlockModelSchemaCached")(function* (ctx: MaterializeContext, sql: SqlClient.SqlClient, blockApiKey: string) {
  const cached = ctx.blockModelSchemas.get(blockApiKey);
  if (cached) return cached;
  const schema = yield* getBlockModelSchema(sql, blockApiKey);
  ctx.blockModelSchemas.set(blockApiKey, schema);
  return schema;
});

const fetchBlockModelsCached = Effect.fn("fetchBlockModelsCached")(function* (ctx: MaterializeContext, sql: SqlClient.SqlClient) {
  if (ctx.blockModels) return ctx.blockModels;
  const blockModels = yield* fetchBlockModels(sql);
  ctx.blockModels = blockModels;
  return blockModels;
});

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

function formatDastParseErrors(error: Schema.SchemaError): string {
  const formatted = SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues;
  return formatted.map((issue) => `${(issue.path ?? []).map(String).join(".")}: ${issue.message}`).join("; ");
}

const validateDastForField = Effect.fn("validateDastForField")(function* (fieldApiKey: string, value: unknown, blocksOnly: boolean) {
  const dast = yield* Schema.decodeUnknownEffect(DastDocumentSchema)(value).pipe(
    Effect.mapError((e) => new ValidationError({
      message: `Invalid DAST document: ${formatDastParseErrors(e)}`,
      field: fieldApiKey,
      code: "structured_text",
    }))
  );

  if (blocksOnly) {
    const blocksOnlyErrors = validateBlocksOnly(value);
    if (blocksOnlyErrors.length > 0) {
      return yield* new ValidationError({
        message: `Blocks-only field '${fieldApiKey}': ${blocksOnlyErrors.map((e) => e.message).join("; ")}`,
        field: fieldApiKey,
        code: "structured_text",
      });
    }
  }

  return dast;
});

/**
 * Enforce the `structured_text_links` validator: every record referenced by an
 * `itemLink` / `inlineItem` node must belong to a model in `allowedModelApiKeys`.
 * A referenced id that is not found in any allowed model's content table is a
 * violation (it either does not exist or belongs to a disallowed model — Dato
 * rejects both). An empty allowlist means "no model is allowed", so any link
 * fails; callers pass `undefined` (not `[]`) to opt out entirely.
 */
const enforceStructuredTextLinks = Effect.fn("enforceStructuredTextLinks")(function* (
  sql: SqlClient.SqlClient,
  fieldApiKey: string,
  dast: DastLikeForLinks,
  allowedModelApiKeys: readonly string[],
) {
  const linkIds = extractLinkIds(dast);
  if (linkIds.length === 0) return;

  const allowedModels = allowedModelApiKeys.length > 0
    ? yield* sql.unsafe<{ api_key: string }>(
        `SELECT api_key FROM models WHERE api_key IN (${allowedModelApiKeys.map(() => "?").join(", ")}) AND is_block = 0`,
        [...allowedModelApiKeys],
      )
    : [];

  const foundIds = new Set<string>();
  const idPlaceholders = linkIds.map(() => "?").join(", ");
  for (const model of allowedModels) {
    const rows = yield* sql.unsafe<{ id: string }>(
      `SELECT id FROM "${contentTableName(model.api_key)}" WHERE id IN (${idPlaceholders})`,
      [...linkIds],
    );
    for (const row of rows) foundIds.add(row.id);
  }

  const disallowed = linkIds.filter((id) => !foundIds.has(id));
  if (disallowed.length > 0) {
    return yield* new ValidationError({
      message: `StructuredText field '${fieldApiKey}' links to record(s) whose model is not permitted by structured_text_links: ${disallowed.join(", ")}`,
      field: fieldApiKey,
      code: "link_target",
    });
  }
});

interface DastLikeForLinks {
  document: { children: readonly unknown[]; type?: string };
}

const compileStructuredText = Effect.fn("compileStructuredText")(function* (
  ctx: CompileContext,
  container: ContainerRef,
  params: {
    fieldApiKey: string;
    input: StructuredTextWriteInput;
    allowedBlockTypes: string[];
    // Whitelist for `inlineBlock` nodes. `undefined` = validator absent → one
    // whitelist (`allowedBlockTypes`) governs both positions. Validators are
    // opt-in refinements: absence means "don't split the lists", not "no inline
    // blocks" (a deliberate divergence from Dato, which requires the validator
    // for inline blocks at all).
    allowedInlineBlockTypes?: readonly string[] | undefined;
    // Whitelist of model api_keys that `itemLink` / `inlineItem` targets may
    // reference. `undefined` = validator absent → unrestricted, like every other
    // absent validator.
    allowedLinkModels?: readonly string[] | undefined;
    blocksOnly: boolean;
  }
): Effect.fn.Return<CompiledStructuredText, ValidationError | SqlError.SqlError> {
  const { sql, seenBlockIds } = ctx;
  const { fieldApiKey, input, allowedBlockTypes, allowedInlineBlockTypes, allowedLinkModels, blocksOnly } = params;

  const dast = yield* validateDastForField(fieldApiKey, input.value, blocksOnly);
  // Block-position `block` nodes use `allowedBlockTypes`; `inlineBlock` nodes use
  // the inline whitelist when present, otherwise fall back to `allowedBlockTypes`.
  const blockPositionIds = new Set(extractBlockIds(dast));
  const effectiveInlineBlockTypes = allowedInlineBlockTypes ?? allowedBlockTypes;
  const referencedBlockIds = extractAllBlockIds(dast);
  const providedBlockIds = Object.keys(input.blocks);

  // Enforce structured_text_links: every itemLink/inlineItem target must belong
  // to an allowed model. Absent validator → allowedLinkModels undefined → skip.
  if (allowedLinkModels !== undefined) {
    yield* enforceStructuredTextLinks(sql, fieldApiKey, dast, allowedLinkModels);
  }

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
    if (!isObjectRecord(rawBlock)) {
      return yield* new ValidationError({
        message: `Block '${blockId}' must be an object`,
        field: fieldApiKey,
      });
    }
    const blockData = rawBlock;
    if (typeof blockData._type !== "string" || blockData._type.length === 0) {
      return yield* new ValidationError({
        message: `Block '${blockId}' must have a _type property`,
        field: fieldApiKey,
      });
    }
    const isInlinePosition = !blockPositionIds.has(blockId);
    const allowlistForNode = isInlinePosition ? effectiveInlineBlockTypes : allowedBlockTypes;
    if (allowlistForNode.length > 0 && !allowlistForNode.includes(blockData._type)) {
      return yield* new ValidationError({
        message: `${isInlinePosition ? "Inline block" : "Block"} type '${blockData._type}' is not allowed in field '${fieldApiKey}'. Allowed: ${allowlistForNode.join(", ")}`,
        field: fieldApiKey,
        code: "block_type",
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
            allowedInlineBlockTypes: getInlineBlockWhitelist(field.validators),
            allowedLinkModels: getStructuredTextLinkModels(field.validators),
            blocksOnly: getBlocksOnly(field.validators),
          }
        );
        row[field.api_key] = nestedCompiled.dast;
        mergeRowMaps(nestedRows, nestedCompiled.rowsByTable);
        continue;
      }

      if (field.field_type === "rich_text") {
        if (!Array.isArray(value)) {
          return yield* new ValidationError({
            message: `Nested rich_text field '${field.api_key}' must be an array of block objects`,
            field: field.api_key,
          });
        }
        const nestedResult = yield* writeRichTextBlocks({
          sql: ctx.sql,
          rootRecordId: ctx.rootRecordId,
          rootFieldApiKey: ctx.rootFieldApiKey,
          rootModelApiKey: ctx.rootModelApiKey,
          seenBlockIds: ctx.seenBlockIds,
          parentContainerModelApiKey: blockModel.apiKey,
          parentBlockId: blockId,
          parentFieldApiKey: field.api_key,
          depth: container.depth + 1,
          fieldApiKey: field.api_key,
          // SAFETY: the block-write path validated block shapes on the way in
          // (decodeStructuredTextInput); the array guard handles null/absent.
          blocks: Array.isArray(value) ? value as RichTextWriteBlock[] : [],
          allowedBlockTypes: getRichTextBlockWhitelist(field.validators) ?? [],
        });
        row[field.api_key] = nestedResult.blockIds;
        mergeRowMaps(nestedRows, nestedResult.rowsByTable);
        continue;
      }

      if (isFieldType(field.field_type)) {
        const fieldDef = getFieldTypeDef(field.field_type);
        if (fieldDef.inputSchema) {
          yield* Schema.decodeUnknownEffect(fieldDef.inputSchema)(value).pipe(
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

const insertCompiledRows = Effect.fn("insertCompiledRows")(function* (sql: SqlClient.SqlClient, rowsByTable: Map<string, DynamicRow[]>) {
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

function fetchBlockModels(sql: SqlClient.SqlClient) {
  return sql.unsafe<{ api_key: string }>(
    "SELECT api_key FROM models WHERE is_block = 1 ORDER BY api_key"
  );
}

const collectDescendantBlockIds = Effect.fn("collectDescendantBlockIds")(function* (sql: SqlClient.SqlClient, startIds: string[]) {
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

export interface StructuredTextWriteParams {
  rootModelApiKey: string;
  fieldApiKey: string;
  rootFieldStorageKey?: string;
  rootRecordId: string;
  value: unknown;
  blocks?: Record<string, unknown>;
  allowedBlockTypes?: string[];
  allowedInlineBlockTypes?: readonly string[] | undefined;
  allowedLinkModels?: readonly string[] | undefined;
  blocksOnly?: boolean;
}

/**
 * Decode + compile a structured_text value: runs the FULL validation pipeline
 * (DAST decode, blocks_only, block/inline whitelist, structured_text_links,
 * block-model existence, nested block validation) and produces the block rows,
 * but does NOT persist them. `writeStructuredText` inserts the rows; the
 * dry-run validator discards them — both go through this one function, so the
 * write and validate paths can never diverge on what counts as valid.
 */
const compileStructuredTextValue = Effect.fn("compileStructuredTextValue")(function* (params: StructuredTextWriteParams) {
  const sql = yield* SqlClient.SqlClient;
  const input = yield* decodeStructuredTextInput(params.fieldApiKey, {
    value: params.value,
    blocks: params.blocks ?? {},
  });
  return yield* compileStructuredText(
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
      allowedInlineBlockTypes: params.allowedInlineBlockTypes,
      allowedLinkModels: params.allowedLinkModels,
      blocksOnly: params.blocksOnly ?? false,
    }
  );
});

export const writeStructuredText = Effect.fn("writeStructuredText")(function* (params: StructuredTextWriteParams) {
  const sql = yield* SqlClient.SqlClient;
  const compiled = yield* compileStructuredTextValue(params);
  yield* insertCompiledRows(sql, compiled.rowsByTable);
  return compiled.dast;
});

/**
 * Validate a structured_text value exactly as `writeStructuredText` would, with
 * ZERO persistence (no block rows inserted). Used by the record dry-run
 * validator. Same code path (`compileStructuredTextValue`) as the write.
 */
export function validateStructuredText(params: StructuredTextWriteParams) {
  return compileStructuredTextValue(params).pipe(Effect.asVoid);
}

export const deleteBlocksForField = Effect.fn("deleteBlocksForField")(function* (params: {
  rootRecordId: string;
  fieldApiKey: string;
  includeLocalizedVariants?: boolean;
}): Effect.fn.Return<void, unknown, SqlClient.SqlClient> {
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

export const deleteBlockSubtrees = Effect.fn("deleteBlockSubtrees")(function* (params: {
  blockIds: string[];
}): Effect.fn.Return<void, unknown, SqlClient.SqlClient> {
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

  // SAFETY: stored structured_text values are full DAST documents (schema: 'dast',
  // document with children) written by this pipeline; the guard above verified the
  // document/children envelope, and extractAllBlockIds only walks that shape.
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

/**
 * Build the block-materialization query as a SINGLE `UNION ALL` statement over
 * all candidate block models, instead of one structurally-identical SELECT per
 * model collapsed via D1 `batch()`.
 *
 * Every branch shares the same projection, predicate, and bound values; the only
 * per-branch differences are the table name, the `'<api_key>' AS __block_api_key`
 * self-tag (so flattened rows remain identifiable), and the `json_object(...)`
 * field projection. Returning one statement means 1 round trip on any backend
 * (D1 or a future Postgres backend), independent of the `batch()` API.
 *
 * Id lists are bound as single JSON parameters via `json_each(?)` (a pattern
 * already used across the codebase — driver support is confirmed) rather than
 * `IN (?,?,…)` placeholder expansion. This keeps the SQL text stable regardless
 * of id-list cardinality (the statement cache no longer sees a distinct query
 * per list length) and keeps each branch's param tuple constant-sized.
 *
 * Params are bound left-to-right across all `UNION ALL` branches; since every
 * branch shares identical values, the shared per-branch tuple is repeated once
 * per model. The tuple is:
 *   (rootRecordIdsJson, rootFieldApiKey, parentContainerModelApiKey,
 *    parentFieldApiKey, [parentBlockIdsJson], blockIdsJson)
 * with parentBlockIdsJson present only when parent blocks are non-empty (the
 * `_parent_block_id IS NULL` branch binds nothing there).
 *
 * Returns an at-most-one-element array so the existing `runHotBlockQueries`
 * plumbing and the callers' flattening (`rowGroups.flat()` / the per-group loop)
 * stay unchanged. An empty `blockModels` yields no query.
 */
function buildMaterializeQueries(params: {
  blockModels: readonly BlockModelSchema[];
  rootRecordIds: readonly string[];
  rootFieldApiKey: string;
  parentContainerModelApiKey: string;
  parentFieldApiKey: string;
  parentBlockIds: readonly string[];
  blockIds: readonly string[];
}): ReadonlyArray<BatchedQuery> {
  if (params.blockModels.length === 0) return [];

  const hasParentBlocks = params.parentBlockIds.length > 0;
  const parentClause = hasParentBlocks
    ? "_parent_block_id IN (SELECT value FROM json_each(?))"
    : "_parent_block_id IS NULL";

  const rootRecordIdsJson = JSON.stringify([...params.rootRecordIds]);
  const parentBlockIdsJson = hasParentBlocks ? JSON.stringify([...params.parentBlockIds]) : null;
  const blockIdsJson = JSON.stringify([...params.blockIds]);

  const perBranchParams: ReadonlyArray<unknown> = [
    rootRecordIdsJson,
    params.rootFieldApiKey,
    params.parentContainerModelApiKey,
    params.parentFieldApiKey,
    ...(parentBlockIdsJson === null ? [] : [parentBlockIdsJson]),
    blockIdsJson,
  ];

  const branches = params.blockModels.map((model) => {
    const payloadParts = model.fields.map((field) => `'${field.api_key}', "${field.api_key}"`).join(", ");
    return `SELECT id, _root_record_id, _root_field_api_key, _parent_block_id, '${model.apiKey}' AS __block_api_key, json_object(${payloadParts}) AS __payload
       FROM "block_${model.apiKey}"
       WHERE _root_record_id IN (SELECT value FROM json_each(?))
         AND _root_field_api_key = ?
         AND _parent_container_model_api_key = ?
         AND _parent_field_api_key = ?
         AND ${parentClause}
         AND id IN (SELECT value FROM json_each(?))`;
  });

  return [{
    sql: branches.join("\n     UNION ALL\n"),
    params: params.blockModels.flatMap(() => perBranchParams),
  }];
}

export const materializeStructuredTextValues = Effect.fn("materializeStructuredTextValues")(function* (params: {
  materializeContext?: MaterializeContext;
  requests: readonly MaterializeStructuredTextRequest[];
}): Effect.fn.Return<Map<string, StructuredTextEnvelope | null>, unknown, SqlClient.SqlClient> {
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
  const nestedRtAssignments: Array<{ target: DynamicRow; fieldApiKey: string; params: Parameters<typeof materializeRichTextValue>[0] }> = [];

  for (const requests of requestsByGroup.values()) {
    const sample = requests[0];

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
        if (field.field_type === "rich_text" && rawValue !== null) {
          nestedRtAssignments.push({
            target: payload,
            fieldApiKey: field.api_key,
            params: {
              allowedBlockApiKeys: getRichTextBlockWhitelist(field.validators) ?? [],
              parentContainerModelApiKey: blockApiKey,
              parentBlockId: rowId,
              parentFieldApiKey: field.api_key,
              rootRecordId,
              rootFieldApiKey: String(row._root_field_api_key),
              rawValue,
              materializeContext,
            },
          });
          continue;
        }
        payload[field.api_key] = rawValue;
        // Media inside a block payload is enriched with the rest of the
        // record set — register the site, never query per block.
        collectMediaSite(materializeContext.mediaSites, payload, field.api_key, field.field_type);
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

  for (const assignment of nestedRtAssignments) {
    const result = yield* materializeRichTextValue(assignment.params);
    assignment.target[assignment.fieldApiKey] = result;
  }

  return results;
});

export const materializeStructuredTextValue = Effect.fn("materializeStructuredTextValue")(function* (params: MaterializeStructuredTextParams): Effect.fn.Return<StructuredTextEnvelope | null, unknown, SqlClient.SqlClient> {
  const results = yield* materializeStructuredTextValues({
    materializeContext: params.materializeContext,
    requests: [{ requestKey: "single", ...params }],
  });
  return results.get("single") ?? null;
});

export const materializeRecordStructuredTextFields = Effect.fn("materializeRecordStructuredTextFields")(function* (params: {
  modelApiKey: string;
  record: DynamicRow;
  fields: ParsedFieldRow[];
  /**
   * Optional collector for the media values found in nested block payloads.
   * Callers reading a whole record set share one array and resolve it once
   * (`enrichMediaSites`); callers that pass nothing get today's behavior.
   */
  mediaSites?: MediaSite[];
}): Effect.fn.Return<DynamicRow, unknown, SqlClient.SqlClient> {
  const materializeContext: MaterializeContext = {
    blockModelSchemas: new Map<string, BlockModelSchema>(),
    candidateBlockModels: new Map<string, ReadonlyArray<{ api_key: string }>>(),
    mediaSites: params.mediaSites,
  };
  const materialized: DynamicRow = { ...params.record };
  for (const field of params.fields) {
    if (field.field_type !== "structured_text" && field.field_type !== "rich_text") continue;
    const rawValue = params.record[field.api_key];
    if (rawValue === null || rawValue === undefined) continue;

    if (field.field_type === "rich_text") {
      if (field.localized) {
        const localeMap = decodeJsonIfString(rawValue);
        if (!isObjectRecord(localeMap)) continue;
        const localized: Record<string, unknown> = {};
        for (const [localeCode, localeValue] of Object.entries(localeMap)) {
          if (localeValue === null || localeValue === undefined) {
            localized[localeCode] = localeValue;
            continue;
          }
          const blocks = yield* materializeRichTextValue({
            allowedBlockApiKeys: getRichTextBlockWhitelist(field.validators) ?? [],
            parentContainerModelApiKey: params.modelApiKey,
            materializeContext,
            parentBlockId: null,
            parentFieldApiKey: field.api_key,
            rootRecordId: String(params.record.id),
            rootFieldApiKey: getStructuredTextStorageKey(field.api_key, localeCode),
            rawValue: localeValue,
          });
          localized[localeCode] = blocks;
        }
        materialized[field.api_key] = localized;
      } else {
        const blocks = yield* materializeRichTextValue({
          allowedBlockApiKeys: getRichTextBlockWhitelist(field.validators) ?? [],
          parentContainerModelApiKey: params.modelApiKey,
          materializeContext,
          parentBlockId: null,
          parentFieldApiKey: field.api_key,
          rootRecordId: String(params.record.id),
          rootFieldApiKey: field.api_key,
          rawValue,
        });
        materialized[field.api_key] = blocks;
      }
      continue;
    }

    // structured_text
    if (field.localized) {
      const localeMap = decodeJsonIfString(rawValue);
      if (!isObjectRecord(localeMap)) {
        continue;
      }

      const localized: Record<string, unknown> = {};
      for (const [localeCode, localeValue] of Object.entries(localeMap)) {
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

// ===========================================================================
// Rich Text (Modular Content) — ordered array of blocks, no DAST
// ===========================================================================

export interface RichTextWriteBlock {
  id?: string;
  block_type: string;
  [key: string]: unknown;
}

/**
 * Write a rich_text field value.
 * Input: array of block objects [{block_type, ...fields}, ...].
 * Stores blocks in block_* tables, returns JSON array of block IDs for the column.
 */
export interface RichTextWriteParams {
  rootModelApiKey: string;
  fieldApiKey: string;
  rootFieldStorageKey?: string;
  rootRecordId: string;
  blocks: RichTextWriteBlock[];
  allowedBlockTypes: string[];
}

/**
 * Compile a top-level rich_text value into its block rows without persisting.
 * Delegates to the same recursive `writeRichTextBlocks` used for nested
 * rich_text so the root and nested cases (and the write vs. dry-run paths) share
 * one implementation of the block-type / duplicate-id / nested-content checks.
 */
const compileRichTextValue = Effect.fn("compileRichTextValue")(function* (params: RichTextWriteParams) {
  const sql = yield* SqlClient.SqlClient;
  return yield* writeRichTextBlocks({
    sql,
    rootRecordId: params.rootRecordId,
    rootFieldApiKey: params.rootFieldStorageKey ?? params.fieldApiKey,
    rootModelApiKey: params.rootModelApiKey,
    seenBlockIds: new Set<string>(),
    parentContainerModelApiKey: params.rootModelApiKey,
    parentBlockId: null,
    parentFieldApiKey: params.fieldApiKey,
    depth: 0,
    fieldApiKey: params.fieldApiKey,
    blocks: params.blocks,
    allowedBlockTypes: params.allowedBlockTypes,
  });
});

export const writeRichText = Effect.fn("writeRichText")(function* (params: RichTextWriteParams) {
  const sql = yield* SqlClient.SqlClient;
  const { blockIds, rowsByTable } = yield* compileRichTextValue(params);
  yield* insertCompiledRows(sql, rowsByTable);
  return blockIds;
});

/**
 * Validate a rich_text value exactly as `writeRichText` would, with ZERO
 * persistence (no block rows inserted). Used by the record dry-run validator.
 */
export function validateRichText(params: RichTextWriteParams) {
  return compileRichTextValue(params).pipe(Effect.asVoid);
}

/** Internal recursive helper for nested rich_text inside blocks */
const writeRichTextBlocks = Effect.fn("writeRichTextBlocks")(function* (params: {
  sql: SqlClient.SqlClient;
  rootRecordId: string;
  rootFieldApiKey: string;
  rootModelApiKey: string;
  seenBlockIds: Set<string>;
  parentContainerModelApiKey: string;
  parentBlockId: string | null;
  parentFieldApiKey: string;
  depth: number;
  fieldApiKey: string;
  blocks: RichTextWriteBlock[];
  allowedBlockTypes: string[];
}): Effect.fn.Return<{ blockIds: string[]; rowsByTable: Map<string, DynamicRow[]> }, ValidationError | import("effect/unstable/sql").SqlError.SqlError> {
  const { sql, fieldApiKey, blocks, allowedBlockTypes, seenBlockIds } = params;
  const rowsByTable = new Map<string, DynamicRow[]>();
  const blockIds: string[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (typeof block.block_type !== "string" || block.block_type.length === 0) {
      return yield* new ValidationError({
        message: `rich_text block at index ${i} must have a block_type property`,
        field: fieldApiKey,
      });
    }
    if (allowedBlockTypes.length > 0 && !allowedBlockTypes.includes(block.block_type)) {
      return yield* new ValidationError({
        message: `Block type '${block.block_type}' is not allowed in rich_text field '${fieldApiKey}'. Allowed: ${allowedBlockTypes.join(", ")}`,
        field: fieldApiKey,
        code: "block_type",
      });
    }

    const blockId = typeof block.id === "string" && block.id.length > 0
      ? block.id
      : crypto.randomUUID();

    if (seenBlockIds.has(blockId)) {
      return yield* new ValidationError({
        message: `Duplicate block id '${blockId}' in rich_text field '${fieldApiKey}'`,
        field: fieldApiKey,
      });
    }
    seenBlockIds.add(blockId);
    blockIds.push(blockId);

    const blockModel = yield* getBlockModelSchema(sql, block.block_type);
    const row: DynamicRow = {
      id: blockId,
      _root_record_id: params.rootRecordId,
      _root_field_api_key: params.rootFieldApiKey,
      _parent_container_model_api_key: params.parentContainerModelApiKey,
      _parent_block_id: params.parentBlockId,
      _parent_field_api_key: params.parentFieldApiKey,
      _depth: params.depth,
    };

    for (const field of blockModel.fields) {
      const value = block[field.api_key];
      if (value === undefined) continue;
      if (value === null) {
        row[field.api_key] = null;
        continue;
      }

      if (field.field_type === "structured_text") {
        const nestedInput = yield* decodeStructuredTextInput(field.api_key, value);
        const nestedCompiled = yield* compileStructuredText(
          {
            sql,
            rootRecordId: params.rootRecordId,
            rootFieldApiKey: params.rootFieldApiKey,
            rootModelApiKey: params.rootModelApiKey,
            seenBlockIds,
          },
          {
            parentContainerModelApiKey: blockModel.apiKey,
            parentBlockId: blockId,
            parentFieldApiKey: field.api_key,
            depth: params.depth + 1,
          },
          {
            fieldApiKey: field.api_key,
            input: nestedInput,
            allowedBlockTypes: getBlockWhitelist(field.validators) ?? [],
            allowedInlineBlockTypes: getInlineBlockWhitelist(field.validators),
            allowedLinkModels: getStructuredTextLinkModels(field.validators),
            blocksOnly: getBlocksOnly(field.validators),
          }
        );
        row[field.api_key] = nestedCompiled.dast;
        mergeRowMaps(rowsByTable, nestedCompiled.rowsByTable);
        continue;
      }

      if (field.field_type === "rich_text") {
        if (!Array.isArray(value)) {
          return yield* new ValidationError({
            message: `Nested rich_text field '${field.api_key}' must be an array of block objects`,
            field: field.api_key,
          });
        }
        const nestedResult = yield* writeRichTextBlocks({
          ...params,
          parentContainerModelApiKey: blockModel.apiKey,
          parentBlockId: blockId,
          parentFieldApiKey: field.api_key,
          depth: params.depth + 1,
          fieldApiKey: field.api_key,
          // SAFETY: block shapes validated by the write path (decodeStructuredTextInput);
          // the array guard handles null/absent.
          blocks: Array.isArray(value) ? value as RichTextWriteBlock[] : [],
          allowedBlockTypes: getRichTextBlockWhitelist(field.validators) ?? [],
        });
        row[field.api_key] = nestedResult.blockIds;
        mergeRowMaps(rowsByTable, nestedResult.rowsByTable);
        continue;
      }

      if (isFieldType(field.field_type)) {
        const fieldDef = getFieldTypeDef(field.field_type);
        if (fieldDef.inputSchema) {
          yield* Schema.decodeUnknownEffect(fieldDef.inputSchema)(value).pipe(
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
  }

  return { blockIds, rowsByTable };
});

/**
 * Materialize a rich_text field value from stored block IDs + block tables.
 * Returns an array of block objects [{_type, id, ...fields}, ...] in order.
 */
export const materializeRichTextValue = Effect.fn("materializeRichTextValue")(function* (params: {
  allowedBlockApiKeys?: readonly string[];
  parentContainerModelApiKey: string;
  parentBlockId: string | null;
  parentFieldApiKey: string;
  rootRecordId: string;
  rootFieldApiKey: string;
  rawValue: unknown;
  materializeContext?: MaterializeContext;
}): Effect.fn.Return<DynamicRow[] | null, unknown, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient;
  const parsed = decodeJsonIfString(params.rawValue);
  if (!Array.isArray(parsed) || parsed.length === 0) return parsed === null ? null : [];

  const blockIds = parsed.filter((id): id is string => typeof id === "string");
  if (blockIds.length === 0) return [];

  const materializeContext = params.materializeContext ?? {
    blockModelSchemas: new Map<string, BlockModelSchema>(),
    candidateBlockModels: new Map<string, ReadonlyArray<{ api_key: string }>>(),
  };

  const blockModels = yield* fetchBlockModelsCached(materializeContext, sql);
  const candidateBlockModels = getCandidateBlockModelsCached(
    materializeContext,
    blockModels,
    params.allowedBlockApiKeys ? [...params.allowedBlockApiKeys] : undefined
  );

  const blockModelSchemas = yield* Effect.all(
    candidateBlockModels.map((model) => getBlockModelSchemaCached(materializeContext, sql, model.api_key)),
    { concurrency: "unbounded" },
  );

  const blockIdSet = new Set(blockIds);
  const blockModelByApiKey = new Map(blockModelSchemas.map((model) => [model.apiKey, model] as const));
  const blockById = new Map<string, DynamicRow>();

  // Fetch block rows
  const rowGroups = yield* runHotBlockQueries<DynamicRow>(buildMaterializeQueries({
    blockModels: blockModelSchemas,
    rootRecordIds: [params.rootRecordId],
    rootFieldApiKey: params.rootFieldApiKey,
    parentContainerModelApiKey: params.parentContainerModelApiKey,
    parentFieldApiKey: params.parentFieldApiKey,
    parentBlockIds: params.parentBlockId ? [params.parentBlockId] : [],
    blockIds,
  }));

  const nestedStRequests: MaterializeStructuredTextRequest[] = [];
  const nestedStAssignments: Array<{ requestKey: string; target: DynamicRow; fieldApiKey: string }> = [];
  const nestedRtAssignments: Array<{ target: DynamicRow; fieldApiKey: string; params: typeof params }> = [];

  for (const rows of rowGroups) {
    for (const row of rows) {
      const rowId = String(row.id);
      if (!blockIdSet.has(rowId)) continue;

      const blockApiKey = typeof row.__block_api_key === "string" ? row.__block_api_key : null;
      if (!blockApiKey) continue;
      const blockModel = blockModelByApiKey.get(blockApiKey);
      if (!blockModel) continue;

      const rawPayload = decodeJsonIfString(row.__payload);
      if (typeof rawPayload !== "object" || rawPayload === null || Array.isArray(rawPayload)) continue;

      const payload: DynamicRow = { _type: blockApiKey, id: rowId };
      for (const field of blockModel.fields) {
        const rawValue = deserializeValue(Reflect.get(rawPayload, field.api_key));
        if (rawValue === undefined) continue;

        if (field.field_type === "structured_text" && rawValue !== null) {
          const requestKey = `rt_nested_st:${nestedStAssignments.length}`;
          nestedStRequests.push({
            requestKey,
            materializeContext,
            allowedBlockApiKeys: blockModel.structuredTextAllowedBlockApiKeysByField.get(field.api_key) ?? [],
            parentContainerModelApiKey: blockApiKey,
            parentBlockId: rowId,
            parentFieldApiKey: field.api_key,
            rootRecordId: params.rootRecordId,
            rootFieldApiKey: params.rootFieldApiKey,
            rawValue,
          });
          nestedStAssignments.push({ requestKey, target: payload, fieldApiKey: field.api_key });
          continue;
        }

        if (field.field_type === "rich_text" && rawValue !== null) {
          nestedRtAssignments.push({
            target: payload,
            fieldApiKey: field.api_key,
            params: {
              allowedBlockApiKeys: getRichTextBlockWhitelist(field.validators) ?? [],
              parentContainerModelApiKey: blockApiKey,
              parentBlockId: rowId,
              parentFieldApiKey: field.api_key,
              rootRecordId: params.rootRecordId,
              rootFieldApiKey: params.rootFieldApiKey,
              rawValue,
              materializeContext,
            },
          });
          continue;
        }

        payload[field.api_key] = rawValue;
        // Media inside a block payload is enriched with the rest of the
        // record set — register the site, never query per block.
        collectMediaSite(materializeContext.mediaSites, payload, field.api_key, field.field_type);
      }

      blockById.set(rowId, payload);
    }
  }

  // Resolve nested structured_text
  if (nestedStRequests.length > 0) {
    const nestedResults = yield* materializeStructuredTextValues({
      materializeContext,
      requests: nestedStRequests,
    });
    for (const assignment of nestedStAssignments) {
      assignment.target[assignment.fieldApiKey] = nestedResults.get(assignment.requestKey) ?? null;
    }
  }

  // Resolve nested rich_text (recursive)
  for (const assignment of nestedRtAssignments) {
    const result = yield* materializeRichTextValue(assignment.params);
    assignment.target[assignment.fieldApiKey] = result;
  }

  // Return blocks in original order
  return blockIds.map((id) => blockById.get(id)).filter((b): b is DynamicRow => b != null);
});

/**
 * Materialize all rich_text fields on a record (used by MCP get_record).
 */
export const materializeRecordRichTextFields = Effect.fn("materializeRecordRichTextFields")(function* (params: {
  modelApiKey: string;
  record: DynamicRow;
  fields: ParsedFieldRow[];
}): Effect.fn.Return<DynamicRow, unknown, SqlClient.SqlClient> {
  const materialized: DynamicRow = { ...params.record };
  const materializeContext: MaterializeContext = {
    blockModelSchemas: new Map<string, BlockModelSchema>(),
    candidateBlockModels: new Map<string, ReadonlyArray<{ api_key: string }>>(),
  };
  for (const field of params.fields) {
    if (field.field_type !== "rich_text") continue;
    const rawValue = params.record[field.api_key];
    if (rawValue === null || rawValue === undefined) continue;

    if (field.localized) {
      const localeMap = decodeJsonIfString(rawValue);
      if (!isObjectRecord(localeMap)) continue;
      const localized: Record<string, unknown> = {};
      for (const [localeCode, localeValue] of Object.entries(localeMap)) {
        if (localeValue === null || localeValue === undefined) {
          localized[localeCode] = localeValue;
          continue;
        }
        const blocks = yield* materializeRichTextValue({
          allowedBlockApiKeys: getRichTextBlockWhitelist(field.validators) ?? [],
          parentContainerModelApiKey: params.modelApiKey,
          materializeContext,
          parentBlockId: null,
          parentFieldApiKey: field.api_key,
          rootRecordId: String(params.record.id),
          rootFieldApiKey: getStructuredTextStorageKey(field.api_key, localeCode),
          rawValue: localeValue,
        });
        localized[localeCode] = blocks;
      }
      materialized[field.api_key] = localized;
      continue;
    }

    const blocks = yield* materializeRichTextValue({
      allowedBlockApiKeys: getRichTextBlockWhitelist(field.validators) ?? [],
      parentContainerModelApiKey: params.modelApiKey,
      materializeContext,
      parentBlockId: null,
      parentFieldApiKey: field.api_key,
      rootRecordId: String(params.record.id),
      rootFieldApiKey: field.api_key,
      rawValue,
    });
    materialized[field.api_key] = blocks;
  }
  return materialized;
});
