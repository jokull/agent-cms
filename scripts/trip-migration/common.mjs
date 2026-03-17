import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";

export const CMS_URL = process.env.CMS_URL ?? "http://127.0.0.1:8791";
export const DATOCMS_URL = "https://graphql.datocms.com/";
export const DATOCMS_CMA_URL = "https://site-api.datocms.com";
export const DATOCMS_API_TOKEN = process.env.DATOCMS_API_TOKEN;
export const ACTIVE_LOCALES = ["en", "ko", "ja", "zh_CN", "es"];
export const IMPORT_LOCALE = process.env.IMPORT_LOCALE ?? "en";
export const OUT_DIR = resolve(process.cwd(), "scripts/trip-migration/out");
export const TRIP_MIGRATION_CMS_DIR = resolve(process.cwd(), "examples/trip-migration/cms");
export const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME ?? "trip-migration-assets";
export const R2_PERSIST_DIR = process.env.R2_PERSIST_DIR ?? resolve(TRIP_MIGRATION_CMS_DIR, ".wrangler/state-v3");
export const WRANGLER_CONFIG = process.env.WRANGLER_CONFIG ?? resolve(TRIP_MIGRATION_CMS_DIR, "wrangler.jsonc");

const itemCache = new Map();
const itemTypeCache = new Map();
const uploadCache = new Map();
let localR2ContextPromise;
let localR2CleanupRegistered = false;

if (!DATOCMS_API_TOKEN) {
  throw new Error("DATOCMS_API_TOKEN is required");
}

export function normalizeDatoLocale(code) {
  if (!code) return code;
  return code.replace(/-/g, "_");
}

export function denormalizeCmsLocale(code) {
  if (!code) return code;
  return code.replace(/_/g, "-");
}

export async function ensureOutDir() {
  await mkdir(OUT_DIR, { recursive: true });
}

export async function writeJson(filename, value) {
  await ensureOutDir();
  const path = resolve(OUT_DIR, filename);
  await writeFile(path, JSON.stringify(value, null, 2));
  return path;
}

export function getArg(name, fallback = undefined) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

export async function datoQuery(query, variables = {}) {
  const response = await fetch(DATOCMS_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${DATOCMS_API_TOKEN}`,
      "x-exclude-invalid": "true",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (!response.ok || body.errors) {
    throw new Error(`Dato query failed: ${JSON.stringify(body.errors ?? body, null, 2)}`);
  }
  return body.data;
}

export async function datoCmaRequest(path, searchParams = undefined) {
  const url = new URL(`${DATOCMS_CMA_URL}${path}`);
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const entry of value) {
          url.searchParams.append(key, String(entry));
        }
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${DATOCMS_API_TOKEN}`,
        accept: "application/json",
        "X-Api-Version": "3",
      },
    });

    const body = await response.json();
    const rateLimitError = response.status === 429
      || (Array.isArray(body?.data) && body.data.some((entry) => entry?.attributes?.code === "RATE_LIMIT_EXCEEDED"));

    if (response.ok && !body.errors) {
      return body;
    }

    if (rateLimitError && attempt < 4) {
      const reset = Number(body?.data?.[0]?.attributes?.details?.reset ?? 1);
      await sleep(Math.max(reset, 1) * 1000);
      continue;
    }

    throw new Error(`Dato CMA request failed: ${JSON.stringify(body.errors ?? body, null, 2)}`);
  }

  throw new Error(`Dato CMA request failed after retries for ${url.pathname}`);
}

export async function datoListItemsByType(type, { limit = 20, offset = 0 } = {}) {
  const body = await datoCmaRequest("/items", {
    "page[limit]": limit,
    "page[offset]": offset,
    "filter[type]": type,
  });
  return body.data ?? [];
}

export async function datoGetItem(id) {
  if (itemCache.has(id)) return itemCache.get(id);
  const body = await datoCmaRequest(`/items/${encodeURIComponent(id)}`);
  itemCache.set(id, body.data);
  return body.data;
}

export async function datoGetItems(ids) {
  if (!ids.length) return [];
  const cached = [];
  const missing = [];
  for (const id of ids) {
    if (itemCache.has(id)) {
      cached.push(itemCache.get(id));
    } else {
      missing.push(id);
    }
  }
  if (missing.length === 0) return cached;
  const body = await datoCmaRequest("/items", {
    "page[limit]": missing.length,
    "filter[ids]": missing.join(","),
  });
  for (const item of body.data ?? []) {
    itemCache.set(item.id, item);
    cached.push(item);
  }
  return ids.map((id) => itemCache.get(id)).filter(Boolean);
}

export async function datoGetItemTypes() {
  if (itemTypeCache.size > 0) return itemTypeCache;
  const body = await datoCmaRequest("/item-types", {
    "page[limit]": 200,
  });
  for (const itemType of body.data ?? []) {
    itemTypeCache.set(itemType.id, itemType.attributes.api_key);
  }
  return itemTypeCache;
}

export async function datoGetItemTypeApiKey(itemTypeId) {
  const itemTypes = await datoGetItemTypes();
  return itemTypes.get(itemTypeId) ?? null;
}

