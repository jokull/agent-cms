/**
 * Generic DatoCMS → agent-cms record importer.
 *
 * Unlike the trip-specific adapter, this module reads field definitions from the
 * Dato CMA at runtime and dispatches field transforms dynamically — no hardcoded
 * model names, block extractors, or GraphQL fragments.
 *
 * Usage:
 *   import { createImportProgram } from "./generic-import.mjs";
 *   await Effect.runPromise(createImportProgram({ cmsUrl, datoToken, locale: "en", model: "article", limit: 10, skip: 0 }));
 */

import { dirname, resolve } from "node:path";
import { Data, Effect } from "effect";

import { createAgentCmsClient } from "./agent-cms.mjs";
import { createDatoClient } from "./datocms.mjs";
import { fetchDatoSchemaMetadata } from "./dato-schema-metadata.mjs";
import { readJson, readJsonFile, writeJson } from "./runtime.mjs";

// ---------------------------------------------------------------------------
// Dato → agent-cms field type mapping (mirrors schema-codegen.mjs)
// ---------------------------------------------------------------------------

const FIELD_TYPE_MAP = {
  string: "string",
  text: "text",
  boolean: "boolean",
  integer: "integer",
  float: "float",
  date: "date",
  date_time: "date_time",
  slug: "slug",
  color: "color",
  json: "json",
  file: "media",
  gallery: "media_gallery",
  video: "video",
  link: "link",
  links: "links",
  structured_text: "structured_text",
  rich_text: "rich_text",
  seo: "seo",
  lat_lon: "lat_lon",
  single_block: "single_block", // tracked but skipped during import
};

// Scalar types that pass through without transformation
const SCALAR_TYPES = new Set([
  "string", "text", "boolean", "integer", "float", "date", "date_time", "slug", "json",
]);

// ---------------------------------------------------------------------------
// Effect error tags
// ---------------------------------------------------------------------------

