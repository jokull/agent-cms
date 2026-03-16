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

/** Upload field name map for filter/order compilation */
const uploadFieldMap: Record<string, string> = {
  mimeType: "mime_type",
  _createdAt: "created_at",
};

/**
 * Build asset-related type defs, queries, and resolvers.
 */
export function buildAssetResolvers(ctx: SchemaBuilderContext): void {
  const { resolvers, typeDefs, queryFieldDefs, runSql, assetUrl, cfImageUrl, isProduction, locales } = ctx;

  // _site query - DatoCMS-compatible site info
  queryFieldDefs.push("_site: SiteInfo!");
  (resolvers.Query as Record<string, unknown>)._site = () => ({
    locales: locales.map((l) => l.code),
  });

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
      const params = (args?.transforms ?? args?.cfImagesParams ?? {}) as Record<string, unknown>;

      // Requested dimensions (fall back to original)
      const requestedW = (params.width ?? params.w ?? asset.width) as number;
      const requestedH = (params.height ?? params.h ?? null) as number | null;
      const fit = (params.fit ?? "scale-down") as string;
      const quality = (params.quality ?? params.q ?? null) as number | null;
      const format = (params.format ?? params.auto ?? "auto") as string;
      const gravity = (params.gravity ?? null) as string | null;

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
            alt: a.alt, title: a.title,
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
