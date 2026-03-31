/**
 * Shared asset payload helpers used by generic-import.mjs and the asset
 * priority-queue worker.
 */

/**
 * Extracts a normalised asset descriptor from a DatoCMS upload reference
 * (the object stored in a `file` or `gallery` field value).
 *
 * @param {{ upload_id?: string, alt?: string|null, title?: string|null, focal_point?: object|null }} value
 * @returns {{ id: string, alt: string|null, title: string|null, focalPoint: object|null } | null}
 */
export function assetFromUploadRef(value) {
  if (!value?.upload_id) return null;
  return {
    id: value.upload_id,
    alt: value.alt ?? null,
    title: value.title ?? null,
    focalPoint: value.focal_point ?? null,
  };
}

/**
 * Builds the metadata payload and resolves the source URL from a DatoCMS
 * upload object + a field-level asset descriptor.
 *
 * @param {object|null} upload   - Full DatoCMS upload object (from CMA or export snapshot), may be null.
 * @param {{ id: string, alt?: string|null, title?: string|null, focalPoint?: object|null, filename?: string, mimeType?: string, size?: number, width?: number, height?: number, blurhash?: string, url?: string }} asset - Field-level asset descriptor.
 * @param {string} locale        - Normalised locale code used to look up default_field_metadata.
 * @returns {{ metadata: object, sourceUrl: string|null }}
 */
export function buildAssetPayload(upload, asset, locale) {
  // Dato uses hyphenated locales in default_field_metadata; our internal locale
  // may use underscores, so try both.
  const denormalized = locale ? locale.replace(/_/g, "-") : locale;
  const uploadMeta =
    upload?.attributes?.default_field_metadata?.[denormalized] ??
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

  return { metadata, sourceUrl };
}
