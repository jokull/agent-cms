import { isBoolean, isNumber, isObject, isObjectRecord, isString, type StoredFieldValue } from "../dynamic/row-types.js";
import type { AssetObject } from "./gql-types.js";

import type { DynamicRow } from "../dynamic/row-types.js";


function coerceStringListValue(value: StoredFieldValue): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => isString(entry));
  }
  if (isString(value)) return [value];
  if (isNumber(value) || isBoolean(value)) return [String(value)];
  return [];
}

export function normalizeImgixParams(raw: DynamicRow): DynamicRow {
  const out: DynamicRow = {};

  if (raw.w != null) out.width = raw.w;
  if (raw.h != null) out.height = raw.h;
  if (raw.width != null) out.width = raw.width;
  if (raw.height != null) out.height = raw.height;

  // SAFETY: imgix `auto` is a scalar or a scalar list (StoredFieldValue);
  // the array branch above handles lists, so a non-array reaches the coercer.
  const autoValues = Array.isArray(raw.auto)
    ? raw.auto.filter((entry): entry is string => isString(entry))
    : coerceStringListValue(raw.auto as StoredFieldValue);
  if (
    autoValues.includes("format") ||
    autoValues.join(",") === "compress,format" ||
    autoValues.join(",") === "format,compress"
  ) {
    out.format = "auto";
  } else if (raw.format != null) {
    out.format = raw.format;
  }

  if (raw.q != null) out.quality = raw.q;
  if (raw.quality != null) out.quality = raw.quality;

  const fit = isString(raw.fit) ? raw.fit : undefined;
  if (fit === "facearea") {
    out.fit = "cover";
    out.gravity = "face";
  } else if (fit === "crop") {
    out.fit = "cover";
    out.gravity = raw.gravity ?? "auto";
  } else if (fit === "clip" || fit === "max") {
    out.fit = "contain";
  } else if (fit === "fill") {
    out.fit = "pad";
  } else if (fit === "scale") {
    out.fit = "scale-down";
  } else if (fit != null) {
    out.fit = fit;
  }

  if (raw.gravity != null && !out.gravity) out.gravity = raw.gravity;
  if (raw.dpr != null) out.dpr = raw.dpr;
  if (raw.blur != null) out.blur = raw.blur;
  if (raw.sharpen != null) out.sharpen = raw.sharpen;
  if (raw.rot != null) out.rotate = raw.rot;
  if (raw.rotate != null) out.rotate = raw.rotate;
  if (raw.bg != null) out.background = raw.bg;
  if (raw.background != null) out.background = raw.background;
  if (raw.trim != null) out.trim = raw.trim;
  if (raw.maxW != null && out.width == null) out.width = raw.maxW;
  if (raw.maxH != null && out.height == null) out.height = raw.maxH;

  if (raw.facepad != null && out.gravity === "face") {
    const facepad = Number(raw.facepad);
    if (facepad > 0) out.zoom = Math.max(0, Math.min(1, 1 / facepad));
  }

  return out;
}

export function buildResponsiveImage(
  asset: AssetObject,
  args: DynamicRow,
  cfImageUrl: (assetPath: string, params: Record<string, string | number>) => string,
) {
  if (!asset.width || !asset.height) return null;

  const rawParamsValue = args.transforms ?? args.cfImagesParams ?? args.imgixParams;
  const rawParams = isObjectRecord(rawParamsValue) ? rawParamsValue : {};
  const params = args.imgixParams ? normalizeImgixParams(rawParams) : rawParams;

  const requestedW = isNumber(params.width)
    ? params.width
    : isNumber(params.w)
      ? params.w
      : asset.width;
  const requestedH = isNumber(params.height)
    ? params.height
    : isNumber(params.h)
      ? params.h
      : null;
  const fit = isString(params.fit) ? params.fit : "scale-down";
  const quality = isNumber(params.quality)
    ? params.quality
    : isNumber(params.q)
      ? params.q
      : null;
  const format = isString(params.format)
    ? params.format
    : isString(params.auto)
      ? params.auto
      : "auto";
  let gravity = isString(params.gravity) ? params.gravity : null;
  if (!gravity && asset.focalPoint) {
    gravity = `${asset.focalPoint.x}x${asset.focalPoint.y}`;
  }
  const zoom = isNumber(params.zoom) ? params.zoom : null;
  const background = isString(params.background) ? params.background : null;
  const blur = isNumber(params.blur) ? params.blur : null;
  const sharpen = isNumber(params.sharpen) ? params.sharpen : null;
  const rotate = isNumber(params.rotate) ? params.rotate : null;
  const anim = isBoolean(params.anim) ? params.anim : null;
  const trim = isObjectRecord(params.trim) ? params.trim : null;

  const origW = asset.width;
  const origH = asset.height;
  const aspect = origW / origH;
  const outW = Math.min(requestedW, origW);
  const outH = requestedH ? Math.min(requestedH, origH) : Math.round(outW / aspect);
  const outAspect = outW / outH;

  let baseAssetPath: string;
  try {
    baseAssetPath = new URL(asset.url).pathname;
  } catch {
    baseAssetPath = asset.url.startsWith("/") ? asset.url : `/${asset.url}`;
  }

  function transformUrl(targetWidth: number, targetFormat?: string): string {
    const p: Record<string, string | number> = { width: targetWidth, fit };
    if (requestedH) p.height = Math.round(targetWidth / outAspect);
    if (quality) p.quality = quality;
    const fmt = targetFormat ?? format;
    if (fmt) p.format = fmt;
    if (gravity) p.gravity = gravity;
    if (zoom != null) p.zoom = zoom;
    if (background) p.background = background;
    if (blur != null) p.blur = blur;
    if (sharpen != null) p.sharpen = sharpen;
    if (rotate != null) p.rotate = rotate;
    if (anim != null) p.anim = anim ? "true" : "false";
    if (trim && isObject(trim)) {
      if (trim.top != null) p.trim = "border";
      for (const key of ["top", "right", "bottom", "left", "width", "height"] as const) {
        const value = trim[key];
        if (isNumber(value)) p[`trim.${key}`] = value;
      }
    }
    return cfImageUrl(baseAssetPath, p);
  }

  const breakpoints = [320, 640, 960, 1200, 1600, 2560].filter((sw) => sw <= outW);
  if (!breakpoints.includes(outW)) breakpoints.push(outW);
  breakpoints.sort((a, b) => a - b);

  const srcSet = breakpoints.map((sw) => `${transformUrl(sw)} ${sw}w`).join(", ");
  const webpSrcSet = breakpoints.map((sw) => `${transformUrl(sw, "webp")} ${sw}w`).join(", ");

  return {
    src: transformUrl(outW),
    srcSet,
    webpSrcSet,
    width: outW,
    height: outH,
    aspectRatio: outAspect,
    alt: asset.alt ?? null,
    title: asset.title ?? null,
    base64: asset.blurhash ?? null,
    bgColor: null,
    sizes: `(max-width: ${outW}px) 100vw, ${outW}px`,
  };
}
