/**
 * Build asset-related resolvers: allUploads, _allUploadsMeta,
 * Asset.responsiveImage, SeoField.image, ColorField.hex.
 */
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { AssetRow } from "../db/row-types.js";
import { compileFilterToSql, compileOrderBy } from "./filter-compiler.js";
import { UPLOAD_TYPE_DEFS } from "./sdl-constants.js";
import type { SchemaBuilderContext, GqlContext, AssetObject } from "./gql-types.js";
import type { DynamicRow } from "../dynamic/row-types.js";
import { loadAsset } from "./asset-loader.js";
import { decodeJsonIfString } from "../json.js";
import { mergeAssetWithMediaReference } from "../media-field.js";
import { buildResponsiveImage } from "./responsive-image.js";
import { normalizeImgixParams } from "./responsive-image.js";
import { isObjectRecord, stringArrayFrom } from "../dynamic/row-types.js";

type RunSqlFn = SchemaBuilderContext["runSql"];

function pickLocalizedSiteValue(rawValue: unknown, locale?: string | null, fallbackLocales: string[] = []) {
  if (rawValue == null) return null;
  const localeMap = decodeJsonIfString(rawValue);
  if (!isObjectRecord(localeMap)) {
    return rawValue;
  }

  if (locale && localeMap[locale] !== undefined && localeMap[locale] !== null && localeMap[locale] !== "") {
    return localeMap[locale];
  }
  for (const fallback of fallbackLocales) {
    if (localeMap[fallback] !== undefined && localeMap[fallback] !== null && localeMap[fallback] !== "") {
      return localeMap[fallback];
    }
  }
  const [_, firstValue] = Object.entries(localeMap)[0] ?? [null, null];
  return firstValue ?? null;
}

function pickLocalizedSiteString(rawValue: unknown, locale?: string | null, fallbackLocales: string[] = []) {
  const value = pickLocalizedSiteValue(rawValue, locale, fallbackLocales);
  return typeof value === "string" ? value : null;
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
const uploadFieldMap = {
  basename: "basename",
  format: "format",
  mimeType: "mime_type",
  _createdAt: "created_at",
} satisfies Record<string, string>;

function getAssetBasename(filename: string) {
  const lastDot = filename.lastIndexOf(".");
  return lastDot > 0 ? filename.slice(0, lastDot) : filename;
}

function getAssetFormat(asset: AssetObject) {
  const lastDot = asset.filename.lastIndexOf(".");
  if (lastDot > 0 && lastDot < asset.filename.length - 1) {
    return asset.filename.slice(lastDot + 1).toLowerCase();
  }
  const mimeSubtype = asset.mimeType.split("/")[1] ?? "bin";
  return mimeSubtype.toLowerCase();
}

function buildAssetUrl(
  asset: AssetObject,
  args: DynamicRow,
  cfImageUrl: (assetPath: string, params: Record<string, string | number>) => string,
) {
  const rawParamsValue = args.transforms ?? args.cfImagesParams ?? args.imgixParams;
  const rawParams = isObjectRecord(rawParamsValue) ? rawParamsValue : undefined;
  if (!rawParams || Object.keys(rawParams).length === 0) return asset.url;

  const params = args.imgixParams ? normalizeImgixParams(rawParams) : rawParams;
  const queryParams: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" || typeof value === "number") {
      queryParams[key] = value;
    }
  }

  let assetPath: string;
  try {
    assetPath = new URL(asset.url).pathname;
  } catch {
    assetPath = asset.url.startsWith("/") ? asset.url : `/${asset.url}`;
  }

  return cfImageUrl(assetPath, queryParams);
}

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

    const locale = typeof args.locale === "string" ? args.locale : typeof context.locale === "string" ? context.locale : null;
    const argFallbackLocales = stringArrayFrom(args.fallbackLocales);
    const fallbackLocales = argFallbackLocales.length > 0 ? argFallbackLocales : stringArrayFrom(context.fallbackLocales);
    const fallbackSeo = settings
      ? {
          title: pickLocalizedSiteString(settings.fallback_seo_title, locale, fallbackLocales),
          description: pickLocalizedSiteString(settings.fallback_seo_description, locale, fallbackLocales),
          twitterCard: pickLocalizedSiteString(settings.fallback_seo_twitter_card, locale, fallbackLocales),
          image: pickLocalizedSiteString(settings.fallback_seo_image_id, locale, fallbackLocales),
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
      faviconMetaTags: typeof settings?.favicon_id === "string" ? await buildFaviconMetaTags(runSql, settings.favicon_id) : [],
      globalSeo: settings ? {
        siteName: pickLocalizedSiteString(settings.site_name, locale, fallbackLocales),
        titleSuffix: pickLocalizedSiteString(settings.title_suffix, locale, fallbackLocales),
        facebookPageUrl: pickLocalizedSiteString(settings.facebook_page_url, locale, fallbackLocales),
        twitterAccount: pickLocalizedSiteString(settings.twitter_account, locale, fallbackLocales),
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
        const compiled = compileFilterToSql(isObjectRecord(args.filter) ? args.filter : undefined, { fieldNameMap: uploadFieldMap });
        if (compiled) { query += ` WHERE ${compiled.where}`; params = compiled.params; }
        const orderByArg = stringArrayFrom(args.orderBy);
        const orderBy = compileOrderBy(orderByArg.length > 0 ? orderByArg : undefined, { fieldNameMap: uploadFieldMap });
        if (orderBy) query += ` ORDER BY ${orderBy}`;
        const limit = Math.min(typeof args.first === "number" ? args.first : 20, 500);
        query += ` LIMIT ?`; params.push(limit);
        if (typeof args.skip === "number" && args.skip > 0) { query += ` OFFSET ?`; params.push(args.skip); }
        const rows = yield* s.unsafe<AssetRow>(query, params);
        return rows.map((a): AssetObject => ({
          ...mergeAssetWithMediaReference(a, null, assetUrl),
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
          const compiled = compileFilterToSql(isObjectRecord(args.filter) ? args.filter : undefined, { fieldNameMap: uploadFieldMap });
          if (compiled) { query += ` WHERE ${compiled.where}`; params = compiled.params; }
          const rows = yield* s.unsafe<{ count: number }>(query, params);
          return rows[0]?.count ?? 0;
        })
      ),
    };
  };

  // Asset.responsiveImage resolver
  resolvers.Asset = {
    basename: (asset: AssetObject) => getAssetBasename(asset.filename),
    format: (asset: AssetObject) => getAssetFormat(asset),
    url: (asset: AssetObject, args: DynamicRow) => buildAssetUrl(asset, args, cfImageUrl),
    tags: (asset: AssetObject) => asset.tags,
    smartTags: (asset: AssetObject) => asset.tags,
    responsiveImage: (asset: AssetObject, args: DynamicRow) => buildResponsiveImage(asset, args, cfImageUrl),
  };

  // SeoField.image resolver: look up asset by ID
  resolvers.SeoField = {
    image: async (seo: DynamicRow, _args: unknown, context: GqlContext) => {
      const assetId = seo.image;
      if (typeof assetId !== "string") return null;
      const a = await loadAsset({ runSql, id: assetId, context });
      return a ? mergeAssetWithMediaReference(a, null, assetUrl) : null;
    },
  };

  // ColorField.hex resolver: compute hex from RGB
  resolvers.ColorField = {
    hex: (color: DynamicRow) => {
      const r = typeof color.red === "number" ? color.red : 0;
      const g = typeof color.green === "number" ? color.green : 0;
      const b = typeof color.blue === "number" ? color.blue : 0;
      return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    },
  };
}
