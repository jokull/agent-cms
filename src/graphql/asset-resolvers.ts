/**
 * Build asset-related resolvers: allUploads, _allUploadsMeta,
 * Asset.responsiveImage, SeoField.image, ColorField.hex.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import type { AssetRow } from "../db/row-types.js";
import { compileFilterToSql, compileOrderBy } from "./filter-compiler.js";
import { UPLOAD_TYPE_DEFS } from "./sdl-constants.js";
import type { SchemaBuilderContext, DynamicRow, AssetObject } from "./gql-types.js";
import { decodeJsonIfString, decodeJsonStringOr } from "../json.js";

function parseCustomData(value: string | null): Record<string, string> | null {
  if (!value) return null;
  const parsed = decodeJsonStringOr(value, null);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed).filter(([, entryValue]) => typeof entryValue === "string");
  return Object.fromEntries(entries);
}

function coerceStringListValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  return [];
}

/**
 * Legacy DatoCMS/imgix compatibility shim.
 * This only translates the small subset of imgix-style params used by the
 * migrated frontend into Cloudflare Image Resizing equivalents.
 * It is intentionally best-effort, not a full imgix emulation layer.
 */
function normalizeImgixParams(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // Dimensions: imgix uses w/h, CF uses width/height
  if (raw.w != null) out.width = raw.w;
  if (raw.h != null) out.height = raw.h;
  if (raw.width != null) out.width = raw.width;
  if (raw.height != null) out.height = raw.height;

  // Format: imgix auto=format → CF format=auto
  const autoValues = Array.isArray(raw.auto)
    ? raw.auto.filter((entry): entry is string => typeof entry === "string")
    : coerceStringListValue(raw.auto);
  if (
    autoValues.includes("format") ||
    autoValues.join(",") === "compress,format" ||
    autoValues.join(",") === "format,compress"
  ) {
    out.format = "auto";
  } else if (raw.format != null) {
    out.format = raw.format;
  }

  // Quality
  if (raw.q != null) out.quality = raw.q;
  if (raw.quality != null) out.quality = raw.quality;

  // Fit + gravity mapping
  const fit = raw.fit as string | undefined;
  if (fit === "facearea") {
    out.fit = "cover";
    out.gravity = "face";
  } else if (fit === "crop") {
    out.fit = "cover";
    // Preserve gravity if set, otherwise auto for saliency-based crop
    out.gravity = raw.gravity ?? "auto";
  } else if (fit === "clip" || fit === "max") {
    out.fit = "contain";
  } else if (fit === "fill") {
    out.fit = "pad";
  } else if (fit === "scale") {
    out.fit = "scale-down";
  } else if (fit != null) {
    out.fit = fit; // Pass through CF-native values
  }

  // Gravity passthrough (face, auto, left, right, top, bottom)
  if (raw.gravity != null && !out.gravity) out.gravity = raw.gravity;

  // DPR
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

  // facepad → zoom (CF face gravity zoom: 0=tight, 1=wide; imgix facepad: 1=tight, higher=wider)
  // Approximate inverse mapping
  if (raw.facepad != null && out.gravity === "face") {
    const facepad = Number(raw.facepad);
    // facepad 1.0 → zoom ~1.0 (tight), facepad 10 → zoom ~0.1 (wide)
    if (facepad > 0) out.zoom = Math.max(0, Math.min(1, 1 / facepad));
  }

  return out;
}

type RunSqlFn = SchemaBuilderContext["runSql"];

function pickLocalizedSiteValue(rawValue: unknown, locale?: string | null, fallbackLocales: string[] = []) {
  if (rawValue == null) return null;
  const localeMap = decodeJsonIfString(rawValue);
  if (typeof localeMap !== "object" || localeMap === null || Array.isArray(localeMap)) {
    return rawValue;
  }

  const values = localeMap as Record<string, unknown>;
  if (locale && values[locale] !== undefined && values[locale] !== null && values[locale] !== "") {
    return values[locale];
  }
  for (const fallback of fallbackLocales) {
    if (values[fallback] !== undefined && values[fallback] !== null && values[fallback] !== "") {
      return values[fallback];
    }
  }
  const [_, firstValue] = Object.entries(values)[0] ?? [null, null];
  return firstValue ?? null;
}

/** Generate favicon meta tags from a favicon asset */
async function buildFaviconMetaTags(runSql: RunSqlFn, faviconId: string) {
  const asset = await runSql(
    Effect.gen(function* () {
      const s = yield* SqlClient.SqlClient;
      const rows = yield* s.unsafe<AssetRow>("SELECT * FROM assets WHERE id = ?", [faviconId]);
      return rows.length > 0 ? rows[0] : null;
    })
  );
  if (!asset) return [];

  const tags: Array<{ tag: string; attributes: Record<string, string> | null; content: string | null }> = [];
  const url = `/assets/${asset.id}/${asset.filename}`;

  // Standard favicon link
  tags.push({ tag: "link", attributes: { rel: "icon", type: asset.mime_type, href: url }, content: null });

  // Apple touch icon (if image is large enough)
  if (asset.width && asset.width >= 180) {
    tags.push({ tag: "link", attributes: { rel: "apple-touch-icon", sizes: "180x180", href: url }, content: null });
  }

  // MS application tile
  tags.push({ tag: "meta", attributes: { name: "msapplication-TileImage", content: url }, content: null });

  return tags;
}

