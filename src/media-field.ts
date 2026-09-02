import { isNumber, isObjectRecord, isString, stringArrayFrom, type DynamicRow, type StoredFieldValue } from "./dynamic/row-types.js";
import { Context, Effect, Option } from "effect";

import { SqlClient } from "effect/unstable/sql";
import { decodeJsonIfString, decodeJsonStringOr } from "./json.js";
import type { AssetRow } from "./db/row-types.js";
import type { AssetObject } from "./graphql/gql-types.js";


export interface MediaFieldReference {
  readonly uploadId: string;
  readonly alt?: string | null;
  readonly title?: string | null;
  readonly focalPoint?: { x: number; y: number } | null;
  readonly customData?: DynamicRow | null;
}

export function parseMediaFieldReference(value: StoredFieldValue): MediaFieldReference | null {
  const parsed = decodeJsonIfString(value);
  if (isString(parsed)) {
    return parsed.length > 0 ? { uploadId: parsed } : null;
  }
  if (!isObjectRecord(parsed)) return null;
  const objectValue = parsed;
  const uploadId = isString(objectValue.upload_id) ? objectValue.upload_id : null;
  if (!uploadId) return null;
  return {
    uploadId,
    alt: isString(objectValue.alt) || objectValue.alt === null ? objectValue.alt : undefined,
    title: isString(objectValue.title) || objectValue.title === null ? objectValue.title : undefined,
    focalPoint: isFocalPoint(objectValue.focal_point) || objectValue.focal_point === null ? objectValue.focal_point ?? null : undefined,
    customData: isJsonRecord(objectValue.custom_data) || objectValue.custom_data === null ? objectValue.custom_data ?? null : undefined,
  };
}

export function parseMediaGalleryReferences(value: StoredFieldValue): MediaFieldReference[] {
  const parsed = decodeJsonIfString(value);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((entry: StoredFieldValue) => parseMediaFieldReference(entry))
    .filter((entry): entry is MediaFieldReference => entry !== null);
}

export function mergeAssetWithMediaReference(
  asset: AssetRow,
  reference: MediaFieldReference | null,
  assetUrl: (asset: AssetUrlSource) => string,
): AssetObject {
  const defaultCustomData = asset.custom_data ? decodeJsonStringOr(asset.custom_data, null) : null;
  const defaultFocalPoint = asset.focal_point ? decodeJsonStringOr(asset.focal_point, null) : null;

  return {
    id: asset.id,
    filename: asset.filename,
    mimeType: asset.mime_type,
    size: asset.size,
    width: asset.width,
    height: asset.height,
    alt: reference?.alt ?? asset.alt,
    title: reference?.title ?? asset.title,
    blurhash: asset.blurhash ?? null,
    focalPoint: isFocalPoint(reference?.focalPoint)
      ? reference.focalPoint
      : (isFocalPoint(defaultFocalPoint) ? defaultFocalPoint : null),
    customData: isJsonRecord(reference?.customData)
      ? reference.customData
      : (isJsonRecord(defaultCustomData) ? defaultCustomData : null),
    // SAFETY: a missing/invalid tags JSON decodes to the empty array, a StoredFieldValue per the json contract.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- fallback literal for an absent tags cell; the union bridge is the honest typed default.
    tags: stringArrayFrom(decodeJsonStringOr(asset.tags, [] as unknown as StoredFieldValue)),
    url: assetUrl(asset),
    _createdAt: asset.created_at,
    _updatedAt: asset.updated_at,
    _createdBy: asset.created_by,
    _updatedBy: asset.updated_by,
  };
}

// ===========================================================================
// Canonical asset URLs
// ===========================================================================

