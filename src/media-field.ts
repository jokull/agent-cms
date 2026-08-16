import { isNumber, isObjectRecord, isString, stringArrayFrom } from "./dynamic/row-types.js";
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
  readonly customData?: Record<string, unknown> | null;
}

export function parseMediaFieldReference(value: unknown): MediaFieldReference | null {
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

export function parseMediaGalleryReferences(value: unknown): MediaFieldReference[] {
  const parsed = decodeJsonIfString(value);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((entry) => parseMediaFieldReference(entry))
    .filter((entry): entry is MediaFieldReference => entry !== null);
}

export function mergeAssetWithMediaReference(
  asset: AssetRow,
  reference: MediaFieldReference | null,
  assetUrl: (r2Key: string) => string,
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
    tags: stringArrayFrom(decodeJsonStringOr(asset.tags, [])),
    url: assetUrl(asset.r2_key),
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
 * How an absolute asset URL is resolved. Both members are optional; the
 * resolution order (documented once, here, and relied on by REST, RPC and the
 * record-read enrichment below) is:
 *
 *  1. `baseUrl` — the configured `ASSET_BASE_URL` (a bucket custom domain or
 *     CDN host serving R2 objects at their key path). Produces
 *     `<baseUrl>/<r2_key>`, byte-identical to what GraphQL already emits
 *     (`src/graphql/schema-builder.ts`), so the two surfaces cannot drift.
 *  2. `origin` — no base URL configured, but the caller knows the CMS's own
 *     origin (the HTTP router fills this in from the incoming request).
 *     Produces `<origin>/assets/<id>/<filename>`, the route the Worker serves
 *     from R2 (`src/http/router.ts`).
 *  3. Neither — an in-process library/test host with nothing configured.
 *     Produces the same-origin relative path `/assets/<id>/<filename>`.
 *
 * A URL is therefore ALWAYS produced; it is never null.
 */
export interface AssetUrlConfig {
  readonly baseUrl?: string | undefined;
  readonly origin?: string | undefined;
}

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
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export function resolveAssetUrl(asset: AssetUrlSource, config: AssetUrlConfig): string {
  if (config.baseUrl && config.baseUrl.length > 0) {
    return `${trimTrailingSlash(config.baseUrl)}/${asset.r2_key}`;
  }
  const path = `/assets/${encodeURIComponent(asset.id)}/${encodeURIComponent(asset.filename)}`;
  return config.origin && config.origin.length > 0 ? `${trimTrailingSlash(config.origin)}${path}` : path;
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
  readonly custom_data: Record<string, unknown> | null;
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
  readonly container: Record<string, unknown>;
  readonly key: string;
  readonly fieldType: "media" | "media_gallery" | "seo";
}

export function collectMediaSite(
  sites: MediaSite[] | undefined,
  container: Record<string, unknown>,
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
  const value = site.container[site.key];
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

    const enrichOne = (value: unknown): unknown => {
      const reference = parseMediaFieldReference(value);
      if (!reference) return value;
      const asset = byId.get(reference.uploadId);
      if (!asset) return value;
      return enrichReference(reference, asset, resolve(asset));
    };

    for (const site of sites) {
      const value = site.container[site.key];
      if (site.fieldType === "media") {
        site.container[site.key] = enrichOne(value);
        continue;
      }
      if (site.fieldType === "media_gallery") {
        const parsed = decodeJsonIfString(value);
        if (!Array.isArray(parsed)) continue;
        site.container[site.key] = parsed.map((entry) => enrichOne(entry));
        continue;
      }
      const parsed = decodeJsonIfString(value);
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
export function stripMediaEnrichment(fieldType: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (fieldType === "media") return stripOneMedia(value);
  if (fieldType === "media_gallery") {
    return Array.isArray(value) ? value.map((entry) => stripOneMedia(entry)) : value;
  }
  if (fieldType === "seo" && isObjectRecord(value) && SEO_ENRICHMENT_KEY in value) {
    const { [SEO_ENRICHMENT_KEY]: _dropped, ...rest } = value;
    return rest;
  }
  return value;
}

function stripOneMedia(value: unknown): unknown {
  if (!isObjectRecord(value)) return value;
  if (!isString(value.upload_id)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (MEDIA_ENRICHMENT_KEYS.includes(key)) continue;
    out[key] = entry;
  }
  return out;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return isObjectRecord(value);
}

function isFocalPoint(value: unknown): value is { x: number; y: number } {
  return isJsonRecord(value)
    && isNumber(value.x)
    && isNumber(value.y);
}
