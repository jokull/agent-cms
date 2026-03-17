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

/**
 * Map imgix params to Cloudflare Image Resizing equivalents.
 * CF supports: width, height, fit (scale-down|contain|cover|crop|pad), gravity (auto|face|left|...),
 * quality, format (auto|webp|avif|json), dpr, sharpen, blur, background, rotate, trim.
 * imgix fit values: crop→cover, facearea→cover+gravity:face, clip→contain, fill→pad, scale→scale-down.
 */
function normalizeImgixParams(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // Dimensions: imgix uses w/h, CF uses width/height
  if (raw.w != null) out.width = raw.w;
  if (raw.h != null) out.height = raw.h;
  if (raw.width != null) out.width = raw.width;
  if (raw.height != null) out.height = raw.height;

  // Format: imgix auto=format → CF format=auto
  if (raw.auto === "format" || raw.auto === "compress,format" || raw.auto === "format,compress") {
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
  let localeMap = rawValue;
  if (typeof localeMap === "string") {
    try {
      localeMap = JSON.parse(localeMap);
    } catch {
      return rawValue;
    }
  }
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
  (resolvers.Query as Record<string, unknown>)._site = async (_parent: unknown, args: DynamicRow, context: DynamicRow) => {
    // Load site settings from DB (returns defaults if table/row doesn't exist)
    const settings = await runSql(
      Effect.gen(function* () {
        const s = yield* SqlClient.SqlClient;
        const tableRows = yield* s.unsafe<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          ["content_site_settings"]
        );
        if (tableRows.length === 0) return null;
        const rows = yield* s.unsafe<Record<string, unknown>>('SELECT * FROM "content_site_settings" LIMIT 1');
        return rows.length > 0 ? rows[0] : null;
      })
    );

    const locale = typeof args?.locale === "string" ? args.locale : (context?.locale as string | undefined) ?? null;
    const fallbackLocales = Array.isArray(args?.fallbackLocales)
      ? (args.fallbackLocales as string[])
      : Array.isArray(context?.fallbackLocales)
        ? (context.fallbackLocales as string[])
        : [];
    const fallbackSeo = pickLocalizedSiteValue(settings?.fallback_seo, locale, fallbackLocales) as Record<string, unknown> | null;

    return {
      locales: locales.map((l) => l.code),
      noIndex: settings?.no_index === 1 || settings?.no_index === true || false,
      faviconMetaTags: settings?.favicon ? await buildFaviconMetaTags(runSql, settings.favicon as string) : [],
      globalSeo: settings ? {
        siteName: pickLocalizedSiteValue(settings.site_name, locale, fallbackLocales) as string | null,
        titleSuffix: pickLocalizedSiteValue(settings.title_suffix, locale, fallbackLocales) as string | null,
        facebookPageUrl: pickLocalizedSiteValue(settings.facebook_page_url, locale, fallbackLocales) as string | null,
        twitterAccount: pickLocalizedSiteValue(settings.twitter_account, locale, fallbackLocales) as string | null,
        fallbackSeo: fallbackSeo ? {
          title: fallbackSeo.title ?? null,
          description: fallbackSeo.description ?? null,
          twitterCard: fallbackSeo.twitterCard ?? null,
          image: fallbackSeo.image ?? null,
        } : null,
      } : null,
    };
  };

  // Upload types
  typeDefs.push(UPLOAD_TYPE_DEFS);

  queryFieldDefs.push("allUploads(filter: UploadFilter, orderBy: [UploadOrderBy!], first: Int, skip: Int): [Asset!]!");
  queryFieldDefs.push("_allUploadsMeta(filter: UploadFilter): UploadMeta!");

  (resolvers.Query as Record<string, unknown>).allUploads = async (_: unknown, args: DynamicRow) => {
    return await runSql(
      Effect.gen(function* () {
        const s = yield* SqlClient.SqlClient;
        let query = `SELECT * FROM assets`;
        let params: unknown[] = [];
        const compiled = compileFilterToSql(args.filter as DynamicRow | undefined, { fieldNameMap: uploadFieldMap });
        if (compiled) { query += ` WHERE ${compiled.where}`; params = compiled.params; }
        const orderBy = compileOrderBy(args.orderBy as string[] | undefined, { fieldNameMap: uploadFieldMap });
        if (orderBy) query += ` ORDER BY ${orderBy}`;
        const limit = Math.min((args.first as number) ?? 20, 500);
        query += ` LIMIT ?`; params.push(limit);
        if (args.skip) { query += ` OFFSET ?`; params.push(args.skip); }
        const rows = yield* s.unsafe<AssetRow>(query, params);
        return rows.map((a): AssetObject => ({
          id: a.id, filename: a.filename, mimeType: a.mime_type,
          size: a.size, width: a.width, height: a.height,
          alt: a.alt, title: a.title, blurhash: a.blurhash ?? null,
          customData: a.custom_data ? JSON.parse(a.custom_data) : null,
          url: assetUrl(a.id, a.filename),
        }));
      })
    );
  };

  (resolvers.Query as Record<string, unknown>)._allUploadsMeta = async (_: unknown, args: DynamicRow) => {
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
      // Accept transforms (native), cfImagesParams (alias), or imgixParams (DatoCMS compat)
      const rawParams = (args?.transforms ?? args?.cfImagesParams ?? args?.imgixParams ?? {}) as Record<string, unknown>;
      const params = args?.imgixParams ? normalizeImgixParams(rawParams) : rawParams;

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
      const assetId = seo?.image;
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
            alt: a.alt, title: a.title, customData: a.custom_data ? JSON.parse(a.custom_data) : null,
            url: assetUrl(a.id, a.filename),
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