/**
 * How an absolute asset URL is resolved. Two storage kinds:
 *
 *  - **Hosted image rows** (`image_id` + `image_delivery_base` set, r2_key
 *    empty) resolve to the Cloudflare Images delivery URL
 *    `<image_delivery_base>/<image_id>/<variant>` — self-contained, no config
 *    needed (the base is the account's imagedelivery.net hash, persisted at
 *    registration).
 *  - **File rows** (stored in R2) resolve per the ambient config below:
 *
 *   1. `baseUrl` — the configured `ASSET_BASE_URL` (a bucket custom domain or
 *      CDN host serving R2 objects at their key path). Produces
 *      `<baseUrl>/<r2_key>`, byte-identical to what GraphQL already emits
 *      (`src/graphql/schema-builder.ts`), so the two surfaces cannot drift.
 *   2. `origin` — no base URL configured, but the caller knows the CMS's own
 *      origin (the HTTP router fills this in from the incoming request).
 *      Produces `<origin>/assets/<id>/<filename>`, the route the Worker serves
 *      from R2 (`src/http/router.ts`).
 *   3. Neither — an in-process library/test host with nothing configured.
 *      Produces the same-origin relative path `/assets/<id>/<filename>`.
 *
 * A URL is therefore ALWAYS produced; it is never null.
 */
export interface AssetUrlConfig {
  readonly baseUrl?: string | undefined;
  readonly origin?: string | undefined;
}

/** Variant name agent-cms resolves hosted-image delivery URLs against. */
export const IMAGE_DELIVERY_VARIANT = "public";

/**
 * Optional service carrying the asset-URL configuration. Read with
 * `Effect.serviceOption`, so every existing call site keeps working without
 * providing it (falling back to rule 3 above) — no service acquires a new
 * requirement in its `R` channel.
 *
 * The value is a getter rather than a plain struct because the HTTP handler
 * builds its layer once per Worker but only learns the request origin per
 * request.
 */
export class AssetUrlContext extends Context.Service<
  AssetUrlContext,
  { readonly current: () => AssetUrlConfig }
>()("AssetUrlContext") {}

/** The minimum an asset row needs for URL resolution. */
export interface AssetUrlSource {
  readonly id: string;
  readonly filename: string;
  readonly r2_key: string;
  readonly image_id?: string | null;
  readonly image_delivery_base?: string | null;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export function resolveAssetUrl(asset: AssetUrlSource, config: AssetUrlConfig): string {
  if (asset.image_id && asset.image_delivery_base) {
    // Hosted-image row: self-contained Cloudflare Images delivery URL.
    return `${trimTrailingSlash(asset.image_delivery_base)}/${asset.image_id}/${IMAGE_DELIVERY_VARIANT}`;
  }
  if (config.baseUrl && config.baseUrl.length > 0) {
    return `${trimTrailingSlash(config.baseUrl)}/${asset.r2_key}`;
  }
  const path = `/assets/${encodeURIComponent(asset.id)}/${encodeURIComponent(asset.filename)}`;
  return config.origin && config.origin.length > 0 ? `${trimTrailingSlash(config.origin)}${path}` : path;
}

/** Bind a URL config into a row resolver — the shared choke point read surfaces use. */
export function assetUrlResolverFor(config: AssetUrlConfig): (asset: AssetUrlSource) => string {
  return (asset) => resolveAssetUrl(asset, config);
}

/** Whether a URL is a Cloudflare Images delivery URL (imagedelivery.net / images.dev). */
export function isHostedDeliveryUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "imagedelivery.net"
      || host.endsWith(".imagedelivery.net")
      || host === "images.dev"
      || host.endsWith(".images.dev");
  } catch {
    return false;
  }
}

/** A resolver closed over the ambient config (absent → relative-path fallback). */
export const assetUrlResolver: Effect.Effect<(asset: AssetUrlSource) => string> = Effect.map(
  Effect.serviceOption(AssetUrlContext),
  (service) => {
    const config = Option.match(service, {
      onNone: (): AssetUrlConfig => ({}),
      onSome: (accessor) => accessor.current(),
    });
    return (asset: AssetUrlSource) => resolveAssetUrl(asset, config);
  },
);

/** An asset row as every read surface returns it: the row plus its canonical URL. */
export type AssetRowWithUrl = AssetRow & { readonly url: string };

export function withAssetUrl(asset: AssetRow): Effect.Effect<AssetRowWithUrl> {
  return Effect.map(assetUrlResolver, (resolve) => ({ ...asset, url: resolve(asset) }));
}

export function withAssetUrls(assets: ReadonlyArray<AssetRow>): Effect.Effect<AssetRowWithUrl[]> {
  return Effect.map(assetUrlResolver, (resolve) => assets.map((asset) => ({ ...asset, url: resolve(asset) })));
}

