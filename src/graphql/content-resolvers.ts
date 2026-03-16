/**
 * Build GraphQL types and field resolvers for content models.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import type { AssetRow } from "../db/row-types.js";
import { getLinkTargets, getLinksTargets, computeIsValid } from "../db/validators.js";
import { extractBlockIds, extractInlineBlockIds, extractLinkIds } from "../dast/index.js";
import type { SchemaBuilderContext, ModelQueryMeta, DynamicRow, GqlContext, AssetObject, DastDocInput } from "./gql-types.js";
import { toTypeName, toCamelCase, fieldToSDL, getRegistryDef, deserializeRecord } from "./gql-utils.js";

/**
 * Build content model types and field resolvers.
 * Returns per-model metadata needed by query and reverse-ref resolvers.
 */
export function buildContentModelResolvers(
  ctx: SchemaBuilderContext,
  structuredTextFieldTypes: Map<string, string>
): ModelQueryMeta[] {
  const {
    models, blockModels, fieldsByModelId, typeNames,
    resolvers, typeDefs, runSql, assetUrl, defaultLocale,
  } = ctx;

  const modelMetas: ModelQueryMeta[] = [];

  for (const model of models) {
    const fields = fieldsByModelId.get(model.id) ?? [];
    const typeName = typeNames.get(model.api_key)!;
    const tableName = `content_${model.api_key}`;

    // Build camelCase <-> snake_case mappings for this model's fields
    const camelToSnake = new Map<string, string>();
    for (const f of fields) {
      camelToSnake.set(toCamelCase(f.api_key), f.api_key);
    }

    // Object type
    const fieldDefs = [
      "id: ID!", "_modelApiKey: String!", "_status: String", "_isValid: Boolean!", "_createdAt: String", "_updatedAt: String",
      "_publishedAt: String", "_firstPublishedAt: String", "_seoMetaTags: [Tag!]!",
    ];
    if (model.sortable || model.tree) {
      fieldDefs.push("_position: Int");
    }
    if (model.tree) {
      fieldDefs.push(`_parent: ${typeName}`);
      fieldDefs.push("_parentId: ID");
      fieldDefs.push(`_children: [${typeName}!]!`);
    }
    for (const f of fields) {
      // Use per-field StructuredText type if available, otherwise fall back to fieldToSDL
      const stKey = `${model.api_key}.${f.api_key}`;
      const stFieldType = structuredTextFieldTypes.get(stKey);
      const gqlType = stFieldType ?? fieldToSDL(f.field_type, f.validators, typeNames);
      fieldDefs.push(`${toCamelCase(f.api_key)}: ${gqlType}`);
    }

    // Track localized fields by camelCase name (for filter compilation)
    const localizedCamelKeys = new Set<string>();
    for (const f of fields) {
      if (f.localized) localizedCamelKeys.add(toCamelCase(f.api_key));
    }
    if (localizedCamelKeys.size > 0) {
      fieldDefs.push("_locales: [String!]!");
    }

    // _all<Field>Locales for each localized field
    for (const f of fields) {
      if (!f.localized) continue;
      const pascalKey = toTypeName(f.api_key);
      const mlDef = getRegistryDef(f.field_type);
      const multiLocaleType = mlDef?.multiLocaleType ?? "StringMultiLocaleField";
      fieldDefs.push(`_all${pascalKey}Locales: [${multiLocaleType}!]!`);
    }

    typeDefs.push(`type ${typeName} {\n  ${fieldDefs.join("\n  ")}\n}`);

    // Link resolvers
    const typeResolvers: Record<string, unknown> = {};
    // Map _created_at -> _createdAt etc.
    typeResolvers._modelApiKey = () => model.api_key;
    typeResolvers._createdAt = (p: DynamicRow) => p._created_at;
    typeResolvers._updatedAt = (p: DynamicRow) => p._updated_at;
    typeResolvers._publishedAt = (p: DynamicRow) => p._published_at;
    typeResolvers._firstPublishedAt = (p: DynamicRow) => p._first_published_at;
    typeResolvers._isValid = (parent: DynamicRow) => computeIsValid(parent, fields, defaultLocale).valid;

    // _seoMetaTags resolver: auto-generate meta tags from seo field or heuristic field selection
    const seoField = fields.find((f) => f.field_type === "seo");
    const firstStringField = fields.find((f) => f.field_type === "string");
    const firstTextField = fields.find((f) => f.field_type === "text");
    const firstMediaField = fields.find((f) => f.field_type === "media");

    typeResolvers._seoMetaTags = async (parent: DynamicRow) => {
      const tags: Array<{ tag: string; attributes: Record<string, string> | null; content: string | null }> = [];

      // Extract SEO data from seo field or heuristic fields
      let title: string | null = null;
      let description: string | null = null;
      let imageUrl: string | null = null;
      let twitterCard: string | null = null;

      if (seoField) {
        let seo = parent[seoField.api_key];
        if (typeof seo === "string") { try { seo = JSON.parse(seo); } catch { seo = null; } }
        if (seo && typeof seo === "object") {
          const seoObj = seo as DynamicRow;
          title = (seoObj.title as string) ?? null;
          description = (seoObj.description as string) ?? null;
          twitterCard = (seoObj.twitterCard as string) ?? null;
          if (seoObj.image) {
            // Resolve image URL from asset ID
            const asset = await runSql(
              Effect.gen(function* () {
                const s = yield* SqlClient.SqlClient;
                const rows = yield* s.unsafe<AssetRow>("SELECT * FROM assets WHERE id = ?", [seoObj.image]);
                return rows.length > 0 ? rows[0] : null;
              })
            );
            if (asset) imageUrl = assetUrl(asset.id, asset.filename);
          }
        }
      }

      // Fallback to heuristic fields
      if (!title && firstStringField) title = (parent[firstStringField.api_key] as string) ?? null;
      if (!description && firstTextField) description = (parent[firstTextField.api_key] as string) ?? null;
      if (!imageUrl && firstMediaField && parent[firstMediaField.api_key]) {
        const assetId = parent[firstMediaField.api_key] as string;
        const asset = await runSql(
          Effect.gen(function* () {
            const s = yield* SqlClient.SqlClient;
            const rows = yield* s.unsafe<AssetRow>("SELECT * FROM assets WHERE id = ?", [assetId]);
            return rows.length > 0 ? rows[0] : null;
          })
        );
        if (asset) imageUrl = assetUrl(asset.id, asset.filename);
      }

      // Generate tags
      if (title) {
        tags.push({ tag: "title", attributes: null, content: title });
        tags.push({ tag: "meta", attributes: { property: "og:title", content: title }, content: null });
        tags.push({ tag: "meta", attributes: { name: "twitter:title", content: title }, content: null });
      }
      if (description) {
        tags.push({ tag: "meta", attributes: { name: "description", content: description }, content: null });
        tags.push({ tag: "meta", attributes: { property: "og:description", content: description }, content: null });
        tags.push({ tag: "meta", attributes: { name: "twitter:description", content: description }, content: null });
      }
      if (imageUrl) {
        tags.push({ tag: "meta", attributes: { property: "og:image", content: imageUrl }, content: null });
        tags.push({ tag: "meta", attributes: { name: "twitter:image", content: imageUrl }, content: null });
      }
      tags.push({ tag: "meta", attributes: { property: "og:type", content: "article" }, content: null });
      tags.push({ tag: "meta", attributes: { name: "twitter:card", content: twitterCard ?? "summary" }, content: null });
      if (parent._updated_at) {
        tags.push({ tag: "meta", attributes: { property: "article:modified_time", content: parent._updated_at as string }, content: null });
      }

      return tags;
    };
    if (model.sortable || model.tree) {
      typeResolvers._position = (p: DynamicRow) => (p._position as number) ?? 0;
    }
    if (model.tree) {
      typeResolvers._parentId = (p: DynamicRow) => (p._parent_id as string) ?? null;
      typeResolvers._parent = async (parent: DynamicRow) => {
        const parentId = parent._parent_id;
        if (!parentId) return null;
        return await runSql(
          Effect.gen(function* () {
            const s = yield* SqlClient.SqlClient;
            const rows = yield* s.unsafe<DynamicRow>(
              `SELECT * FROM "${tableName}" WHERE id = ?`, [parentId]
            );
            return rows.length > 0 ? deserializeRecord(rows[0]) : null;
          })
        );
      };
      typeResolvers._children = async (parent: DynamicRow) => {
        return await runSql(
          Effect.gen(function* () {
            const s = yield* SqlClient.SqlClient;
            const rows = yield* s.unsafe<DynamicRow>(
              `SELECT * FROM "${tableName}" WHERE "_parent_id" = ? ORDER BY "_position" ASC`, [parent.id]
            );
            return rows.map(deserializeRecord);
          })
        );
      };
    }

    // _locales resolver: returns locale codes where record has content
    if (localizedCamelKeys.size > 0) {
      typeResolvers._locales = (parent: DynamicRow) => {
        const foundLocales = new Set<string>();
        for (const camelKey of localizedCamelKeys) {
          const dbKey = camelToSnake.get(camelKey) ?? camelKey;
          let localeMap = parent[dbKey];
          if (!localeMap) continue;
          if (typeof localeMap === "string") {
            try { localeMap = JSON.parse(localeMap); } catch { continue; }
          }
          if (typeof localeMap === "object" && localeMap !== null) {
            for (const [locale, value] of Object.entries(localeMap as Record<string, unknown>)) {
              if (value !== null && value !== undefined && value !== "") {
                foundLocales.add(locale);
              }
            }
          }
        }
        return [...foundLocales];
      };
    }

    // _all<Field>Locales resolvers
    for (const f of fields) {
      if (!f.localized) continue;
      const pascalKey = toTypeName(f.api_key);
      const resolverName = `_all${pascalKey}Locales`;
      typeResolvers[resolverName] = (parent: DynamicRow) => {
        let localeMap = parent[f.api_key];
        if (!localeMap) return [];
        if (typeof localeMap === "string") {
          try { localeMap = JSON.parse(localeMap); } catch { return []; }
        }
        if (typeof localeMap !== "object" || localeMap === null) return [];
        return Object.entries(localeMap as Record<string, unknown>)
          .filter(([, value]) => value !== null && value !== undefined)
          .map(([locale, value]) => ({ locale, value }));
      };
    }

    // Localized field resolvers: extract value for requested locale
    for (const f of fields) {
      const locDef = getRegistryDef(f.field_type);
      if (f.localized && locDef?.localizable) {
        typeResolvers[toCamelCase(f.api_key)] = (parent: DynamicRow, _args: unknown, context: GqlContext) => {
          const rawValue = parent[f.api_key];
          if (rawValue === null || rawValue === undefined) return null;

          // Parse JSON if needed
          let localeMap = rawValue;
          if (typeof localeMap === "string") {
            try { localeMap = JSON.parse(localeMap); } catch { return rawValue; }
          }
          if (typeof localeMap !== "object" || localeMap === null) return rawValue;

          const locMap = localeMap as Record<string, unknown>;
          // Resolve locale: query arg > context > default
          const locale = context?.locale ?? defaultLocale;
          const fallbacks = context?.fallbackLocales ?? [];

          // Try primary locale
          if (locale && locMap[locale] !== undefined && locMap[locale] !== null && locMap[locale] !== "") {
            return locMap[locale];
          }
          // Try fallbacks
          for (const fb of fallbacks) {
            if (locMap[fb] !== undefined && locMap[fb] !== null && locMap[fb] !== "") {
              return locMap[fb];
            }
          }
          // Try default locale as final fallback
          if (defaultLocale && locMap[defaultLocale] !== undefined) {
            return locMap[defaultLocale];
          }
          // Return first available value
          const values = Object.values(locMap);
          return values.length > 0 ? values[0] : null;
        };
      }
    }

    // --- Batch resolution helpers (reduces N+1 to 1 query per field per record) ---

    /** Batch-fetch assets by IDs, return map of id -> asset object */
    async function batchFetchAssets(ids: string[]): Promise<Map<string, AssetObject>> {
      if (ids.length === 0) return new Map();
      const placeholders = ids.map(() => "?").join(", ");
      const rows = await runSql(
        Effect.gen(function* () {
          const s = yield* SqlClient.SqlClient;
          return yield* s.unsafe<AssetRow>(
            `SELECT * FROM assets WHERE id IN (${placeholders})`, ids
          );
        })
      );
      const map = new Map<string, AssetObject>();
      for (const a of rows) {
        map.set(a.id, {
          id: a.id, filename: a.filename, mimeType: a.mime_type,
          size: a.size, width: a.width, height: a.height,
          alt: a.alt, title: a.title, blurhash: a.blurhash ?? null,
          url: assetUrl(a.id, a.filename),
        });
      }
      return map;
    }

    /** Batch-fetch records from a content table by IDs, return map of id -> record */
    async function batchFetchRecords(tableApiKey: string, ids: string[]): Promise<Map<string, DynamicRow>> {
      if (ids.length === 0) return new Map();
      const tName = typeNames.get(tableApiKey);
      const placeholders = ids.map(() => "?").join(", ");
      const rows = await runSql(
        Effect.gen(function* () {
          const s = yield* SqlClient.SqlClient;
          return yield* s.unsafe<DynamicRow>(
            `SELECT * FROM "content_${tableApiKey}" WHERE id IN (${placeholders})`, ids
          );
        })
      );
      const map = new Map<string, DynamicRow>();
      for (const row of rows) {
        map.set(row.id as string, { ...deserializeRecord(row), __typename: tName ? `${tName}Record` : undefined });
      }
      return map;
    }

    /** Resolve a single record ID across target tables (for single link fields) */
    async function resolveLinkedRecord(targetApiKeys: string[], id: string): Promise<DynamicRow | null> {
      for (const apiKey of targetApiKeys) {
        const map = await batchFetchRecords(apiKey, [id]);
        const found = map.get(id);
        if (found) return found;
      }
      return null;
    }

    /** Batch-resolve multiple record IDs across target tables (for links fields) */
    async function batchResolveLinkedRecords(targetApiKeys: string[], ids: string[]): Promise<Map<string, DynamicRow>> {
      const result = new Map<string, DynamicRow>();
      const remaining = new Set(ids);
      for (const apiKey of targetApiKeys) {
        if (remaining.size === 0) break;
        const map = await batchFetchRecords(apiKey, [...remaining]);
        for (const [id, record] of map) {
          result.set(id, record);
          remaining.delete(id);
        }
      }
      return result;
    }

    for (const f of fields) {
      const gqlName = toCamelCase(f.api_key);

      if (f.field_type === "link") {
        const targets = getLinkTargets(f.validators);
        if (targets && targets.length > 0) {
          typeResolvers[gqlName] = async (parent: DynamicRow) => {
            const linkedId = parent[f.api_key];
            if (!linkedId) return null;
            return await resolveLinkedRecord(targets, linkedId as string);
          };
        }
      }
      if (f.field_type === "links") {
        const targets = getLinksTargets(f.validators);
        if (targets && targets.length > 0) {
          typeResolvers[gqlName] = async (parent: DynamicRow) => {
            let linkedIds = parent[f.api_key];
            if (typeof linkedIds === "string") {
              try { linkedIds = JSON.parse(linkedIds); } catch { return []; }
            }
            if (!Array.isArray(linkedIds)) return [];
            // Batch-fetch all linked records in one IN query per target table
            const resolved = await batchResolveLinkedRecords(targets, linkedIds as string[]);
            // Return in original order, preserving insertion order
            return (linkedIds as string[]).map((id: string) => resolved.get(id) ?? null).filter(Boolean);
          };
        }
      }
      // Media field resolver: batch-fetch single asset
      if (f.field_type === "media") {
        typeResolvers[gqlName] = async (parent: DynamicRow) => {
          const assetId = parent[f.api_key];
          if (!assetId) return null;
          const map = await batchFetchAssets([assetId as string]);
          return map.get(assetId as string) ?? null;
        };
      }
      // Media gallery resolver: batch-fetch all assets in one IN query
      if (f.field_type === "media_gallery") {
        typeResolvers[gqlName] = async (parent: DynamicRow) => {
          let ids = parent[f.api_key];
          if (typeof ids === "string") { try { ids = JSON.parse(ids); } catch { return []; } }
          if (!Array.isArray(ids)) return [];
          const assetMap = await batchFetchAssets(ids as string[]);
          // Return in original order
          return (ids as string[]).map((id: string) => assetMap.get(id) ?? null).filter(Boolean);
        };
      }
      // SEO field resolver: return parsed JSON with image asset resolution
      if (f.field_type === "seo") {
        typeResolvers[gqlName] = async (parent: DynamicRow) => {
          let seo = parent[f.api_key];
          if (!seo) return null;
          if (typeof seo === "string") {
            try { seo = JSON.parse(seo); } catch { return null; }
          }
          // Return the object as-is; image is resolved by the SeoField type resolver
          return seo;
        };
      }
      // Color field resolver: parse JSON, compute hex
      if (f.field_type === "color") {
        typeResolvers[gqlName] = async (parent: DynamicRow) => {
          let color = parent[f.api_key];
          if (!color) return null;
          if (typeof color === "string") {
            try { color = JSON.parse(color); } catch { return null; }
          }
          return color;
        };
      }
      // LatLon field resolver: parse JSON
      if (f.field_type === "lat_lon") {
        typeResolvers[gqlName] = async (parent: DynamicRow) => {
          let ll = parent[f.api_key];
          if (!ll) return null;
          if (typeof ll === "string") {
            try { ll = JSON.parse(ll); } catch { return null; }
          }
          return ll;
        };
      }
      // StructuredText resolver: return { value, blocks, links }
      if (f.field_type === "structured_text") {
        typeResolvers[gqlName] = async (parent: DynamicRow) => {
          let dast = parent[f.api_key];
          if (!dast) return null;
          if (typeof dast === "string") {
            try { dast = JSON.parse(dast); } catch { return null; }
          }

          // Extract block IDs and inline block IDs separately
          const blockLevelIds = new Set(extractBlockIds(dast as DastDocInput));
          const inlineBlockIdSet = new Set(extractInlineBlockIds(dast as DastDocInput));

          // Fetch all blocks for this field, then categorize
          const blocks: DynamicRow[] = [];
          const inlineBlocks: DynamicRow[] = [];

          if (blockLevelIds.size > 0 || inlineBlockIdSet.size > 0) {
            for (const bm of blockModels) {
              const fetched = await runSql(
                Effect.gen(function* () {
                  const s = yield* SqlClient.SqlClient;
                  const rows = yield* s.unsafe<DynamicRow>(
                    `SELECT * FROM "block_${bm.api_key}" WHERE _root_record_id = ? AND _root_field_api_key = ?`,
                    [parent.id, f.api_key]
                  );
                  return rows.map((r: DynamicRow) => {
                    const deserialized = deserializeRecord(r);
                    return { id: String(deserialized.id ?? ""), ...deserialized, __typename: `${toTypeName(bm.api_key)}Record` };
                  });
                })
              );
              for (const record of fetched) {
                if (blockLevelIds.has(record.id as string)) {
                  blocks.push(record);
                } else if (inlineBlockIdSet.has(record.id as string)) {
                  inlineBlocks.push(record);
                }
                // Skip blocks not referenced in this DAST (e.g., nested blocks
                // belonging to a child block's structured_text field)
              }
            }
          }

          // Resolve itemLink/inlineItem record references using batch helper
          const linkRecordIds = extractLinkIds(dast as DastDocInput);
          const allModelApiKeys = models.map((m) => m.api_key);
          const resolvedLinks = linkRecordIds.length > 0
            ? await batchResolveLinkedRecords(allModelApiKeys, linkRecordIds)
            : new Map();
          const links = linkRecordIds
            .map((id) => resolvedLinks.get(id) ?? null)
            .filter(Boolean);

          return {
            value: dast,
            blocks,
            inlineBlocks,
            links,
          };
        };
      }
    }
    // Add default camelCase -> snake_case resolvers for simple fields without custom resolvers
    for (const f of fields) {
      const gqlName = toCamelCase(f.api_key);
      if (!typeResolvers[gqlName]) {
        typeResolvers[gqlName] = (parent: DynamicRow) => parent[f.api_key];
      }
    }

    resolvers[typeName] = typeResolvers;

    // Collect per-model metadata
    const localizedDbColumns = fields.filter((f) => f.localized).map((f) => f.api_key);
    const jsonArrayFields = new Set(
      fields.filter((f) => f.field_type === "links" || f.field_type === "media_gallery")
        .map((f) => toCamelCase(f.api_key))
    );

    modelMetas.push({
      typeName,
      tableName,
      model,
      camelToSnake,
      localizedCamelKeys,
      localizedDbColumns,
      jsonArrayFields,
      fields,
    });
  }

  return modelMetas;
}
