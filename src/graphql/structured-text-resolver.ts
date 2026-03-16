import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { extractBlockIds, extractInlineBlockIds, extractLinkIds } from "../dast/index.js";
import type { DynamicRow, DastDocInput } from "./gql-types.js";
import { deserializeRecord, toTypeName } from "./gql-utils.js";

function parseUnknownJson(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function overlayPublishedSnapshot(record: DynamicRow, includeDrafts: boolean): DynamicRow {
  if (includeDrafts || !record._published_snapshot) return record;
  const snapshot = typeof record._published_snapshot === "string"
    ? JSON.parse(record._published_snapshot as string)
    : record._published_snapshot;
  return { ...record, ...(snapshot as DynamicRow) };
}

export async function batchFetchRecords(params: {
  runSql: <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) => Promise<A>;
  tableApiKey: string;
  ids: string[];
  typeNames: Map<string, string>;
  includeDrafts: boolean;
}): Promise<Map<string, DynamicRow>> {
  if (params.ids.length === 0) return new Map();
  const placeholders = params.ids.map(() => "?").join(", ");
  const typeName = params.typeNames.get(params.tableApiKey);
  const rows = await params.runSql(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.unsafe<DynamicRow>(
        `SELECT * FROM "content_${params.tableApiKey}" WHERE id IN (${placeholders})`,
        params.ids
      );
    })
  );
  const result = new Map<string, DynamicRow>();
  for (const row of rows) {
    const deserialized = overlayPublishedSnapshot(deserializeRecord(row), params.includeDrafts);
    result.set(String(row.id), {
      ...deserialized,
      __typename: typeName ? `${typeName}Record` : undefined,
    });
  }
  return result;
}

export async function batchResolveLinkedRecords(params: {
  runSql: <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) => Promise<A>;
  targetApiKeys: string[];
  ids: string[];
  typeNames: Map<string, string>;
  includeDrafts: boolean;
}): Promise<Map<string, DynamicRow>> {
  const result = new Map<string, DynamicRow>();
  const remaining = new Set(params.ids);
  for (const apiKey of params.targetApiKeys) {
    if (remaining.size === 0) break;
    const fetched = await batchFetchRecords({
      runSql: params.runSql,
      tableApiKey: apiKey,
      ids: [...remaining],
      typeNames: params.typeNames,
      includeDrafts: params.includeDrafts,
    });
    for (const [id, record] of fetched) {
      result.set(id, record);
      remaining.delete(id);
    }
  }
  return result;
}

function materializeBlocksFromEnvelope(
  dast: DastDocInput,
  envelopeBlocks: Record<string, unknown>,
) {
  const blockLevelIds = extractBlockIds(dast);
  const inlineBlockIds = extractInlineBlockIds(dast);
  const blocks: DynamicRow[] = [];
  const inlineBlocks: DynamicRow[] = [];

  for (const id of blockLevelIds) {
    const raw = envelopeBlocks[id];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const payload = raw as DynamicRow;
    blocks.push({
      id,
      ...payload,
      __typename: typeof payload._type === "string" ? `${toTypeName(payload._type)}Record` : undefined,
    });
  }

  for (const id of inlineBlockIds) {
    const raw = envelopeBlocks[id];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const payload = raw as DynamicRow;
    inlineBlocks.push({
      id,
      ...payload,
      __typename: typeof payload._type === "string" ? `${toTypeName(payload._type)}Record` : undefined,
    });
  }

  return { blocks, inlineBlocks };
}

export async function resolveStructuredTextValue(params: {
  runSql: <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) => Promise<A>;
  rawValue: unknown;
  rootRecordId?: string;
  rootFieldApiKey?: string;
  parentContainerModelApiKey?: string;
  parentBlockId?: string | null;
  parentFieldApiKey?: string;
  models: readonly { api_key: string }[];
  blockModels: readonly { api_key: string }[];
  typeNames: Map<string, string>;
  includeDrafts: boolean;
}): Promise<{ value: unknown; blocks: DynamicRow[]; inlineBlocks: DynamicRow[]; links: DynamicRow[] } | null> {
  let raw = parseUnknownJson(params.rawValue);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const rawObj = raw as DynamicRow;
  const isEnvelope = rawObj.value && typeof rawObj.value === "object" && rawObj.blocks && typeof rawObj.blocks === "object";
  const dast = (isEnvelope ? rawObj.value : rawObj) as DastDocInput;
  const linkIds = extractLinkIds(dast);
  const allModelApiKeys = params.models.map((m) => m.api_key);
  const resolvedLinks = linkIds.length > 0
    ? await batchResolveLinkedRecords({
      runSql: params.runSql,
      targetApiKeys: allModelApiKeys,
      ids: linkIds,
      typeNames: params.typeNames,
      includeDrafts: params.includeDrafts,
    })
    : new Map<string, DynamicRow>();
  const links = linkIds.map((id) => resolvedLinks.get(id) ?? null).filter(Boolean) as DynamicRow[];

  if (isEnvelope) {
    const envelopeBlocks = rawObj.blocks as Record<string, unknown>;
    const { blocks, inlineBlocks } = materializeBlocksFromEnvelope(dast, envelopeBlocks);
    return { value: dast, blocks, inlineBlocks, links };
  }

  if (!params.rootRecordId || !params.rootFieldApiKey || !params.parentContainerModelApiKey || !params.parentFieldApiKey) {
    return { value: dast, blocks: [], inlineBlocks: [], links };
  }

  const blockLevelIdSet = new Set(extractBlockIds(dast));
  const inlineBlockIdSet = new Set(extractInlineBlockIds(dast));
  const blocks: DynamicRow[] = [];
  const inlineBlocks: DynamicRow[] = [];

  if (blockLevelIdSet.size > 0 || inlineBlockIdSet.size > 0) {
    for (const blockModel of params.blockModels) {
      const rows = await params.runSql(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql.unsafe<DynamicRow>(
            `SELECT * FROM "block_${blockModel.api_key}"
             WHERE _root_record_id = ?
               AND _root_field_api_key = ?
               AND _parent_container_model_api_key = ?
               AND _parent_field_api_key = ?
               AND ${params.parentBlockId == null ? "_parent_block_id IS NULL" : "_parent_block_id = ?"}`,
            params.parentBlockId == null
              ? [params.rootRecordId, params.rootFieldApiKey, params.parentContainerModelApiKey, params.parentFieldApiKey]
              : [params.rootRecordId, params.rootFieldApiKey, params.parentContainerModelApiKey, params.parentFieldApiKey, params.parentBlockId]
          );
        })
      );
      for (const row of rows) {
        const deserialized = deserializeRecord(row);
        const resolved = {
          ...deserialized,
          __typename: `${toTypeName(blockModel.api_key)}Record`,
        };
        if (blockLevelIdSet.has(String(row.id))) blocks.push(resolved);
        else if (inlineBlockIdSet.has(String(row.id))) inlineBlocks.push(resolved);
      }
    }
  }

  return { value: dast, blocks, inlineBlocks, links };
}
