/**
 * Browser-safe asset URL helpers — Cloudflare Image Resizing.
 *
 * WHY HERE: this is the client-facing half of the generated surface. The
 * generated `contract.ts` is already the only module a browser imports from
 * this package (`procedures.ts` / `server-runtime.ts` are server-only and pull
 * in agent-cms's Effect service layer). Putting the helper in its own
 * `@agent-cms/codegen/assets` entry keeps it zero-dependency and importable
 * from a bundle that must never contain the CMS — while living next to the
 * `AssetRecord` / `MediaRead` types it operates on, so the two cannot drift.
 *
 * The CMS resolves a canonical absolute `url` on every asset row and on every
 * media / media_gallery value it returns; this module only *composes* on top of
 * that URL. It never invents an origin, so it works with the CMS's own
 * `/assets/:id/:filename` route as well as with a bucket custom domain.
 *
 * Cloudflare Image Resizing form (https://developers.cloudflare.com/images/):
 *
 *     https://host/cdn-cgi/image/<options>/<source path or absolute URL>
 *
 * Transforms are served by the zone the URL points at, so the asset host must
 * be a Cloudflare custom domain with Image Resizing enabled. Without any
 * options the source URL is returned unchanged — never a broken transform.
 */

/** Anything carrying a canonical `url`: an `AssetRecord`, a `MediaRead`, … */
export interface AssetUrlLike {
  readonly url: string;
}

export interface ImageTransform {
  readonly width?: number;
  readonly height?: number;
  readonly fit?: "scale-down" | "contain" | "cover" | "crop" | "pad";
  readonly format?: "auto" | "avif" | "webp" | "json" | "jpeg" | "png";
  readonly quality?: number;
  readonly dpr?: number;
  readonly gravity?: "auto" | "left" | "right" | "top" | "bottom" | "center" | { readonly x: number; readonly y: number };
  readonly background?: string;
  readonly blur?: number;
}

/** Ordered so the emitted URL is deterministic (and cache-friendly). */
const OPTION_ORDER: ReadonlyArray<keyof ImageTransform> = [
  "width",
  "height",
  "fit",
  "gravity",
  "format",
  "quality",
  "dpr",
  "blur",
  "background",
];

function optionValue(key: keyof ImageTransform, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === "string") {
    return value.length > 0 ? encodeURIComponent(value) : null;
  }
  if (key === "gravity" && typeof value === "object") {
    const x = Reflect.get(value, "x");
    const y = Reflect.get(value, "y");
    if (typeof x === "number" && typeof y === "number") return `${x}x${y}`;
  }
  return null;
}

/** `width=320,fit=cover,format=auto` — empty string when nothing is set. */
function encodeOptions(transform: ImageTransform | undefined): string {
  if (!transform) return "";
  const parts: string[] = [];
  for (const key of OPTION_ORDER) {
    const encoded = optionValue(key, transform[key]);
    if (encoded !== null) parts.push(`${key}=${encoded}`);
  }
  return parts.join(",");
}

function sourceUrl(asset: string | AssetUrlLike): string {
  return typeof asset === "string" ? asset : asset.url;
}

/**
 * Compose a Cloudflare Image Resizing URL for an asset.
 *
 * Accepts a full asset row / media value (anything with `url`) or a bare URL
 * string. Absolute URLs keep their origin and get `/cdn-cgi/image/<options>`
 * inserted at the root; relative URLs (the CMS's same-origin fallback) get the
 * prefix directly. Percent-encoding of the source path is normalized by the
 * URL parser, so filenames with spaces or `,` cannot corrupt the option list.
 *
 * ```ts
 * <img src={assetUrl(record.cover_image, { width: 320, fit: "cover", format: "auto" })} />
 * ```
 */
export function assetUrl(asset: string | AssetUrlLike, transform?: ImageTransform): string {
  const source = sourceUrl(asset);
  const options = encodeOptions(transform);
  if (options.length === 0) return source;

  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(source);
  if (!absolute) {
    const path = source.startsWith("/") ? source : `/${source}`;
    return `/cdn-cgi/image/${options}${encodePath(path)}`;
  }

  const parsed = tryParseUrl(source);
  if (!parsed) return source;
  return `${parsed.origin}/cdn-cgi/image/${options}${parsed.pathname}${parsed.search}`;
}

/**
 * `srcSet`-ready string for a set of widths:
 * `"<url> 320w, <url> 640w"`. Pass the same transform you'd give `assetUrl`;
 * `width` is overridden per entry.
 */
export function assetSrcSet(
  asset: string | AssetUrlLike,
  widths: ReadonlyArray<number>,
  transform?: Omit<ImageTransform, "width">,
): string {
  return widths
    .filter((width) => Number.isFinite(width) && width > 0)
    .map((width) => `${assetUrl(asset, { ...transform, width })} ${width}w`)
    .join(", ");
}

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Normalize a relative path's escaping the same way `new URL()` would. */
function encodePath(path: string): string {
  const parsed = tryParseUrl(`https://cdn.invalid${path.startsWith("/") ? path : `/${path}`}`);
  return parsed ? `${parsed.pathname}${parsed.search}` : path;
}
