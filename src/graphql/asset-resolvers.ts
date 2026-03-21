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
import { decodeJsonIfString } from "../json.js";
import { mergeAssetWithMediaReference } from "../media-field.js";
import { buildResponsiveImage } from "./responsive-image.js";
import { normalizeImgixParams } from "./responsive-image.js";

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
  basename: "basename",
  format: "format",
  mimeType: "mime_type",
  _createdAt: "created_at",
};

function getAssetBasename(filename: string) {
  const lastDot = filename.lastIndexOf(".");
  return lastDot > 0 ? filename.slice(0, lastDot) : filename;
}

function getAssetFormat(asset: AssetObject) {
  const lastDot = asset.filename.lastIndexOf(".");
  if (lastDot > 0 && lastDot < asset.filename.length - 1) {
    return asset.filename.slice(lastDot + 1).toLowerCase();
  }
  const mimeSubtype = asset.mimeType.split("/")[1];
  return mimeSubtype?.toLowerCase() ?? "bin";
}

function buildAssetUrl(
  asset: AssetObject,
  args: DynamicRow,
  cfImageUrl: (assetPath: string, params: Record<string, string | number>) => string,
) {
  const rawParams = (args.transforms ?? args.cfImagesParams ?? args.imgixParams) as Record<string, unknown> | undefined;
  if (!rawParams || Object.keys(rawParams).length === 0) return asset.url;

  const params = args.imgixParams ? normalizeImgixParams(rawParams) : rawParams;
  const queryParams = Object.fromEntries(
    Object.entries(params)
      .filter(([, value]) => typeof value === "string" || typeof value === "number")
      .map(([key, value]) => [key, value as string | number]),
  );

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
    basename: (asset: AssetObject) => getAssetBasename(asset.filename),
    format: (asset: AssetObject) => getAssetFormat(asset),
    url: (asset: AssetObject, args: DynamicRow) => buildAssetUrl(asset, args, cfImageUrl),
    tags: (asset: AssetObject) => asset.tags,
    smartTags: (asset: AssetObject) => asset.tags,
    responsiveImage: (asset: AssetObject, args: DynamicRow) => buildResponsiveImage(asset, args, cfImageUrl),
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
          return mergeAssetWithMediaReference(a, null, assetUrl);
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