/** Upload field name map for filter/order compilation */
const uploadFieldMap: Record<string, string> = {
  mimeType: "mime_type",
  _createdAt: "created_at",
};

/**
 * Build asset-related type defs, queries, and resolvers.
 */
export function buildAssetResolvers(ctx: SchemaBuilderContext): void {
  const { resolvers, typeDefs, queryFieldDefs, runSql, assetUrl, cfImageUrl, locales } = ctx;

  // _site query - DatoCMS-compatible site info with globalSeo and faviconMetaTags
  queryFieldDefs.push("_site: SiteInfo!");
  (resolvers.Query)._site = async (_parent: unknown, args: DynamicRow, context: DynamicRow) => {
    // Load site settings from DB (returns defaults if table/row doesn't exist)
    const settings = await runSql(
      Effect.gen(function* () {
        const s = yield* SqlClient.SqlClient;
        const tableRows = yield* s.unsafe<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          ["site_settings"]
        );
        if (tableRows.length === 0) return null;
        const rows = yield* s.unsafe<Record<string, unknown>>('SELECT * FROM "site_settings" LIMIT 1');
        return rows.length > 0 ? rows[0] : null;
      })
    );

    const locale = typeof args.locale === "string" ? args.locale : (context.locale as string | undefined) ?? null;
    const fallbackLocales = Array.isArray(args.fallbackLocales)
      ? (args.fallbackLocales as string[])
      : Array.isArray(context.fallbackLocales)
        ? (context.fallbackLocales as string[])
        : [];
    const fallbackSeo = settings
      ? {
          title: pickLocalizedSiteValue(settings.fallback_seo_title, locale, fallbackLocales) as string | null,
          description: pickLocalizedSiteValue(settings.fallback_seo_description, locale, fallbackLocales) as string | null,
          twitterCard: pickLocalizedSiteValue(settings.fallback_seo_twitter_card, locale, fallbackLocales) as string | null,
          image: pickLocalizedSiteValue(settings.fallback_seo_image_id, locale, fallbackLocales) as string | null,
        }
      : null;
    const hasFallbackSeo = fallbackSeo !== null
      && (fallbackSeo.title !== null
        || fallbackSeo.description !== null
        || fallbackSeo.twitterCard !== null
        || fallbackSeo.image !== null);

    return {
      locales: locales.map((l) => l.code),
      noIndex: settings?.no_index === 1 || settings?.no_index === true || false,
      faviconMetaTags: settings?.favicon_id ? await buildFaviconMetaTags(runSql, settings.favicon_id as string) : [],
      globalSeo: settings ? {
        siteName: pickLocalizedSiteValue(settings.site_name, locale, fallbackLocales) as string | null,
        titleSuffix: pickLocalizedSiteValue(settings.title_suffix, locale, fallbackLocales) as string | null,
        facebookPageUrl: pickLocalizedSiteValue(settings.facebook_page_url, locale, fallbackLocales) as string | null,
        twitterAccount: pickLocalizedSiteValue(settings.twitter_account, locale, fallbackLocales) as string | null,
        fallbackSeo: hasFallbackSeo ? fallbackSeo : null,
      } : null,
    };
  };

  // Upload types
  typeDefs.push(UPLOAD_TYPE_DEFS);

  queryFieldDefs.push("allUploads(filter: UploadFilter, orderBy: [UploadOrderBy!], first: Int, skip: Int): [Asset!]!");
  queryFieldDefs.push("_allUploadsMeta(filter: UploadFilter): UploadMeta!");

  (resolvers.Query).allUploads = async (_: unknown, args: DynamicRow) => {
    return await runSql(
      Effect.gen(function* () {
        const s = yield* SqlClient.SqlClient;
        let query = `SELECT * FROM assets`;
        let params: unknown[] = [];
        const compiled = compileFilterToSql(args.filter as DynamicRow | undefined, { fieldNameMap: uploadFieldMap });
        if (compiled) { query += ` WHERE ${compiled.where}`; params = compiled.params; }
        const orderBy = compileOrderBy(args.orderBy as string[] | undefined, { fieldNameMap: uploadFieldMap });
        if (orderBy) query += ` ORDER BY ${orderBy}`;
        const limit = Math.min((args.first as number | undefined) ?? 20, 500);
        query += ` LIMIT ?`; params.push(limit);
        if (args.skip) { query += ` OFFSET ?`; params.push(args.skip); }
        const rows = yield* s.unsafe<AssetRow>(query, params);
        return rows.map((a): AssetObject => ({
          id: a.id, filename: a.filename, mimeType: a.mime_type,
          size: a.size, width: a.width, height: a.height,
          alt: a.alt, title: a.title, blurhash: a.blurhash ?? null,
          customData: parseCustomData(a.custom_data),
          url: assetUrl(a.id, a.filename),
          _createdAt: a.created_at,
          _updatedAt: a.updated_at,
          _createdBy: a.created_by,
          _updatedBy: a.updated_by,
        }));
      })
    );
  };

  (resolvers.Query)._allUploadsMeta = async (_: unknown, args: DynamicRow) => {
    return {
      count: await runSql(
        Effect.gen(function* () {
          const s = yield* SqlClient.SqlClient;
          let query = `SELECT COUNT(*) as count FROM assets`;
          let params: unknown[] = [];
          const compiled = compileFilterToSql(args.filter as DynamicRow | undefined, { fieldNameMap: uploadFieldMap });
          if (compiled) { query += ` WHERE ${compiled.where}`; params = compiled.params; }
          const rows = yield* s.unsafe<{ count: number }>(query, params);
          return rows[0]?.count ?? 0;
        })
      ),
    };
  };

  // Asset.responsiveImage resolver
  resolvers.Asset = {
    responsiveImage: (asset: AssetObject, args: DynamicRow) => {
      if (!asset.width || !asset.height) return null;
      // Accept transforms (native), cfImagesParams (alias), or imgixParams (legacy migration shim)
      const rawParams = (args.transforms ?? args.cfImagesParams ?? args.imgixParams ?? {}) as Record<string, unknown>;
      const params = args.imgixParams ? normalizeImgixParams(rawParams) : rawParams;

      // Requested dimensions (fall back to original)
      const requestedW = (params.width ?? params.w ?? asset.width) as number;
      const requestedH = (params.height ?? params.h ?? null) as number | null;
      const fit = (params.fit ?? "scale-down") as string;
      const quality = (params.quality ?? params.q ?? null) as number | null;
      const format = (params.format ?? params.auto ?? "auto") as string;
      const gravity = (params.gravity ?? null) as string | null;
      const zoom = (params.zoom ?? null) as number | null;
      const background = (params.background ?? null) as string | null;
      const blur = (params.blur ?? null) as number | null;
      const sharpen = (params.sharpen ?? null) as number | null;
      const rotate = (params.rotate ?? null) as number | null;
      const anim = (params.anim ?? null) as boolean | null;
      const trim = (params.trim ?? null) as Record<string, unknown> | null;

      // Compute output dimensions
      const origW = asset.width;
      const origH = asset.height;
      const aspect = origW / origH;
      const outW = Math.min(requestedW, origW);
      const outH = requestedH ? Math.min(requestedH, origH) : Math.round(outW / aspect);
      const outAspect = outW / outH;

      const baseAssetPath = `/assets/${asset.id}/${asset.filename}`;

      // Build transform URL using Cloudflare Image Resizing (production) or query params (dev)
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
        if (trim && typeof trim === "object") {
          if (trim.top != null) p.trim = `border`;
          for (const key of ["top", "right", "bottom", "left", "width", "height"] as const) {
            const value = trim[key];
            if (typeof value === "number") p[`trim.${key}`] = value;
          }
        }
        return cfImageUrl(baseAssetPath, p);
      }

      // Generate srcSet at standard breakpoints, capped at output width
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
        base64: asset.blurhash ?? null, // TODO: convert blurhash to base64 data URI
        bgColor: null,
        sizes: `(max-width: ${outW}px) 100vw, ${outW}px`,
      };
    },
  };

  // SeoField.image resolver: look up asset by ID
  resolvers.SeoField = {
    image: async (seo: DynamicRow) => {
      const assetId = seo.image;
      if (!assetId) return null;
      return await runSql(
        Effect.gen(function* () {
          const s = yield* SqlClient.SqlClient;
          const rows = yield* s.unsafe<AssetRow>("SELECT * FROM assets WHERE id = ?", [assetId]);
          if (rows.length === 0) return null;
          const a = rows[0];
          return {
            id: a.id, filename: a.filename, mimeType: a.mime_type,
            size: a.size, width: a.width, height: a.height,
            alt: a.alt, title: a.title, customData: parseCustomData(a.custom_data),
            url: assetUrl(a.id, a.filename),
            _createdAt: a.created_at,
            _updatedAt: a.updated_at,
            _createdBy: a.created_by,
            _updatedBy: a.updated_by,
          };
        })
      );
    },
  };

  // ColorField.hex resolver: compute hex from RGB
  resolvers.ColorField = {
    hex: (color: DynamicRow) => {
      const r = (color.red ?? 0) as number;
      const g = (color.green ?? 0) as number;
      const b = (color.blue ?? 0) as number;
      return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    },
  };
}