// ===========================================================================
// Media values in record reads
// ===========================================================================

/**
 * The read shape of a `media` field value (and of every `media_gallery`
 * entry): the stored reference merged with the asset row it points at.
 *
 * `upload_id` is preserved, so the value is still accepted verbatim as a write
 * input (`MediaFieldObjectSchema`); the resolved keys below are READ-ONLY and
 * are stripped again on write by `stripMediaEnrichment`, making
 * read-modify-write lossless.
 *
 * `alt` / `title` / `focal_point` / `custom_data` follow the same precedence
 * GraphQL uses (`mergeAssetWithMediaReference`): the reference's override wins,
 * otherwise the asset's own value.
 */
export interface EnrichedMediaValue {
  readonly upload_id: string;
  readonly url: string;
  readonly filename: string;
  readonly mime_type: string;
  readonly size: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly alt: string | null;
  readonly title: string | null;
  readonly focal_point: { x: number; y: number } | null;
  readonly custom_data: DynamicRow | null;
  readonly blurhash: string | null;
}

/** Keys the read enrichment adds; not part of the write vocabulary. */
export const MEDIA_ENRICHMENT_KEYS: ReadonlyArray<string> = [
  "url",
  "filename",
  "mime_type",
  "size",
  "width",
  "height",
  "blurhash",
];

/** The key SEO enrichment adds alongside the (unchanged) `image` asset id. */
export const SEO_ENRICHMENT_KEY = "image_url";

export function isAssetFieldType(fieldType: string): fieldType is "media" | "media_gallery" | "seo" {
  return fieldType === "media" || fieldType === "media_gallery" || fieldType === "seo";
}

function enrichReference(
  reference: MediaFieldReference,
  asset: AssetRow,
  url: string,
): EnrichedMediaValue {
  const defaultFocalPoint = asset.focal_point ? decodeJsonStringOr(asset.focal_point, null) : null;
  const defaultCustomData = asset.custom_data ? decodeJsonStringOr(asset.custom_data, null) : null;
  return {
    upload_id: reference.uploadId,
    url,
    filename: asset.filename,
    mime_type: asset.mime_type,
    size: asset.size,
    width: asset.width,
    height: asset.height,
    alt: reference.alt ?? asset.alt,
    title: reference.title ?? asset.title,
    focal_point: isFocalPoint(reference.focalPoint)
      ? reference.focalPoint
      : (isFocalPoint(defaultFocalPoint) ? defaultFocalPoint : null),
    custom_data: isJsonRecord(reference.customData)
      ? reference.customData
      : (isJsonRecord(defaultCustomData) ? defaultCustomData : null),
    blurhash: asset.blurhash,
  };
}

/**
 * One place in a materialized record (or block payload) holding a media /
 * media_gallery / seo value that should be enriched. Collected while records
 * are materialized, then resolved in ONE batched query — see
 * `enrichMediaSites`.
 */
export interface MediaSite {
  readonly container: DynamicRow;
  readonly key: string;
  readonly fieldType: "media" | "media_gallery" | "seo";
}

export function collectMediaSite(
  sites: MediaSite[] | undefined,
  container: DynamicRow,
  key: string,
  fieldType: string,
): void {
  if (!sites) return;
  if (!isAssetFieldType(fieldType)) return;
  const value = container[key];
  if (value === null || value === undefined) return;
  sites.push({ container, key, fieldType });
}

function siteAssetIds(site: MediaSite): string[] {
  // SAFETY: media site cells hold StoredFieldValue (id string, reference object, or JSON string).
  const value = site.container[site.key] as StoredFieldValue;
  if (site.fieldType === "media") {
    const reference = parseMediaFieldReference(value);
    return reference ? [reference.uploadId] : [];
  }
  if (site.fieldType === "media_gallery") {
    return parseMediaGalleryReferences(value).map((reference) => reference.uploadId);
  }
  const parsed = decodeJsonIfString(value);
  if (isObjectRecord(parsed) && isString(parsed.image) && parsed.image.length > 0) {
    return [parsed.image];
  }
  return [];
}