class ImportInfrastructureError extends Data.TaggedError("ImportInfrastructureError") {}
class ImportRootRecordError extends Data.TaggedError("ImportRootRecordError") {}
class ImportIntegrityError extends Data.TaggedError("ImportIntegrityError") {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function promiseEffect(thunk, label = "import operation", context = {}) {
  return Effect.tryPromise({
    try: thunk,
    catch: (cause) =>
      new ImportInfrastructureError({
        operation: label,
        message: `${label} failed: ${errorMessage(cause)}`,
        cause,
        ...context,
      }),
  });
}

function normalizeDatoLocale(code) {
  if (!code) return code;
  return code.replace(/-/g, "_");
}

function denormalizeCmsLocale(code) {
  if (!code) return code;
  return code.replace(/_/g, "-");
}

function mapDatoBlockType(typename) {
  return typename.replace(/Record$/, "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

// ---------------------------------------------------------------------------
// createImportProgram
// ---------------------------------------------------------------------------

/**
 * Returns an Effect that imports records for a single Dato model into agent-cms.
 *
 * @param {{ cmsUrl: string, datoToken: string, locale: string, model: string, limit?: number, skip?: number, outDir?: string, r2PersistDir?: string, wranglerConfig?: string }} options
 */
export function createImportProgram({
  cmsUrl,
  cmsWriteKey,
  datoToken,
  fromExport = "",
  locale = "en",
  model,
  limit = 20,
  skip = 0,
  outDir: outDirOption,
  r2PersistDir: r2PersistDirOption,
  wranglerConfig: wranglerConfigOption,
  skipAssetUpload = false,
  maxDepth = 3,
  skipLinks = [],
}) {
  // ---- mutable run state ----
  let currentDepth = 0;
  const skipLinksSet = new Set(skipLinks);
  let findings = [];
  let touchedRecords = new Map();    // modelApiKey → Set<id>
  let touchedOverrides = new Map();  // modelApiKey → Map<id, overrides>
  let publishableRecords = new Map(); // modelApiKey → Set<id> — only records published in Dato
  let completedRootIds = new Set();
  const recordImportPromises = new Map(); // "model:id" → Promise
  const assetImportPromises = new Map();  // uploadId → Promise
  let runStartedAt = new Date().toISOString();

  const LINKED_IMPORT_CONCURRENCY = 4;
  const ASSET_IMPORT_CONCURRENCY = 6;
  const FATAL_FINDING_TYPES = new Set(["asset_fallback", "skipped_block"]);

  // ---- runtime configuration ----
  const IMPORT_LOCALE = locale;
  const IMPORT_SCOPE = model || "all";
  const OUT_DIR = outDirOption ?? resolve(process.cwd(), `scripts/dato-import/out/generic-${IMPORT_SCOPE}`);
  // ---- clients ----
  const datoClient = fromExport ? null : createDatoClient({ token: datoToken });
  const cms = createAgentCmsClient({ cmsUrl });
  // ---- schema cache (populated in setup phase) ----
  // fieldMap: modelApiKey → [{ api_key, field_type, localized, validators }]
  let fieldMap = new Map();
  // itemTypeIdToApiKey: dato item-type id → api_key
  let itemTypeIdToApiKey = new Map();
  let sourceSnapshot = null;
  let sourceItemsById = new Map();
  let sourceItemsByModel = new Map();
  let sourceUploadsById = new Map();
  let sourceModelOrder = [];
  let sourceRecordIndex = new Map();
  let sourceChunkCache = new Map();

  // =========================================================================
  // Findings
  // =========================================================================

  function noteFinding(record) {
    findings.push(record);
  }

  // =========================================================================
  // Checkpoint persistence
  // =========================================================================

  function checkpointFilename() {
    return `checkpoint-generic-${IMPORT_SCOPE}-${skip}-${limit}-${IMPORT_LOCALE}.json`;
  }

  function serializeTouchedRecords() {
    return Object.fromEntries(
      [...touchedRecords.entries()].map(([k, ids]) => [k, [...ids]]),
    );
  }

  function serializeTouchedOverrides() {
    return Object.fromEntries(
      [...touchedOverrides.entries()].map(([k, overrides]) => [k, Object.fromEntries(overrides)]),
    );
  }

  function checkpointSnapshot(status, extra = {}) {
    return {
      version: 1,
      adapter: "generic",
      model: IMPORT_SCOPE,
      skip,
      limit,
      locale: IMPORT_LOCALE,
      status,
      startedAt: runStartedAt,
      updatedAt: new Date().toISOString(),
      completedRootIds: [...completedRootIds],
      touchedRecords: serializeTouchedRecords(),
      touchedOverrides: serializeTouchedOverrides(),
      findings,
      ...extra,
    };
  }

  function restoreCheckpoint(checkpoint) {
    findings = Array.isArray(checkpoint.findings) ? checkpoint.findings : [];
    completedRootIds = new Set(Array.isArray(checkpoint.completedRootIds) ? checkpoint.completedRootIds : []);
    touchedRecords = new Map(
      Object.entries(checkpoint.touchedRecords ?? {}).map(([k, ids]) => [k, new Set(Array.isArray(ids) ? ids : [])]),
    );
    touchedOverrides = new Map(
      Object.entries(checkpoint.touchedOverrides ?? {}).map(([k, overrides]) => [k, new Map(Object.entries(overrides ?? {}))]),
    );
    runStartedAt = typeof checkpoint.startedAt === "string" ? checkpoint.startedAt : new Date().toISOString();
  }

  function readCheckpointEffect() {
    return promiseEffect(() => readJson(OUT_DIR, checkpointFilename()), "read checkpoint");
  }

  function saveCheckpointEffect(status, extra = {}) {
    return promiseEffect(() => writeJson(OUT_DIR, checkpointFilename(), checkpointSnapshot(status, extra)), "write checkpoint");
  }

  function writeFindingsEffect() {
    return promiseEffect(
      () => writeJson(OUT_DIR, `findings-generic-${IMPORT_SCOPE}-${skip}-${limit}.json`, findings),
      "write findings",
    );
  }

  function isInlineItem(value) {
    return value != null && typeof value === "object" && !Array.isArray(value) && typeof value.id === "string";
  }

  function getItemId(value) {
    if (typeof value === "string") return value;
    if (isInlineItem(value)) return value.id;
    return null;
  }

  function collectInlineBlockItems(node, items = []) {
    if (!node || typeof node !== "object") return items;
    if (Array.isArray(node)) {
      for (const entry of node) collectInlineBlockItems(entry, items);
      return items;
    }
    if ((node.type === "block" || node.type === "inlineBlock") && isInlineItem(node.item)) {
      items.push(node.item);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "item") continue;
      collectInlineBlockItems(value, items);
    }
    return items;
  }

  function resolveRecordModelApiKey(item) {
    const itemTypeId = item?.relationships?.item_type?.data?.id;
    return itemTypeId ? (itemTypeIdToApiKey.get(itemTypeId) ?? null) : null;
  }

  function loadSnapshot(snapshot) {
    sourceSnapshot = snapshot;
    fieldMap = new Map(Object.entries(snapshot.fieldMap ?? {}));
    itemTypeIdToApiKey = new Map((snapshot.itemTypes ?? []).map((itemType) => [itemType.id, itemType.apiKey]));
    sourceModelOrder = Array.isArray(snapshot.schema?.models)
      ? snapshot.schema.models.filter((entry) => !entry.isBlock).map((entry) => entry.apiKey)
      : Array.isArray(snapshot.models)
        ? snapshot.models.map((entry) => entry.apiKey)
        : Object.keys(snapshot.itemsByModel ?? {});
    sourceItemsByModel = new Map();
    sourceItemsById = new Map();
    sourceRecordIndex = new Map();
    sourceChunkCache = new Map();

    if (snapshot.format === "chunked") {
      for (const modelEntry of Array.isArray(snapshot.models) ? snapshot.models : []) {
        sourceItemsByModel.set(modelEntry.apiKey, modelEntry.chunks ?? []);
      }
      for (const [recordId, location] of Object.entries(snapshot.recordIndex ?? {})) {
        sourceRecordIndex.set(recordId, location);
      }
    } else {
      for (const [modelApiKey, items] of Object.entries(snapshot.itemsByModel ?? {})) {
        const normalizedItems = Array.isArray(items) ? items : [];
        sourceItemsByModel.set(modelApiKey, normalizedItems);
        for (const item of normalizedItems) {
          if (item?.id) sourceItemsById.set(item.id, item);
        }
      }
    }

    const uploadList = Array.isArray(snapshot.uploads) ? snapshot.uploads : [];
    sourceUploadsById = new Map(
      uploadList.filter((upload) => upload?.id).map((upload) => [upload.id, upload]),
    );
  }

  async function loadSnapshotIfNeeded() {
    if (!fromExport) return;
    if (sourceSnapshot) return;
    const snapshot = await readJsonFile(fromExport);
    if (!snapshot?.value) {
      throw new Error(`Export snapshot not found: ${fromExport}`);
    }
    const loaded = snapshot.value;
    if (loaded?.format === "chunked") {
      const snapshotDir = dirname(snapshot.path);
      const recordIndex = await readJsonFile(resolve(snapshotDir, loaded.recordIndexPath));
      const uploads = [];
      for (const uploadChunkPath of loaded.uploads?.chunks ?? []) {
        const chunk = await readJsonFile(resolve(snapshotDir, uploadChunkPath));
        uploads.push(...(Array.isArray(chunk?.value) ? chunk.value : []));
      }
      loadSnapshot({
        ...loaded,
        recordIndex: recordIndex?.value ?? {},
        uploads,
        _snapshotDir: snapshotDir,
      });
      return;
    }
    loadSnapshot(loaded);
  }

  async function readSourceChunk(chunkPath) {
    const snapshotDir = sourceSnapshot?._snapshotDir ?? dirname(fromExport);
    const absolutePath = resolve(snapshotDir, chunkPath);
    if (sourceChunkCache.has(absolutePath)) {
      return sourceChunkCache.get(absolutePath);
    }
    const chunk = await readJsonFile(absolutePath);
    const items = Array.isArray(chunk?.value) ? chunk.value : [];
    sourceChunkCache.set(absolutePath, items);
    for (const item of items) {
      if (item?.id) sourceItemsById.set(item.id, item);
    }
    return items;
  }

  async function loadModelItemsFromExport(modelApiKey) {
    const stored = sourceItemsByModel.get(modelApiKey) ?? [];
    if (!sourceSnapshot || sourceSnapshot.format !== "chunked") {
      return stored;
    }
    if (stored.length === 0 || typeof stored[0] !== "string") {
      return stored;
    }
    const items = [];
    for (const chunkPath of stored) {
      items.push(...await readSourceChunk(chunkPath));
    }
    sourceItemsByModel.set(modelApiKey, items);
    return items;
  }

  async function loadExportItemById(itemId) {
    const cached = sourceItemsById.get(itemId);
    if (cached) return cached;

    const location = sourceRecordIndex.get(itemId);
    if (location?.chunkPath) {
      await readSourceChunk(location.chunkPath);
      return sourceItemsById.get(itemId) ?? null;
    }

    return null;
  }

  async function loadExportItemsByIds(ids) {
    const items = [];
    for (const id of ids) {
      const item = await loadExportItemById(id);
      if (item) items.push(item);
    }
    return items;
  }

  // =========================================================================
  // Record bookkeeping
  // =========================================================================

  function markTouched(modelApiKey, id) {
    if (!touchedRecords.has(modelApiKey)) touchedRecords.set(modelApiKey, new Set());
    touchedRecords.get(modelApiKey).add(id);
  }

  function toRecordOverrides(meta) {
    if (!meta) return undefined;
    const overrides = {
      ...(meta.created_at ? { createdAt: meta.created_at } : {}),
      ...(meta.updated_at ? { updatedAt: meta.updated_at } : {}),
      ...(meta.published_at ? { publishedAt: meta.published_at } : {}),
      ...(meta.first_published_at ? { firstPublishedAt: meta.first_published_at } : {}),
    };
    return Object.keys(overrides).length > 0 ? overrides : undefined;
  }

  function rememberOverrides(modelApiKey, id, overrides) {
    if (!overrides) return;
    if (!touchedOverrides.has(modelApiKey)) touchedOverrides.set(modelApiKey, new Map());
    touchedOverrides.get(modelApiKey).set(id, overrides);
  }

  async function upsertImportedRecord(modelApiKey, id, data, overrides) {
    await cms.upsertRecord(modelApiKey, id, data, { publish: false, overrides });
    markTouched(modelApiKey, id);
    rememberOverrides(modelApiKey, id, overrides);
  }

  // =========================================================================
  // Single-flight dedup
  // =========================================================================

  const inFlightKeys = new Set();

  function singleFlight(cache, key, asyncFn) {
    if (cache.has(key)) return cache.get(key);
    // Break circular references: if this key is already being imported
    // up the call stack, return immediately to prevent deadlock.
    if (inFlightKeys.has(key)) return Promise.resolve(null);
    inFlightKeys.add(key);
    const promise = asyncFn().finally(() => {
      cache.delete(key);
      inFlightKeys.delete(key);
    });
    cache.set(key, promise);
    return promise;
  }

  // =========================================================================
  // Asset handling
  // =========================================================================

  function assetFromUploadRef(value) {
    if (!value?.upload_id) return null;
    return {
      id: value.upload_id,
      alt: value.alt ?? null,
      title: value.title ?? null,
      focalPoint: value.focal_point ?? null,
    };
  }

  async function ensureAsset(asset) {
    if (!asset?.id) return null;
    const upload = fromExport
      ? (sourceUploadsById.get(asset.id) ?? null)
      : await datoClient.getUpload(asset.id).catch(() => null);
    const uploadMeta =
      upload?.attributes?.default_field_metadata?.[denormalizeCmsLocale(IMPORT_LOCALE)] ??
      upload?.attributes?.default_field_metadata?.en ??
      null;
    const metadata = {
      id: upload?.id ?? asset.id,
      filename: upload?.attributes?.filename ?? asset.filename,
      mimeType: upload?.attributes?.mime_type ?? asset.mimeType ?? "application/octet-stream",
      size: upload?.attributes?.size ?? asset.size ?? 0,
      ...(upload?.attributes?.width == null && asset.width == null ? {} : { width: upload?.attributes?.width ?? asset.width }),
      ...(upload?.attributes?.height == null && asset.height == null ? {} : { height: upload?.attributes?.height ?? asset.height }),
      ...(uploadMeta?.alt == null && asset.alt == null ? {} : { alt: uploadMeta?.alt ?? asset.alt }),
      ...(uploadMeta?.title == null && asset.title == null ? {} : { title: uploadMeta?.title ?? asset.title }),
      ...(upload?.attributes?.blurhash == null && asset.blurhash == null ? {} : { blurhash: upload?.attributes?.blurhash ?? asset.blurhash }),
      ...(uploadMeta?.focal_point == null && asset.focalPoint == null ? {} : { focalPoint: uploadMeta?.focal_point ?? asset.focalPoint }),
      ...(Array.isArray(upload?.attributes?.colors)
        ? { colors: upload.attributes.colors.map((c) => `rgba(${c.red},${c.green},${c.blue},${c.alpha})`) }
        : {}),
      r2Key: `dato/${upload?.id ?? asset.id}/${upload?.attributes?.filename ?? asset.filename ?? "asset.bin"}`,
    };

    const sourceUrl = upload?.attributes?.url ?? asset.url ?? null;
    let uploaded = false;
    let uploadError = null;
    let reusedExisting = false;

    if (skipAssetUpload || typeof sourceUrl !== "string" || sourceUrl.length === 0) {
      const result = await cms.request("POST", "/api/assets", metadata);
      const duplicateAsset =
        result.status === 400 &&
        typeof result.body?.error === "string" &&
        result.body.error.includes("already exists");
      if (!result.ok && result.status !== 409 && !duplicateAsset) {
        throw new Error(`POST /api/assets failed (${result.status}): ${JSON.stringify(result.body)}`);
      }
      return {
        uploaded: false,
        metadataOnly: true,
        uploadError: typeof sourceUrl === "string" && sourceUrl.length > 0 ? null : "Missing source asset URL",
        reusedExisting: false,
      };
    }

    try {
      await cms.importAssetFromUrl({
        id: metadata.id,
        url: sourceUrl,
        filename: metadata.filename,
        mimeType: metadata.mimeType,
        alt: metadata.alt,
        title: metadata.title,
        tags: [],
        r2Key: metadata.r2Key,
        blurhash: metadata.blurhash,
        colors: metadata.colors,
        focalPoint: metadata.focalPoint,
      });
      uploaded = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const duplicateAsset = message.includes("already exists");
      if (duplicateAsset) {
        uploaded = true;
        reusedExisting = true;
      } else {
        uploadError = message;
      }
    }

    if (!uploaded) {
      const result = await cms.request("POST", "/api/assets", metadata);
      const duplicateAsset =
        result.status === 400 &&
        typeof result.body?.error === "string" &&
        result.body.error.includes("already exists");
      if (!result.ok && result.status !== 409 && !duplicateAsset) {
        throw new Error(`POST /api/assets failed (${result.status}): ${JSON.stringify(result.body)}`);
      }
    }

    return { uploaded, metadataOnly: !uploaded, uploadError, reusedExisting };
  }

  async function ensureAssetOnce(asset) {
    if (!asset?.id) return null;
    return singleFlight(assetImportPromises, asset.id, () => ensureAsset(asset));
  }

  async function importAssetRef(ref) {
    const asset = assetFromUploadRef(ref);
    if (!asset?.id) return;
    const result = await ensureAssetOnce(asset);
    if (result?.metadataOnly) {
      noteFinding({
        type: "asset_fallback",
        assetId: asset.id,
        detail: `Imported metadata only for asset '${asset.id}'.${result.uploadError ? ` Cause: ${result.uploadError}` : ""}`,
      });
    }
  }

  async function importAssetRefs(...refs) {
    await Promise.all(refs.map((ref) => importAssetRef(ref)));
  }

  // =========================================================================
  // Schema fetching — builds fieldMap from Dato CMA
  // =========================================================================

  async function fetchSchema() {
    if (fromExport) {
      await loadSnapshotIfNeeded();
      return;
    }

    const metadata = await fetchDatoSchemaMetadata(datoClient);
    itemTypeIdToApiKey = metadata.itemTypeIdToApiKey;
    fieldMap = metadata.fieldMap;
  }

  function getFieldDefs(modelApiKey) {
    return fieldMap.get(modelApiKey) ?? [];
  }

  // =========================================================================
  // Localized field helpers
  // =========================================================================

  function extractLocalizedValue(rawValue) {
    if (rawValue == null) return null;
    if (typeof rawValue === "object" && !Array.isArray(rawValue)) {
      // Dato CMA returns { "en": ..., "ko": ... } for localized fields
      return rawValue[denormalizeCmsLocale(IMPORT_LOCALE)] ?? rawValue[IMPORT_LOCALE] ?? null;
    }
    return rawValue;
  }

  function wrapLocalized(value) {
    if (value == null) return undefined;
    return { [IMPORT_LOCALE]: value };
  }

  function localizedMap(value) {
    if (value == null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const entries = Object.entries(value)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([loc, v]) => [normalizeDatoLocale(loc), v]);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  // =========================================================================
  // Structured text rewriting
  // =========================================================================

  function scopedBlockId(scopeId, blockId) {
    return `${scopeId}__${blockId}`;
  }

  function collectBlockRefs(node, refs = new Set()) {
    if (!node || typeof node !== "object") return refs;
    if (Array.isArray(node)) {
      for (const entry of node) collectBlockRefs(entry, refs);
      return refs;
    }
    if ((node.type === "block" || node.type === "inlineBlock")) {
      const itemId = getItemId(node.item);
      if (itemId) {
        refs.add(itemId);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "item") continue;
      collectBlockRefs(value, refs);
    }
    return refs;
  }

  function rewriteBlockRefs(node, idMap, context) {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) {
      return node
        .map((entry) => rewriteBlockRefs(entry, idMap, context))
        .filter((entry) => entry != null);
    }
    const copy = {};
    for (const [key, value] of Object.entries(node)) {
      copy[key] = key === "item" ? value : rewriteBlockRefs(value, idMap, context);
    }
    if (copy.type === "block" || copy.type === "inlineBlock") {
      const itemId = getItemId(copy.item);
      const mapped = itemId ? idMap.get(itemId) : null;
      if (!mapped) {
        noteFinding({
          type: "accepted_regression",
          area: "unsupported_block_reference",
          detail: `Dropped unsupported ${copy.type} reference '${itemId ?? "unknown"}' while importing ${context}.`,
        });
        return null;
      }
      copy.item = mapped;
    }
    return copy;
  }

  /**
   * Generically transforms a raw DAST value (CMA format) into agent-cms structured text.
   * Reads block items from CMA, resolves their item types, reads field definitions,
   * and builds block payloads dynamically.
   */
  async function transformStructuredTextRaw(dast, scopeId) {
    if (!dast) return null;
    const inlineBlocks = collectInlineBlockItems(dast, []);
    const blockRefIds = [...collectBlockRefs(dast)];
    const rawBlocks = inlineBlocks.length > 0
      ? inlineBlocks
      : fromExport
        ? await loadExportItemsByIds(blockRefIds)
        : await datoClient.getItems(blockRefIds);

    if (fromExport && inlineBlocks.length === 0 && blockRefIds.length > 0 && rawBlocks.length === 0) {
      noteFinding({
        type: "skipped_block",
        detail: `Structured text at '${scopeId}' referenced ${blockRefIds.length} block ID(s) that were missing from the export snapshot.`,
      });
      return { value: rewriteBlockRefs(deepClone(dast), new Map(), scopeId), blocks: {} };
    }

    const blocks = {};
    const idMap = new Map();

    for (const block of rawBlocks) {
      const blockTypeId = block.relationships?.item_type?.data?.id;
      const blockModelApiKey = blockTypeId ? (itemTypeIdToApiKey.get(blockTypeId) ?? null) : null;

      if (!blockModelApiKey) {
        noteFinding({ type: "skipped_block", blockType: blockTypeId, detail: "Could not resolve block item type." });
        continue;
      }

      const scopedId = scopedBlockId(scopeId, block.id);
      idMap.set(block.id, scopedId);

      const blockFieldDefs = getFieldDefs(blockModelApiKey);
      const blockData = { _type: blockModelApiKey };

      for (const fieldDef of blockFieldDefs) {
        const rawVal = block.attributes[fieldDef.api_key];
        if (rawVal === undefined || rawVal === null) continue;

        const agentType = FIELD_TYPE_MAP[fieldDef.field_type];
        const val = fieldDef.localized ? extractLocalizedValue(rawVal) : rawVal;

        if (val === null || val === undefined) continue;

        if (SCALAR_TYPES.has(agentType)) {
          blockData[fieldDef.api_key] = val;
        } else if (agentType === "media") {
          const asset = assetFromUploadRef(val);
          if (asset?.id) {
            await importAssetRef(val);
            blockData[fieldDef.api_key] = asset.id;
          }
        } else if (agentType === "media_gallery") {
          const items = Array.isArray(val) ? val : [];
          await importAssetRefs(...items);
          blockData[fieldDef.api_key] = items.map((a) => a.upload_id).filter(Boolean);
        } else if (agentType === "link") {
          if (typeof val === "string") {
            await importRecordByIdGeneric(val);
            blockData[fieldDef.api_key] = val;
          }
        } else if (agentType === "links") {
          const ids = Array.isArray(val) ? val.filter((v) => typeof v === "string") : [];
          for (const linkedId of ids) await importRecordByIdGeneric(linkedId);
          blockData[fieldDef.api_key] = ids;
        } else if (agentType === "structured_text") {
          blockData[fieldDef.api_key] = await transformStructuredTextRaw(
            val,
            `${scopeId}__${block.id}__${fieldDef.api_key}`,
          );
        } else if (agentType === "rich_text") {
          blockData[fieldDef.api_key] = await transformRichTextRaw(
            val,
            `${scopeId}__${block.id}__${fieldDef.api_key}`,
          );
        } else if (agentType === "seo") {
          blockData[fieldDef.api_key] = seoValue(val);
        } else if (agentType === "lat_lon") {
          blockData[fieldDef.api_key] = latLonValue(val);
        } else if (agentType === "color") {
          blockData[fieldDef.api_key] = val;
        } else if (agentType === "video") {
          blockData[fieldDef.api_key] = typeof val === "object" ? (val.url ?? val) : val;
          noteFinding({ type: "accepted_regression", area: "video_block", detail: "Video fields imported as plain URL strings." });
        }
      }

      blocks[scopedId] = blockData;
    }

    return {
      value: rewriteBlockRefs(deepClone(dast), idMap, scopeId),
      blocks,
    };
  }

  /**
   * Transforms a raw rich_text (modular content) value from DatoCMS CMA.
   * CMA returns an array of block item IDs — we fetch those blocks and
   * convert them to [{block_type, ...fields}, ...] for agent-cms writeRichText.
   */
  async function transformRichTextRaw(blockIds, scopeId) {
    if (!Array.isArray(blockIds) || blockIds.length === 0) return [];
    const inlineBlocks = blockIds.filter((entry) => isInlineItem(entry));
    const blockRefIds = blockIds.filter((id) => typeof id === "string");
    const rawBlocks = inlineBlocks.length > 0
      ? inlineBlocks
      : fromExport
        ? await loadExportItemsByIds(blockRefIds)
        : await datoClient.getItems(blockRefIds);

    if (fromExport && inlineBlocks.length === 0 && blockRefIds.length > 0 && rawBlocks.length === 0) {
      noteFinding({
        type: "skipped_block",
        detail: `Rich text at '${scopeId}' referenced ${blockRefIds.length} block ID(s) that were missing from the export snapshot.`,
      });
      return [];
    }
    const result = [];

    for (const block of rawBlocks) {
      const blockTypeId = block.relationships?.item_type?.data?.id;
      const blockModelApiKey = blockTypeId ? (itemTypeIdToApiKey.get(blockTypeId) ?? null) : null;

      if (!blockModelApiKey) {
        noteFinding({ type: "skipped_block", blockType: blockTypeId, detail: "Could not resolve block item type for rich_text." });
        continue;
      }

      const blockFieldDefs = getFieldDefs(blockModelApiKey);
      const blockData = { block_type: blockModelApiKey };

      for (const fieldDef of blockFieldDefs) {
        const rawVal = block.attributes[fieldDef.api_key];
        if (rawVal === undefined || rawVal === null) continue;

        const agentType = FIELD_TYPE_MAP[fieldDef.field_type];
        const val = fieldDef.localized ? extractLocalizedValue(rawVal) : rawVal;

        if (val === null || val === undefined) continue;

        if (SCALAR_TYPES.has(agentType)) {
          blockData[fieldDef.api_key] = val;
        } else if (agentType === "media") {
          const asset = assetFromUploadRef(val);
          if (asset?.id) {
            await importAssetRef(val);
            blockData[fieldDef.api_key] = asset.id;
          }
        } else if (agentType === "media_gallery") {
          const items = Array.isArray(val) ? val : [];
          await importAssetRefs(...items);
          blockData[fieldDef.api_key] = items.map((a) => a.upload_id).filter(Boolean);
        } else if (agentType === "link") {
          if (typeof val === "string") {
            await importRecordByIdGeneric(val);
            blockData[fieldDef.api_key] = val;
          }
        } else if (agentType === "links") {
          const linkedIds = Array.isArray(val) ? val.filter((v) => typeof v === "string") : [];
          for (const linkedId of linkedIds) await importRecordByIdGeneric(linkedId);
          blockData[fieldDef.api_key] = linkedIds;
        } else if (agentType === "structured_text") {
          blockData[fieldDef.api_key] = await transformStructuredTextRaw(
            val,
            `${scopeId}__${block.id}__${fieldDef.api_key}`,
          );
        } else if (agentType === "rich_text") {
          blockData[fieldDef.api_key] = await transformRichTextRaw(
            val,
            `${scopeId}__${block.id}__${fieldDef.api_key}`,
          );
        } else if (agentType === "seo") {
          blockData[fieldDef.api_key] = seoValue(val);
        } else if (agentType === "lat_lon") {
          blockData[fieldDef.api_key] = latLonValue(val);
        } else if (agentType === "color") {
          blockData[fieldDef.api_key] = val;
        } else if (agentType === "video") {
          blockData[fieldDef.api_key] = typeof val === "object" ? (val.url ?? val) : val;
        }
      }

      result.push(blockData);
    }

    return result;
  }

  // =========================================================================
  // SEO / lat_lon helpers
  // =========================================================================

  function seoValue(seo) {
    if (!seo) return null;
    return {
      ...(seo.title == null ? {} : { title: seo.title }),
      ...(seo.description == null ? {} : { description: seo.description }),
    };
  }

  function localizedSeoValue(value) {
    const map = localizedMap(value);
    if (!map) return undefined;
    const out = {};
    for (const [loc, seo] of Object.entries(map)) {
      const normalized = seoValue(seo);
      if (normalized && Object.keys(normalized).length > 0) {
        out[loc] = normalized;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  function latLonValue(value) {
    if (!value) return null;
    return { latitude: value.latitude, longitude: value.longitude };
  }

  // =========================================================================
  // Generic record import
  // =========================================================================

  /**
   * Imports a single Dato record by ID, resolving its item type dynamically.
   * Uses single-flight dedup to prevent duplicate imports.
   */
  async function importRecordByIdGeneric(recordId) {
    if (currentDepth >= maxDepth) {
      noteFinding({
        type: "max_depth_reached",
        recordId,
        depth: currentDepth,
        detail: `Skipped import of '${recordId}' — max depth ${maxDepth} reached.`,
      });
      return;
    }
    const key = `generic:${recordId}`;
    return singleFlight(recordImportPromises, key, async () => {
      currentDepth++;
      try {
        let item;
        if (fromExport) {
          item = sourceItemsById.get(recordId) ?? null;
          if (!item && sourceSnapshot?.format === "chunked") {
            const location = sourceRecordIndex.get(recordId);
            if (location?.chunkPath) {
              await readSourceChunk(location.chunkPath);
              item = sourceItemsById.get(recordId) ?? null;
            }
          }
        } else {
          item = await datoClient.getItem(recordId);
        }

        if (!item) {
          noteFinding({
            type: "skipped_record",
            recordId,
            detail: fromExport
              ? `Record '${recordId}' was not present in the export snapshot.`
              : `Record '${recordId}' could not be loaded from Dato.`,
          });
          return;
        }

        const modelApiKey = resolveRecordModelApiKey(item);

        if (!modelApiKey) {
          noteFinding({
            type: "skipped_record",
            recordId,
            detail: `Could not resolve the item type for record '${recordId}'.`,
          });
          return;
        }

        await importRecordFromCma(modelApiKey, item);
      } finally {
        currentDepth--;
      }
    });
  }

  /**
   * Transforms all fields of a CMA item and upserts it into agent-cms.
   */
  let importedCount = 0;
  async function importRecordFromCma(modelApiKey, item) {
    importedCount++;
    if (importedCount % 10 === 1) console.log(`  [import #${importedCount}] ${modelApiKey}/${item.id}`);
    const fieldDefs = getFieldDefs(modelApiKey);
    const data = {};

    // First pass: import dependencies (linked records and assets)
    // Second pass: build data payload
    for (const fieldDef of fieldDefs) {
      const rawVal = item.attributes[fieldDef.api_key];
      if (rawVal === undefined) continue;

      const agentType = FIELD_TYPE_MAP[fieldDef.field_type];
      if (!agentType || agentType === "single_block") continue;

      if (fieldDef.localized) {
        // For localized fields, handle the value map
        const transformed = await transformLocalizedField(fieldDef, agentType, rawVal, item.id);
        if (transformed !== undefined) {
          data[fieldDef.api_key] = transformed;
        }
      } else {
        // Non-localized
        const val = rawVal;
        const transformed = await transformFieldValue(fieldDef, agentType, val, item.id, fieldDef.api_key);
        if (transformed !== undefined) {
          data[fieldDef.api_key] = transformed;
        }
      }
    }

    const overrides = toRecordOverrides(item.meta);
    await upsertImportedRecord(modelApiKey, item.id, data, overrides);

    // Only publish records that were published in Dato
    if (item.meta?.status === "published") {
      if (!publishableRecords.has(modelApiKey)) publishableRecords.set(modelApiKey, new Set());
      publishableRecords.get(modelApiKey).add(item.id);
    }
  }

  /**
   * Transforms a localized field value. Returns a locale map or wraps single-locale value.
   */
  async function transformLocalizedField(fieldDef, agentType, rawVal, recordId) {
    if (rawVal == null) return undefined;

    // If it's an object with locale keys
    if (typeof rawVal === "object" && !Array.isArray(rawVal)) {
      // For structured_text, rich_text, and seo, build a full locale map
      if (agentType === "structured_text") {
        const result = {};
        for (const [loc, val] of Object.entries(rawVal)) {
          if (val == null) continue;
          const normalizedLoc = normalizeDatoLocale(loc);
          result[normalizedLoc] = await transformStructuredTextRaw(
            val,
            `${recordId}__${fieldDef.api_key}__${normalizedLoc}`,
          );
        }
        return Object.keys(result).length > 0 ? result : undefined;
      }

      if (agentType === "rich_text") {
        const result = {};
        for (const [loc, val] of Object.entries(rawVal)) {
          if (val == null) continue;
          const normalizedLoc = normalizeDatoLocale(loc);
          result[normalizedLoc] = await transformRichTextRaw(
            val,
            `${recordId}__${fieldDef.api_key}__${normalizedLoc}`,
          );
        }
        return Object.keys(result).length > 0 ? result : undefined;
      }

      if (agentType === "seo") {
        return localizedSeoValue(rawVal);
      }

      if (agentType === "media") {
        // Localized file field — extract for the current locale
        const val = extractLocalizedValue(rawVal);
        if (val == null) return undefined;
        await importAssetRef(val);
        const asset = assetFromUploadRef(val);
        return asset?.id ? wrapLocalized(asset.id) : undefined;
      }

      if (agentType === "media_gallery") {
        const val = extractLocalizedValue(rawVal);
        if (!Array.isArray(val) || val.length === 0) return undefined;
        await importAssetRefs(...val);
        return wrapLocalized(val.map((a) => a.upload_id).filter(Boolean));
      }

      if (agentType === "link") {
        const val = extractLocalizedValue(rawVal);
        if (typeof val !== "string") return undefined;
        if (!skipLinksSet.has(fieldDef.api_key)) {
          await importRecordByIdGeneric(val);
        }
        return wrapLocalized(val);
      }

      if (agentType === "links") {
        const val = extractLocalizedValue(rawVal);
        if (!Array.isArray(val)) return undefined;
        const ids = val.filter((v) => typeof v === "string");
        if (!skipLinksSet.has(fieldDef.api_key)) {
          for (const id of ids) await importRecordByIdGeneric(id);
        }
        return wrapLocalized(ids);
      }

      // Scalars with locale map — extract current locale, wrap back
      if (SCALAR_TYPES.has(agentType)) {
        const locMap = localizedMap(rawVal);
        return locMap;
      }

      if (agentType === "lat_lon") {
        const val = extractLocalizedValue(rawVal);
        return val ? wrapLocalized(latLonValue(val)) : undefined;
      }

      if (agentType === "color") {
        const locMap = localizedMap(rawVal);
        return locMap;
      }

      if (agentType === "video") {
        const val = extractLocalizedValue(rawVal);
        if (val == null) return undefined;
        const videoVal = typeof val === "object" ? (val.url ?? val) : val;
        return wrapLocalized(videoVal);
      }

      // Fallback: return the locale map as-is
      return localizedMap(rawVal);
    }

    // If the raw value isn't a locale map but field is marked localized, wrap it
    const transformed = await transformFieldValue(fieldDef, agentType, rawVal, recordId, fieldDef.api_key);
    return transformed !== undefined ? wrapLocalized(transformed) : undefined;
  }

  /**
   * Transforms a single non-localized field value.
   */
  async function transformFieldValue(fieldDef, agentType, val, recordId, fieldApiKey) {
    if (val === null || val === undefined) return undefined;

    if (SCALAR_TYPES.has(agentType)) {
      return val;
    }

    if (agentType === "media") {
      await importAssetRef(val);
      const asset = assetFromUploadRef(val);
      return asset?.id ?? undefined;
    }

    if (agentType === "media_gallery") {
      const items = Array.isArray(val) ? val : [];
      await importAssetRefs(...items);
      const ids = items.map((a) => a.upload_id).filter(Boolean);
      return ids.length > 0 ? ids : undefined;
    }

    if (agentType === "link") {
      if (typeof val === "string") {
        if (!skipLinksSet.has(fieldApiKey)) {
          await importRecordByIdGeneric(val);
        }
        return val;
      }
      return undefined;
    }

    if (agentType === "links") {
      const ids = Array.isArray(val) ? val.filter((v) => typeof v === "string") : [];
      if (!skipLinksSet.has(fieldApiKey)) {
        for (const id of ids) await importRecordByIdGeneric(id);
      }
      return ids.length > 0 ? ids : undefined;
    }

    if (agentType === "structured_text") {
      return transformStructuredTextRaw(val, `${recordId}__${fieldApiKey}`);
    }

    if (agentType === "rich_text") {
      return transformRichTextRaw(val, `${recordId}__${fieldApiKey}`);
    }

    if (agentType === "seo") {
      return seoValue(val);
    }

    if (agentType === "lat_lon") {
      return latLonValue(val);
    }

    if (agentType === "color") {
      return val;
    }

    if (agentType === "video") {
      if (typeof val === "object") return val.url ?? val;
      return val;
    }

    // Unknown — pass through and log
    noteFinding({
      type: "unmapped_field_type",
      model: fieldDef.api_key,
      fieldType: fieldDef.field_type,
      detail: `Field type '${fieldDef.field_type}' passed through without transformation.`,
    });
    return val;
  }

  // =========================================================================
  // Publish touched records
  // =========================================================================

  async function publishTouchedRecords() {
    if (IMPORT_LOCALE !== "en") {
      noteFinding({
        type: "deferred_publish",
        detail: `Skipped auto-publish for locale '${IMPORT_LOCALE}'.`,
      });
      return;
    }

    for (const [modelApiKey, ids] of touchedRecords) {
      const publishable = publishableRecords.get(modelApiKey);
      for (const id of ids) {
        if (!publishable?.has(id)) continue; // draft in Dato → stays draft
        try {
          await cms.publishRecord(modelApiKey, id);
        } catch (err) {
          noteFinding({
            type: "publish_failed",
            model: modelApiKey,
            recordId: id,
            detail: err.message ?? String(err),
          });
          continue;
        }
        const overrides = touchedOverrides.get(modelApiKey)?.get(id);
        if (overrides) {
          await cms.patchRecordOverrides(modelApiKey, id, overrides);
        }
      }
    }
  }

  // =========================================================================
  // Main Effect program
  // =========================================================================

  function getRootImportModels() {
    if (model) return [model];
    return sourceModelOrder.length > 0 ? sourceModelOrder : [...sourceItemsByModel.keys()];
  }

  async function getRootItemsForModel(modelApiKey) {
    if (fromExport) {
      const items = await loadModelItemsFromExport(modelApiKey);
      if (model) {
        return items.slice(skip, skip + limit);
      }
      return items;
    }

    return datoClient.listItemsByType(modelApiKey, { limit, offset: skip });
  }

  return Effect.gen(function* () {
    // Restore checkpoint if available
    const existingCheckpoint = yield* readCheckpointEffect();
    if (existingCheckpoint?.value?.status && existingCheckpoint.value.status !== "completed") {
      restoreCheckpoint(existingCheckpoint.value);
      yield* Effect.logInfo(
        `Resuming generic import for ${IMPORT_SCOPE} (${IMPORT_LOCALE}) with ${completedRootIds.size} completed root record(s)`,
      );
    } else {
      yield* Effect.logInfo(`Starting generic import for ${IMPORT_SCOPE} (${IMPORT_LOCALE})`);
    }

    yield* saveCheckpointEffect("running");

    // Fetch Dato schema
    yield* promiseEffect(() => fetchSchema(), "fetch Dato schema");
    yield* Effect.logInfo(`Loaded schema: ${fieldMap.size} models, ${[...fieldMap.values()].reduce((n, fs) => n + fs.length, 0)} fields`);

    if (model && !fieldMap.has(model)) {
      const available = [...fieldMap.keys()].join(", ");
      yield* Effect.fail(
        new ImportInfrastructureError({
          operation: "validate model",
          message: `Model '${model}' not found in Dato schema. Available: ${available}`,
        }),
      );
    }

    const rootModels = getRootImportModels();
    let totalRootItems = 0;
    let totalPendingItems = 0;

    for (const rootModel of rootModels) {
      const rootItems = yield* promiseEffect(
        () => getRootItemsForModel(rootModel),
        "list source records",
        { model: rootModel, skip, limit },
      );

      const pendingItems = rootItems.filter((item) => !completedRootIds.has(item.id));
      totalRootItems += rootItems.length;
      totalPendingItems += pendingItems.length;
      yield* Effect.logInfo(`Found ${rootItems.length} root records for ${rootModel}, ${pendingItems.length} pending`);

      yield* Effect.forEach(
        pendingItems,
        (item) =>
          promiseEffect(
            () => importRecordFromCma(rootModel, item),
            "import root record",
            { model: rootModel, recordId: item.id },
          ).pipe(
            Effect.zipRight(
              Effect.sync(() => {
                completedRootIds.add(item.id);
              }),
            ),
            Effect.catchAll((error) =>
              Effect.fail(
                new ImportRootRecordError({
                  model: rootModel,
                  recordId: item.id,
                  message: `Failed to import root ${rootModel} record '${item.id}'`,
                  cause: error,
                }),
              ),
            ),
            Effect.zipRight(saveCheckpointEffect("running", { model: rootModel, recordId: item.id })),
          ),
        { concurrency: 1 },
      );
    }

    // Publish all touched records
    yield* promiseEffect(() => publishTouchedRecords(), "publish touched records");

    // Write findings
    const findingsPath = yield* writeFindingsEffect();
    const fatalFindings = findings.filter((f) => FATAL_FINDING_TYPES.has(f.type));

    if (fatalFindings.length > 0) {
      yield* Effect.fail(
        new ImportIntegrityError({
          model: IMPORT_SCOPE,
          findingsPath,
          violationCount: fatalFindings.length,
          message: `Import completed with ${fatalFindings.length} integrity violation(s). See ${findingsPath}`,
        }),
      );
    }

    yield* Effect.logInfo(`Imported ${totalPendingItems}/${totalRootItems} root record(s) from locale ${IMPORT_LOCALE}`);
    yield* Effect.logInfo(`Findings: ${findings.length} total`);
    yield* Effect.logInfo(`Saved ${findingsPath}`);

    yield* saveCheckpointEffect("completed", { completedAt: new Date().toISOString(), findingsPath });

    return {
      findingsPath,
      recordsImported: totalPendingItems,
      findingsCount: findings.length,
    };
  }).pipe(
    Effect.catchAll((error) =>
      saveCheckpointEffect("failed", {
        lastError: errorMessage(error),
        lastErrorTag: error && typeof error === "object" && "_tag" in error ? error._tag : undefined,
      }).pipe(Effect.zipRight(Effect.fail(error))),
    ),
  );
}