export async function datoGetUpload(id) {
  if (uploadCache.has(id)) return uploadCache.get(id);
  const body = await datoCmaRequest(`/uploads/${encodeURIComponent(id)}`);
  uploadCache.set(id, body.data);
  return body.data;
}

export async function datoGetUploads(ids) {
  if (!ids.length) return [];
  const uploads = [];
  for (const id of ids) {
    uploads.push(await datoGetUpload(id));
  }
  return uploads;
}

export async function datoGetSite() {
  const body = await datoCmaRequest("/site");
  return body.data;
}

export async function cmsRequest(method, path, body) {
  const response = await fetch(`${CMS_URL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return {
    ok: response.ok,
    status: response.status,
    body: parsed,
  };
}

export async function cmsJson(method, path, body) {
  const result = await cmsRequest(method, path, body);
  if (!result.ok) {
    throw new Error(`${method} ${path} failed (${result.status}): ${JSON.stringify(result.body)}`);
  }
  return result.body;
}

export async function listModels() {
  return cmsJson("GET", "/api/models");
}

export async function listFields(modelId) {
  return cmsJson("GET", `/api/models/${modelId}/fields`);
}

export async function listLocales() {
  return cmsJson("GET", "/api/locales");
}

export async function getExistingModelMap() {
  const models = await listModels();
  return new Map(models.map((model) => [model.api_key ?? model.apiKey, model]));
}

export async function getExistingFieldMap(modelId) {
  const fields = await listFields(modelId);
  return new Map(fields.map((field) => [field.api_key ?? field.apiKey, field]));
}

export async function ensureLocale(code, fallbackLocaleId = null, position = undefined) {
  const locales = await listLocales();
  const existing = locales.find((locale) => locale.code === code);
  if (existing) return existing;
  return cmsJson("POST", "/api/locales", {
    code,
    ...(position === undefined ? {} : { position }),
    ...(fallbackLocaleId == null ? {} : { fallbackLocaleId }),
  });
}

export async function ensureModel(definition) {
  const models = await getExistingModelMap();
  const existing = models.get(definition.apiKey);
  if (existing) {
    if (definition.singleton !== undefined && Boolean(existing.singleton) !== Boolean(definition.singleton)) {
      return cmsJson("PATCH", `/api/models/${existing.id}`, {
        singleton: Boolean(definition.singleton),
      });
    }
    return existing;
  }
  return cmsJson("POST", "/api/models", definition);
}

export async function ensureField(modelId, definition) {
  const fields = await getExistingFieldMap(modelId);
  const existing = fields.get(definition.apiKey);
  if (existing) {
    if (definition.localized !== undefined && Boolean(existing.localized) !== Boolean(definition.localized)) {
      return cmsJson("PATCH", `/api/models/${modelId}/fields/${existing.id}`, {
        localized: Boolean(definition.localized),
      });
    }
    return existing;
  }
  return cmsJson("POST", `/api/models/${modelId}/fields`, definition);
}

export async function upsertRecord(modelApiKey, id, data, { publish = true, overrides } = {}) {
  const createResult = await cmsRequest("POST", "/api/records", {
    id,
    modelApiKey,
    data,
    ...(overrides ? { overrides } : {}),
  });

  if (!createResult.ok && createResult.status !== 409) {
    throw new Error(`POST /api/records failed (${createResult.status}): ${JSON.stringify(createResult.body)}`);
  }

  if (createResult.status === 409) {
    const patchResult = await cmsRequest("PATCH", `/api/records/${id}`, {
      modelApiKey,
      data,
      ...(overrides ? { overrides } : {}),
    });
    if (!patchResult.ok) {
      throw new Error(`PATCH /api/records/${id} failed (${patchResult.status}): ${JSON.stringify(patchResult.body)}`);
    }
  }

  if (publish) {
    const publishResult = await cmsRequest("POST", `/api/records/${id}/publish?modelApiKey=${modelApiKey}`);
    if (!publishResult.ok && publishResult.status !== 409) {
      throw new Error(`Publish ${modelApiKey}/${id} failed (${publishResult.status}): ${JSON.stringify(publishResult.body)}`);
    }
  }
}

export async function publishRecord(modelApiKey, id) {
  const publishResult = await cmsRequest("POST", `/api/records/${id}/publish?modelApiKey=${modelApiKey}`);
  if (!publishResult.ok && publishResult.status !== 409) {
    throw new Error(`Publish ${modelApiKey}/${id} failed (${publishResult.status}): ${JSON.stringify(publishResult.body)}`);
  }
}

export async function patchRecordOverrides(modelApiKey, id, overrides) {
  const patchResult = await cmsRequest("PATCH", `/api/records/${id}`, {
    modelApiKey,
    data: {},
    overrides,
  });
  if (!patchResult.ok) {
    throw new Error(`Patch overrides ${modelApiKey}/${id} failed (${patchResult.status}): ${JSON.stringify(patchResult.body)}`);
  }
}

export async function ensureAsset(asset) {
  if (!asset?.id) return;
  const upload = await datoGetUpload(asset.id).catch(() => null);
  const uploadMeta = upload?.attributes?.default_field_metadata?.[denormalizeCmsLocale(IMPORT_LOCALE)] ?? upload?.attributes?.default_field_metadata?.en ?? null;
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
    ...(Array.isArray(upload?.attributes?.colors) ? { colors: upload.attributes.colors.map((color) => `rgba(${color.red},${color.green},${color.blue},${color.alpha})`) } : {}),
    r2Key: `dato/${upload?.id ?? asset.id}/${upload?.attributes?.filename ?? asset.filename ?? "asset.bin"}`,
  };

  let uploaded = false;
  let reusedExisting = false;
  let uploadError = null;
  const sourceUrl = upload?.attributes?.url ?? asset.url ?? null;
  const existingObject = await headObjectInR2(metadata.r2Key).catch(() => null);
  const expectedSize = typeof metadata.size === "number" ? metadata.size : null;

  if (existingObject && expectedSize != null && existingObject.size === expectedSize) {
    reusedExisting = true;
    uploaded = true;
  } else if (typeof sourceUrl === "string" && sourceUrl.length > 0) {
    try {
      const assetResponse = await fetch(sourceUrl);
      if (assetResponse.ok) {
        const buffer = Buffer.from(await assetResponse.arrayBuffer());
        await putObjectInR2(metadata.r2Key, buffer, metadata.mimeType);
        const storedObject = await headObjectInR2(metadata.r2Key);
        if (storedObject == null || storedObject.size !== buffer.byteLength) {
          throw new Error(`Local R2 verification failed for ${metadata.r2Key}`);
        }
        uploaded = true;
      } else {
        uploadError = `Source asset fetch failed with status ${assetResponse.status}`;
      }
    } catch (error) {
      uploaded = false;
      uploadError = error instanceof Error ? error.message : String(error);
    }
  }

  const result = await cmsRequest("POST", "/api/assets", {
    ...metadata,
  });
  const duplicateAsset =
    result.status === 400 &&
    typeof result.body?.error === "string" &&
    result.body.error.includes("already exists");
  if (!result.ok && result.status !== 409 && !duplicateAsset) {
    throw new Error(`POST /api/assets failed (${result.status}): ${JSON.stringify(result.body)}`);
  }
  return { uploaded, metadataOnly: !uploaded, uploadError, reusedExisting };
}

export async function putObjectInR2(r2Key, buffer, contentType = "application/octet-stream") {
  const bucket = await getLocalR2Bucket();
  const bytes = toPlainUint8Array(buffer);
  await bucket.put(r2Key, bytes, {
    httpMetadata: {
      contentType,
    },
  });
}

export async function headObjectInR2(r2Key) {
  const bucket = await getLocalR2Bucket();
  return bucket.head(r2Key);
}

async function getLocalR2Bucket() {
  const context = await getLocalR2Context();
  return context.bucket;
}

async function getLocalR2Context() {
  localR2ContextPromise ??= createLocalR2Context();
  return localR2ContextPromise;
}

export async function disposeLocalR2Context() {
  if (!localR2ContextPromise) return;
  const context = await localR2ContextPromise.catch(() => null);
  localR2ContextPromise = undefined;
  if (!context?.mf) return;
  await context.mf.dispose();
}

async function createLocalR2Context() {
  registerLocalR2Cleanup();
  await mkdir(R2_PERSIST_DIR, { recursive: true });
  const wranglerConfig = await readFile(WRANGLER_CONFIG, "utf8");
  const workerScript = "export default { async fetch() { return new Response('ok') } };";
  const mf = new Miniflare({
    modules: true,
    script: workerScript,
    compatibilityDate: parseCompatibilityDate(wranglerConfig),
    compatibilityFlags: parseCompatibilityFlags(wranglerConfig),
    r2Buckets: ["ASSETS"],
    r2Persist: R2_PERSIST_DIR,
  });
  const bucket = await mf.getR2Bucket("ASSETS");
  return { mf, bucket };
}

function registerLocalR2Cleanup() {
  if (localR2CleanupRegistered) return;
  localR2CleanupRegistered = true;

  const cleanup = async () => {
    await disposeLocalR2Context();
  };

  process.once("beforeExit", () => {
    void cleanup();
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      void cleanup().finally(() => process.exit(0));
    });
  }
}

function parseCompatibilityDate(configText) {
  const match = configText.match(/"compatibility_date"\s*:\s*"([^"]+)"/);
  return match?.[1] ?? "2024-12-01";
}

function parseCompatibilityFlags(configText) {
  const match = configText.match(/"compatibility_flags"\s*:\s*\[(.*?)\]/s);
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function toPlainUint8Array(value) {
  if (value instanceof Uint8Array) {
    return Uint8Array.from(value);
  }
  return new Uint8Array(value);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function mapDatoBlockType(typename) {
  return typename.replace(/Record$/, "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

export function seoValue(seo) {
  if (!seo) return null;
  return {
    ...(seo.title == null ? {} : { title: seo.title }),
    ...(seo.description == null ? {} : { description: seo.description }),
  };
}

export function latLonValue(value) {
  if (!value) return null;
  return {
    latitude: value.latitude,
    longitude: value.longitude,
  };
}
