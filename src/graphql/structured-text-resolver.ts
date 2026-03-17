import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { extractBlockIds, extractInlineBlockIds, extractLinkIds } from "../dast/index.js";
import type { DynamicRow, DastDocInput } from "./gql-types.js";
import { deserializeRecord, toTypeName, decodeSnapshot } from "./gql-utils.js";
import { materializeStructuredTextValue as materializeStructuredTextEnvelope } from "../services/structured-text-service.js";

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
    const deserialized = decodeSnapshot(deserializeRecord(row), params.includeDrafts);
    result.set(String(row.id), {
      ...deserialized,
      __typename: typeName ?? undefined,
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

function getLinkedRecordCacheKey(targetApiKeys: readonly string[], id: string, includeDrafts: boolean) {
  return `${includeDrafts ? "drafts" : "published"}:${targetApiKeys.join(",")}:${id}`;
}

export async function batchResolveLinkedRecordsCached(params: {
  runSql: <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) => Promise<A>;
  targetApiKeys: string[];
  ids: string[];
  typeNames: Map<string, string>;
  includeDrafts: boolean;
  cache?: Map<string, Promise<DynamicRow | null>>;
}): Promise<Map<string, DynamicRow>> {
  if (params.ids.length === 0) return new Map();
  if (!params.cache) {
    return batchResolveLinkedRecords(params);
  }

  const result = new Map<string, DynamicRow>();
  const uncachedIds: string[] = [];
  const cacheEntries = new Map<string, Promise<DynamicRow | null>>();

  for (const id of params.ids) {
    const cacheKey = getLinkedRecordCacheKey(params.targetApiKeys, id, params.includeDrafts);
    const cached = params.cache.get(cacheKey);
    if (cached) {
      cacheEntries.set(id, cached);
      continue;
    }
    uncachedIds.push(id);
  }

  if (uncachedIds.length > 0) {
    const fetched = await batchResolveLinkedRecords({
      runSql: params.runSql,
      targetApiKeys: params.targetApiKeys,
      ids: uncachedIds,
      typeNames: params.typeNames,
      includeDrafts: params.includeDrafts,
    });
    for (const id of uncachedIds) {
      const promise = Promise.resolve(fetched.get(id) ?? null);
      params.cache.set(getLinkedRecordCacheKey(params.targetApiKeys, id, params.includeDrafts), promise);
      cacheEntries.set(id, promise);
    }
  }

  for (const id of params.ids) {
    const resolved = await cacheEntries.get(id);
    if (resolved) result.set(id, resolved);
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
  allowedBlockApiKeys?: readonly string[];
  typeNames: Map<string, string>;
  includeDrafts: boolean;
  linkedRecordCache?: Map<string, Promise<DynamicRow | null>>;
}): Promise<{ value: unknown; blocks: DynamicRow[]; inlineBlocks: DynamicRow[]; links: DynamicRow[] } | null> {
  let raw = parseUnknownJson(params.rawValue);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  let rawObj = raw as DynamicRow;
  let isEnvelope = rawObj.value && typeof rawObj.value === "object" && rawObj.blocks && typeof rawObj.blocks === "object";

  if (!isEnvelope && params.rootRecordId && params.rootFieldApiKey && params.parentContainerModelApiKey && params.parentFieldApiKey) {
    const materialized = await params.runSql(
      materializeStructuredTextEnvelope({
        allowedBlockApiKeys: params.allowedBlockApiKeys,
        parentContainerModelApiKey: params.parentContainerModelApiKey,
        parentBlockId: params.parentBlockId ?? null,
        parentFieldApiKey: params.parentFieldApiKey,
        rootRecordId: params.rootRecordId,
        rootFieldApiKey: params.rootFieldApiKey,
        rawValue: raw,
      })
    );
    if (materialized) {
      raw = materialized;
      rawObj = materialized as unknown as DynamicRow;
      isEnvelope = true;
    }
  }

  const dast = (isEnvelope ? rawObj.value : rawObj) as DastDocInput;
  const linkIds = extractLinkIds(dast);
  const allModelApiKeys = params.models.map((m) => m.api_key);
  const resolvedLinks = linkIds.length > 0
    ? await batchResolveLinkedRecordsCached({
      runSql: params.runSql,
      targetApiKeys: allModelApiKeys,
      ids: linkIds,
      typeNames: params.typeNames,
      includeDrafts: params.includeDrafts,
      cache: params.linkedRecordCache,
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
  const candidateBlockModels = params.allowedBlockApiKeys && params.allowedBlockApiKeys.length > 0
    ? params.blockModels.filter((model) => params.allowedBlockApiKeys?.includes(model.api_key))
    : params.blockModels;

  if (blockLevelIdSet.size > 0 || inlineBlockIdSet.size > 0) {
    for (const blockModel of candidateBlockModels) {
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
