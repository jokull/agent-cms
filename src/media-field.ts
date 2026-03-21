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
  if (typeof parsed === "string") {
    return parsed.length > 0 ? { uploadId: parsed } : null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const objectValue = parsed as Record<string, unknown>;
  const uploadId = typeof objectValue.upload_id === "string" ? objectValue.upload_id : null;
  if (!uploadId) return null;
  return {
    uploadId,
    alt: typeof objectValue.alt === "string" || objectValue.alt === null ? objectValue.alt : undefined,
    title: typeof objectValue.title === "string" || objectValue.title === null ? objectValue.title : undefined,
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
    tags: Array.isArray(decodeJsonStringOr(asset.tags, []))
      ? (decodeJsonStringOr(asset.tags, []) as unknown[]).filter((value): value is string => typeof value === "string")
      : [],
    url: assetUrl(asset.r2_key),
    _createdAt: asset.created_at,
    _updatedAt: asset.updated_at,
    _createdBy: asset.created_by,
    _updatedBy: asset.updated_by,
  };
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFocalPoint(value: unknown): value is { x: number; y: number } {
  return isJsonRecord(value)
    && typeof value.x === "number"
    && typeof value.y === "number";
}
