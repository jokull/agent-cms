import { resolve } from "node:path";

import { createAgentCmsClient } from "../../core/agent-cms.mjs";
import { createDatoClient } from "../../core/datocms.mjs";
import { createLocalR2Client } from "../../core/local-r2.mjs";
import { getArg, writeJson as writeJsonToDir } from "../../core/runtime.mjs";

export const CMS_URL = process.env.CMS_URL ?? "http://127.0.0.1:8791";
export const DATOCMS_API_TOKEN = process.env.DATOCMS_API_TOKEN;
export const ACTIVE_LOCALES = ["en", "ko", "ja", "zh_CN", "es"];
export const IMPORT_LOCALE = process.env.IMPORT_LOCALE ?? "en";
export const OUT_DIR = resolve(process.cwd(), "scripts/dato-import/out/trip");
export const TRIP_MIGRATION_CMS_DIR = resolve(process.cwd(), "examples/trip-migration/cms");
export const R2_PERSIST_DIR = process.env.R2_PERSIST_DIR ?? resolve(TRIP_MIGRATION_CMS_DIR, ".wrangler/state-v3");
export const WRANGLER_CONFIG = process.env.WRANGLER_CONFIG ?? resolve(TRIP_MIGRATION_CMS_DIR, "wrangler.jsonc");

if (!DATOCMS_API_TOKEN) {
  throw new Error("DATOCMS_API_TOKEN is required");
}

const dato = createDatoClient({ token: DATOCMS_API_TOKEN });
const cms = createAgentCmsClient({ cmsUrl: CMS_URL });
const localR2 = createLocalR2Client({
  persistDir: R2_PERSIST_DIR,
  wranglerConfigPath: WRANGLER_CONFIG,
  bucketBindingName: "ASSETS",
});

export function normalizeDatoLocale(code) {
  if (!code) return code;
  return code.replace(/-/g, "_");
}

export function denormalizeCmsLocale(code) {
  if (!code) return code;
  return code.replace(/_/g, "-");
}

export async function writeJson(filename, value) {
  return writeJsonToDir(OUT_DIR, filename, value);
}

export { getArg };

export const datoQuery = dato.query;
export const datoCmaRequest = dato.cmaRequest;
export const datoListItemsByType = dato.listItemsByType;
export const datoGetItem = dato.getItem;
export const datoGetItems = dato.getItems;
export const datoGetItemTypes = dato.getItemTypes;
export const datoGetItemTypeApiKey = dato.getItemTypeApiKey;
export const datoGetUpload = dato.getUpload;
export const datoGetUploads = dato.getUploads;
export const datoGetSite = dato.getSite;

export const cmsRequest = cms.request;
export const listModels = cms.listModels;
export const listFields = cms.listFields;
export const listLocales = cms.listLocales;
export const ensureLocale = cms.ensureLocale;
export const ensureModel = cms.ensureModel;
export const ensureField = cms.ensureField;
export const upsertRecord = cms.upsertRecord;
export const publishRecord = cms.publishRecord;
export const patchRecordOverrides = cms.patchRecordOverrides;

export async function ensureAsset(asset) {
  if (!asset?.id) return;
  const upload = await datoGetUpload(asset.id).catch(() => null);
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
      ? { colors: upload.attributes.colors.map((color) => `rgba(${color.red},${color.green},${color.blue},${color.alpha})`) }
      : {}),
    r2Key: `dato/${upload?.id ?? asset.id}/${upload?.attributes?.filename ?? asset.filename ?? "asset.bin"}`,
  };

  let uploaded = false;
  let reusedExisting = false;
  let uploadError = null;
  const sourceUrl = upload?.attributes?.url ?? asset.url ?? null;
  const existingObject = await localR2.headObject(metadata.r2Key).catch(() => null);
  const expectedSize = typeof metadata.size === "number" ? metadata.size : null;

  if (existingObject && expectedSize != null && existingObject.size === expectedSize) {
    reusedExisting = true;
    uploaded = true;
  } else if (typeof sourceUrl === "string" && sourceUrl.length > 0) {
    try {
      const assetResponse = await fetch(sourceUrl);
      if (assetResponse.ok) {
        const buffer = Buffer.from(await assetResponse.arrayBuffer());
        await localR2.putObject(metadata.r2Key, buffer, metadata.mimeType);
        const storedObject = await localR2.headObject(metadata.r2Key);
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

  const result = await cmsRequest("POST", "/api/assets", metadata);
  const duplicateAsset =
    result.status === 400 &&
    typeof result.body?.error === "string" &&
    result.body.error.includes("already exists");
  if (!result.ok && result.status !== 409 && !duplicateAsset) {
    throw new Error(`POST /api/assets failed (${result.status}): ${JSON.stringify(result.body)}`);
  }
  return { uploaded, metadataOnly: !uploaded, uploadError, reusedExisting };
}

export async function disposeLocalR2Context() {
  await localR2.dispose();
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