/**
 * Resolve every collected media site against the assets table with a SINGLE
 * `WHERE id IN (...)` query for the whole record set — no per-field and no
 * per-record lookup (the N+1 the admin proof would otherwise force on hosts).
 * Sites whose asset row is missing (a dangling reference) are left untouched.
 */
export function enrichMediaSites(sites: ReadonlyArray<MediaSite>): Effect.Effect<void, never, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    if (sites.length === 0) return;
    const ids = new Set<string>();
    for (const site of sites) {
      for (const id of siteAssetIds(site)) ids.add(id);
    }
    if (ids.size === 0) return;

    const sql = yield* SqlClient.SqlClient;
    const idList = Array.from(ids);
    const placeholders = idList.map(() => "?").join(", ");
    const rows = yield* sql.unsafe<AssetRow>(
      `SELECT * FROM assets WHERE id IN (${placeholders})`,
      idList,
    ).pipe(Effect.orDie);
    const byId = new Map(rows.map((row) => [row.id, row] as const));
    const resolve = yield* assetUrlResolver;

    const enrichOne = (value: StoredFieldValue): StoredFieldValue | EnrichedMediaValue => {
      const reference = parseMediaFieldReference(value);
      if (!reference) return value;
      const asset = byId.get(reference.uploadId);
      if (!asset) return value;
      return enrichReference(reference, asset, resolve(asset));
    };

    for (const site of sites) {
      const value = site.container[site.key];
      if (site.fieldType === "media") {
        // SAFETY: media field cell values are StoredFieldValue (id string or reference object).
        site.container[site.key] = enrichOne(value as StoredFieldValue);
        continue;
      }
      if (site.fieldType === "media_gallery") {
        // SAFETY: media_gallery field cell values are StoredFieldValue (JSON string or entry array).
        const parsed = decodeJsonIfString(value as StoredFieldValue);
        if (!Array.isArray(parsed)) continue;
        site.container[site.key] = parsed.map((entry: StoredFieldValue) => enrichOne(entry));
        continue;
      }
      // SAFETY: seo field cell values are StoredFieldValue (JSON string or object).
      const parsed = decodeJsonIfString(value as StoredFieldValue);
      if (!isObjectRecord(parsed)) continue;
      const imageId = isString(parsed.image) ? parsed.image : null;
      const asset = imageId ? byId.get(imageId) : undefined;
      site.container[site.key] = { ...parsed, [SEO_ENRICHMENT_KEY]: asset ? resolve(asset) : null };
    }
  });
}

/**
 * Remove the read-only keys the enrichment adds, so a value read from the CMS
 * can be written straight back without persisting a stale URL or a stale copy
 * of the asset's metadata. A bare id string passes through untouched.
 */
export function stripMediaEnrichment(fieldType: string, value: StoredFieldValue | undefined): StoredFieldValue | StoredFieldValue[] | undefined {
  if (value === null || value === undefined) return value;
  if (fieldType === "media") return stripOneMedia(value);
  if (fieldType === "media_gallery") {
    return Array.isArray(value) ? value.map((entry: StoredFieldValue) => stripOneMedia(entry)) : value;
  }
  if (fieldType === "seo" && isObjectRecord(value) && SEO_ENRICHMENT_KEY in value) {
    const { [SEO_ENRICHMENT_KEY]: _dropped, ...rest } = value;
    return rest;
  }
  return value;
}

function stripOneMedia(value: StoredFieldValue): StoredFieldValue {
  if (!isObjectRecord(value)) return value;
  if (!isString(value.upload_id)) return value;
  const out: DynamicRow = {};
  for (const [key, entry] of Object.entries(value)) {
    if (MEDIA_ENRICHMENT_KEYS.includes(key)) continue;
    out[key] = entry;
  }
  return out;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- type guard: must accept opaque values to narrow them.
function isJsonRecord(value: unknown): value is DynamicRow {
  return isObjectRecord(value);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- type guard: must accept opaque values to narrow them.
function isFocalPoint(value: unknown): value is { x: number; y: number } {
  return isJsonRecord(value)
    && isNumber(value.x)
    && isNumber(value.y);
}
