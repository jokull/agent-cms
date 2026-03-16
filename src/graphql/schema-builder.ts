import { createSchema } from "graphql-yoga";
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { extractBlockIds, extractInlineBlockIds } from "../dast/index.js";
import type { ModelRow, FieldRow, AssetRow } from "../db/row-types.js";
import { getLinkTargets, getLinksTargets } from "../db/validators.js";
import { parseFieldValidators } from "../db/row-types.js";
import { compileFilterToSql, compileOrderBy } from "./filter-compiler.js";

function toTypeName(apiKey: string): string {
  return apiKey.charAt(0).toUpperCase() +
    apiKey.slice(1).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function fieldToSDL(
  fieldType: string,
  validators: Record<string, unknown>,
  typeNames: Map<string, string>
): string {
  switch (fieldType) {
    case "string": case "text": case "slug": return "String";
    case "media": return "Asset";
    case "boolean": return "Boolean";
    case "integer": return "Int";
    case "link": {
      const targets = getLinkTargets(validators);
      if (targets?.length === 1 && typeNames.has(targets[0])) return typeNames.get(targets[0])!;
      return "JSON";
    }
    case "links": {
      const targets = getLinksTargets(validators);
      if (targets?.length === 1 && typeNames.has(targets[0])) return `[${typeNames.get(targets[0])!}!]`;
      return "JSON";
    }
    case "media_gallery": return "[Asset!]";
    case "structured_text": return "StructuredText";
    case "seo": return "SeoField";
    case "json": return "JSON";
    case "float": return "Float";
    case "date": return "String";
    case "date_time": return "String";
    case "color": return "ColorField";
    case "lat_lon": return "LatLonField";
    default: return "String";
  }
}

function filterInputType(fieldType: string): string {
  switch (fieldType) {
    case "string": case "text": case "slug": case "media": case "link": return "StringFilter";
    case "date": case "date_time": return "StringFilter";
    case "boolean": return "BooleanFilter";
    case "integer": return "IntFilter";
    case "float": return "FloatFilter";
    default: return "StringFilter";
  }
}

function applyFilters(records: any[], filter: any): any[] {
  if (!filter) return records;
  if (filter.AND) { for (const sub of filter.AND) records = applyFilters(records, sub); return records; }
  if (filter.OR) { const r = new Set<any>(); for (const sub of filter.OR) for (const x of applyFilters([...records], sub)) r.add(x); return [...r]; }
  return records.filter((rec) => {
    for (const [key, ff] of Object.entries(filter)) {
      if (key === "AND" || key === "OR" || typeof ff !== "object" || ff === null) continue;
      const v = rec[key];
      for (const [op, exp] of Object.entries(ff)) {
        switch (op) {
          case "eq": {
            // Handle boolean coercion (SQLite stores 0/1)
            const ev = typeof exp === "boolean" ? (exp ? 1 : 0) : exp;
            if (v !== ev && v !== exp) return false;
            break;
          }
          case "neq": {
            const ev = typeof exp === "boolean" ? (exp ? 1 : 0) : exp;
            if (v === ev || v === exp) return false;
            break;
          }
          case "gt": if (!(v > exp)) return false; break;
          case "lt": if (!(v < exp)) return false; break;
          case "gte": if (!(v >= exp)) return false; break;
          case "lte": if (!(v <= exp)) return false; break;
          case "matches": if (typeof v !== "string" || !new RegExp(exp, "i").test(v)) return false; break;
          case "isBlank": if (exp && v != null && v !== "") return false; if (!exp && (v == null || v === "")) return false; break;
          case "exists": if (exp && v == null) return false; if (!exp && v != null) return false; break;
        }
      }
    }
    return true;
  });
}

function applyOrdering(records: any[], orderBy: string[] | undefined): any[] {
  if (!orderBy?.length) return records;
  return [...records].sort((a, b) => {
    for (const spec of orderBy) {
      const m = spec.match(/^(.+)_(ASC|DESC)$/);
      if (!m) continue;
      const [, f, d] = m;
      if (a[f] === b[f]) continue;
      if (a[f] == null) return d === "ASC" ? -1 : 1;
      if (b[f] == null) return d === "ASC" ? 1 : -1;
      return (a[f] < b[f] ? -1 : 1) * (d === "ASC" ? 1 : -1);
    }
    return 0;
  });
}

/** Deserialize JSON string fields in a record */
function deserializeRecord(record: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
      try { result[key] = JSON.parse(value); } catch { result[key] = value; }
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Build a GraphQL schema from CMS metadata, queried via @effect/sql.
 * Accepts the sqlLayer so resolvers can query the database at request time.
 */
export function buildGraphQLSchema(sqlLayer: any) {
  // Helper to run sql queries synchronously through the layer
  function runSql<A>(effect: Effect.Effect<A, any, SqlClient.SqlClient>): A {
    return Effect.runSync(effect.pipe(Effect.provide(sqlLayer)));
  }

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Load all models and fields with typed rows
    const models = yield* sql.unsafe<ModelRow>("SELECT * FROM models WHERE is_block = 0 ORDER BY created_at");
    const blockModels = yield* sql.unsafe<ModelRow>("SELECT * FROM models WHERE is_block = 1");
    const allFields = yield* sql.unsafe<FieldRow>("SELECT * FROM fields ORDER BY position");

    // Group fields by model, parsing validators
    const fieldsByModelId = new Map<string, ReturnType<typeof parseFieldValidators>[]>();
    for (const f of allFields) {
      const list = fieldsByModelId.get(f.model_id) ?? [];
      list.push(parseFieldValidators(f));
      fieldsByModelId.set(f.model_id, list);
    }

    const typeDefs: string[] = [];
    const queryFieldDefs: string[] = [];
    const resolvers: Record<string, any> = { Query: {} };

    typeDefs.push("scalar JSON");
    typeDefs.push(`
      type Asset {
        id: ID!
        filename: String!
        mimeType: String!
        size: Int!
        width: Int
        height: Int
        alt: String
        title: String
        url: String!
        responsiveImage: ResponsiveImage
      }
      type ResponsiveImage {
        src: String!
        srcSet: String!
        width: Int!
        height: Int!
        alt: String
        title: String
        base64: String
        bgColor: String
        sizes: String
      }
      type SiteInfo {
        locales: [String!]!
      }
      type SeoField {
        title: String
        description: String
        image: Asset
        twitterCard: String
      }
      type ColorField {
        red: Int!
        green: Int!
        blue: Int!
        alpha: Int
        hex: String!
      }
      type LatLonField {
        latitude: Float!
        longitude: Float!
      }
    `);
    typeDefs.push(`
      """DatoCMS-compatible StructuredText response"""
      type StructuredText {
        value: JSON!
        blocks: [JSON!]!
        inlineBlocks: [JSON!]!
        links: [JSON!]!
      }
      type StringMultiLocaleField { locale: String!, value: String }
      type IntMultiLocaleField { locale: String!, value: Int }
      type FloatMultiLocaleField { locale: String!, value: Float }
      type BooleanMultiLocaleField { locale: String!, value: Boolean }
      input MatchesFilter { pattern: String!, caseSensitive: Boolean }
      input StringFilter { eq: String, neq: String, in: [String!], notIn: [String!], matches: String, matchesObject: MatchesFilter, isBlank: Boolean, isPresent: Boolean, exists: Boolean }
      input IntFilter { eq: Int, neq: Int, gt: Int, lt: Int, gte: Int, lte: Int, exists: Boolean }
      input FloatFilter { eq: Float, neq: Float, gt: Float, lt: Float, gte: Float, lte: Float, exists: Boolean }
      input BooleanFilter { eq: Boolean, exists: Boolean }
      input DateTimeFilter { eq: String, neq: String, gt: String, lt: String, gte: String, lte: String, exists: Boolean }
    `);

    // Load locales for default locale resolution
    const locales = yield* sql.unsafe<{ code: string; position: number; fallback_locale_id: string | null }>(
      "SELECT code, position, fallback_locale_id FROM locales ORDER BY position"
    );
    const defaultLocale = locales.length > 0 ? locales[0].code : null;

    // Collect type names
    const typeNames = new Map<string, string>();
    for (const m of models) typeNames.set(m.api_key, toTypeName(m.api_key));

    for (const model of models) {
      const fields = fieldsByModelId.get(model.id) ?? [];
      const typeName = typeNames.get(model.api_key)!;
      const tableName = `content_${model.api_key}`;

      // Object type
      const fieldDefs = [
        "id: ID!", "_modelApiKey: String!", "_status: String", "_createdAt: String", "_updatedAt: String",
        "_publishedAt: String", "_firstPublishedAt: String",
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
        fieldDefs.push(`${f.api_key}: ${fieldToSDL(f.field_type, f.validators, typeNames)}`);
      }

      // Track localized fields early so we can add _locales to the type def
      const localizedFieldKeys = new Set<string>();
      for (const f of fields) {
        if (f.localized) localizedFieldKeys.add(f.api_key);
      }
      if (localizedFieldKeys.size > 0) {
        fieldDefs.push("_locales: [String!]!");
      }

      // _all<Field>Locales for each localized field
      for (const f of fields) {
        if (!f.localized) continue;
        const camelKey = f.api_key.charAt(0).toUpperCase() +
          f.api_key.slice(1).replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase());
        const multiLocaleType = f.field_type === "integer" ? "IntMultiLocaleField"
          : f.field_type === "float" ? "FloatMultiLocaleField"
          : f.field_type === "boolean" ? "BooleanMultiLocaleField"
          : "StringMultiLocaleField";
        fieldDefs.push(`_all${camelKey}Locales: [${multiLocaleType}!]!`);
      }

      typeDefs.push(`type ${typeName} {\n  ${fieldDefs.join("\n  ")}\n}`);

      // Link resolvers
      const typeResolvers: Record<string, any> = {};
      // Map _created_at → _createdAt etc.
      typeResolvers._modelApiKey = () => model.api_key;
      typeResolvers._createdAt = (p: any) => p._created_at;
      typeResolvers._updatedAt = (p: any) => p._updated_at;
      typeResolvers._publishedAt = (p: any) => p._published_at;
      typeResolvers._firstPublishedAt = (p: any) => p._first_published_at;
      if (model.sortable || model.tree) {
        typeResolvers._position = (p: any) => p._position ?? 0;
      }
      if (model.tree) {
        typeResolvers._parentId = (p: any) => p._parent_id ?? null;
        typeResolvers._parent = (parent: any) => {
          const parentId = parent._parent_id;
          if (!parentId) return null;
          return runSql(
            Effect.gen(function* () {
              const s = yield* SqlClient.SqlClient;
              const rows = yield* s.unsafe<Record<string, any>>(
                `SELECT * FROM "${tableName}" WHERE id = ?`, [parentId]
              );
              return rows.length > 0 ? deserializeRecord(rows[0]) : null;
            })
          );
        };
        typeResolvers._children = (parent: any) => {
          return runSql(
            Effect.gen(function* () {
              const s = yield* SqlClient.SqlClient;
              const rows = yield* s.unsafe<Record<string, any>>(
                `SELECT * FROM "${tableName}" WHERE "_parent_id" = ? ORDER BY "_position" ASC`, [parent.id]
              );
              return rows.map(deserializeRecord);
            })
          );
        };
      }

      // _locales resolver: returns locale codes where record has content
      if (localizedFieldKeys.size > 0) {
        typeResolvers._locales = (parent: any) => {
          const foundLocales = new Set<string>();
          for (const key of localizedFieldKeys) {
            let localeMap = parent[key];
            if (!localeMap) continue;
            if (typeof localeMap === "string") {
              try { localeMap = JSON.parse(localeMap); } catch { continue; }
            }
            if (typeof localeMap === "object" && localeMap !== null) {
              for (const [locale, value] of Object.entries(localeMap)) {
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
        const camelKey = f.api_key.charAt(0).toUpperCase() +
          f.api_key.slice(1).replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase());
        const resolverName = `_all${camelKey}Locales`;
        typeResolvers[resolverName] = (parent: any) => {
          let localeMap = parent[f.api_key];
          if (!localeMap) return [];
          if (typeof localeMap === "string") {
            try { localeMap = JSON.parse(localeMap); } catch { return []; }
          }
          if (typeof localeMap !== "object" || localeMap === null) return [];
          return Object.entries(localeMap)
            .filter(([, value]) => value !== null && value !== undefined)
            .map(([locale, value]) => ({ locale, value }));
        };
      }

      // Localized field resolvers: extract value for requested locale
      for (const f of fields) {
        if (f.localized && !["link", "links", "media", "media_gallery", "structured_text", "seo", "json", "color", "lat_lon"].includes(f.field_type)) {
          typeResolvers[f.api_key] = (parent: any, _args: any, context: any) => {
            const rawValue = parent[f.api_key];
            if (rawValue === null || rawValue === undefined) return null;

            // Parse JSON if needed
            let localeMap = rawValue;
            if (typeof localeMap === "string") {
              try { localeMap = JSON.parse(localeMap); } catch { return rawValue; }
            }
            if (typeof localeMap !== "object" || localeMap === null) return rawValue;

            // Resolve locale: query arg > context > default
            const locale = context?.locale ?? defaultLocale;
            const fallbacks = context?.fallbackLocales ?? [];

            // Try primary locale
            if (locale && localeMap[locale] !== undefined && localeMap[locale] !== null && localeMap[locale] !== "") {
              return localeMap[locale];
            }
            // Try fallbacks
            for (const fb of fallbacks) {
              if (localeMap[fb] !== undefined && localeMap[fb] !== null && localeMap[fb] !== "") {
                return localeMap[fb];
              }
            }
            // Try default locale as final fallback
            if (defaultLocale && localeMap[defaultLocale] !== undefined) {
              return localeMap[defaultLocale];
            }
            // Return first available value
            const values = Object.values(localeMap);
            return values.length > 0 ? values[0] : null;
          };
        }
      }

      for (const f of fields) {
        if (f.field_type === "link") {
          const targets = getLinkTargets(f.validators);
          if (targets?.length === 1 && typeNames.has(targets[0])) {
            const targetTable = `content_${targets[0]}`;
            typeResolvers[f.api_key] = (parent: any) => {
              const linkedId = parent[f.api_key];
              if (!linkedId) return null;
              return runSql(
                Effect.gen(function* () {
                  const s = yield* SqlClient.SqlClient;
                  const rows = yield* s.unsafe<Record<string, any>>(`SELECT * FROM "${targetTable}" WHERE id = ?`, [linkedId]);
                  return rows.length > 0 ? deserializeRecord(rows[0]) : null;
                })
              );
            };
          }
        }
        if (f.field_type === "links") {
          const targets = getLinksTargets(f.validators);
          if (targets?.length === 1 && typeNames.has(targets[0])) {
            const targetTable = `content_${targets[0]}`;
            typeResolvers[f.api_key] = (parent: any) => {
              let linkedIds = parent[f.api_key];
              if (typeof linkedIds === "string") {
                try { linkedIds = JSON.parse(linkedIds); } catch { return []; }
              }
              if (!Array.isArray(linkedIds)) return [];
              return linkedIds.map((id: string) =>
                runSql(
                  Effect.gen(function* () {
                    const s = yield* SqlClient.SqlClient;
                    const rows = yield* s.unsafe<Record<string, any>>(`SELECT * FROM "${targetTable}" WHERE id = ?`, [id]);
                    return rows.length > 0 ? deserializeRecord(rows[0]) : null;
                  })
                )
              ).filter(Boolean);
            };
          }
        }
        // Media field resolver: return asset metadata
        if (f.field_type === "media") {
          typeResolvers[f.api_key] = (parent: any) => {
            const assetId = parent[f.api_key];
            if (!assetId) return null;
            return runSql(
              Effect.gen(function* () {
                const s = yield* SqlClient.SqlClient;
                const rows = yield* s.unsafe<AssetRow>("SELECT * FROM assets WHERE id = ?", [assetId]);
                if (rows.length === 0) return null;
                const a = rows[0];
                return {
                  id: a.id, filename: a.filename, mimeType: a.mime_type,
                  size: a.size, width: a.width, height: a.height,
                  alt: a.alt, title: a.title,
                  url: `/assets/${a.id}/${a.filename}`, // Local dev URL
                };
              })
            );
          };
        }
        // Media gallery resolver: return array of asset metadata
        if (f.field_type === "media_gallery") {
          typeResolvers[f.api_key] = (parent: any) => {
            let ids = parent[f.api_key];
            if (typeof ids === "string") { try { ids = JSON.parse(ids); } catch { return []; } }
            if (!Array.isArray(ids)) return [];
            return ids.map((assetId: string) =>
              runSql(
                Effect.gen(function* () {
                  const s = yield* SqlClient.SqlClient;
                  const rows = yield* s.unsafe<AssetRow>("SELECT * FROM assets WHERE id = ?", [assetId]);
                  if (rows.length === 0) return null;
                  const a = rows[0];
                  return {
                    id: a.id, filename: a.filename, mimeType: a.mime_type,
                    size: a.size, width: a.width, height: a.height,
                    alt: a.alt, title: a.title,
                    url: `/assets/${a.id}/${a.filename}`,
                  };
                })
              )
            ).filter(Boolean);
          };
        }
        // SEO field resolver: return parsed JSON with image asset resolution
        if (f.field_type === "seo") {
          typeResolvers[f.api_key] = (parent: any) => {
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
          typeResolvers[f.api_key] = (parent: any) => {
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
          typeResolvers[f.api_key] = (parent: any) => {
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
          typeResolvers[f.api_key] = (parent: any) => {
            let dast = parent[f.api_key];
            if (!dast) return null;
            if (typeof dast === "string") {
              try { dast = JSON.parse(dast); } catch { return null; }
            }

            // Extract block IDs and inline block IDs separately
            const blockLevelIds = new Set(extractBlockIds(dast));
            const inlineBlockIdSet = new Set(extractInlineBlockIds(dast));

            // Fetch all blocks for this field, then categorize
            const blocks: any[] = [];
            const inlineBlocks: any[] = [];

            if (blockLevelIds.size > 0 || inlineBlockIdSet.size > 0) {
              for (const bm of blockModels) {
                const fetched = runSql(
                  Effect.gen(function* () {
                    const s = yield* SqlClient.SqlClient;
                    const rows = yield* s.unsafe<Record<string, any>>(
                      `SELECT * FROM "block_${bm.api_key}" WHERE _root_record_id = ? AND _root_field_api_key = ?`,
                      [parent.id, f.api_key]
                    );
                    return rows.map((r: any) => ({
                      ...deserializeRecord(r),
                      __typename: `${toTypeName(bm.api_key)}Record`,
                    }));
                  })
                );
                for (const record of fetched) {
                  if (blockLevelIds.has(record.id)) {
                    blocks.push(record);
                  } else if (inlineBlockIdSet.has(record.id)) {
                    inlineBlocks.push(record);
                  } else {
                    // Block exists but not referenced in DAST — include in blocks
                    blocks.push(record);
                  }
                }
              }
            }

            return {
              value: dast,
              blocks,
              inlineBlocks,
              links: [], // TODO: resolve itemLink/inlineItem references
            };
          };
        }
      }
      resolvers[typeName] = typeResolvers;

      // Filter/OrderBy/Meta types
      const filterFields = [
        "id: StringFilter", "_status: StringFilter",
        "_createdAt: DateTimeFilter", "_updatedAt: DateTimeFilter",
        "_publishedAt: DateTimeFilter", "_firstPublishedAt: DateTimeFilter",
      ];
      const orderByValues = [
        "_createdAt_ASC", "_createdAt_DESC", "_updatedAt_ASC", "_updatedAt_DESC",
        "_publishedAt_ASC", "_publishedAt_DESC", "_firstPublishedAt_ASC", "_firstPublishedAt_DESC",
      ];
      if (model.sortable || model.tree) {
        orderByValues.push("_position_ASC", "_position_DESC");
      }
      for (const f of fields) {
        if (!["structured_text", "media_gallery", "links", "seo", "json", "color", "lat_lon"].includes(f.field_type)) {
          filterFields.push(`${f.api_key}: ${filterInputType(f.field_type)}`);
          orderByValues.push(`${f.api_key}_ASC`, `${f.api_key}_DESC`);
        }
      }
      filterFields.push(`AND: [${typeName}Filter!]`, `OR: [${typeName}Filter!]`);
      typeDefs.push(`input ${typeName}Filter {\n  ${filterFields.join("\n  ")}\n}`);
      typeDefs.push(`enum ${typeName}OrderBy { ${orderByValues.join(" ")} }`);
      typeDefs.push(`type ${typeName}Meta { count: Int! }`);

      // Queries
      const listName = `all${typeName}s`;
      queryFieldDefs.push(`${listName}(locale: String, fallbackLocales: [String!], filter: ${typeName}Filter, orderBy: [${typeName}OrderBy!], first: Int, skip: Int): [${typeName}!]!`);
      queryFieldDefs.push(`${model.api_key}(locale: String, fallbackLocales: [String!], id: ID, filter: ${typeName}Filter): ${typeName}`);
      queryFieldDefs.push(`_all${typeName}sMeta(filter: ${typeName}Filter): ${typeName}Meta!`);

      // Query resolvers — push filtering/ordering/pagination to SQL
      // Support includeDrafts via context (from X-Include-Drafts header)
      function queryWithFilter(
        args: { filter?: any; orderBy?: string[]; first?: number; skip?: number },
        includeDrafts: boolean
      ) {
        return runSql(
          Effect.gen(function* () {
            const s = yield* SqlClient.SqlClient;

            let query = `SELECT * FROM "${tableName}"`;
            const conditions: string[] = [];
            let params: any[] = [];

            // Draft filtering: without includeDrafts, only show published/updated
            if (!includeDrafts) {
              conditions.push(`"_status" IN ('published', 'updated')`);
            }

            // Compile user filter to SQL WHERE clause
            const compiled = compileFilterToSql(args.filter);
            if (compiled) {
              conditions.push(compiled.where);
              params = compiled.params;
            }

            if (conditions.length > 0) {
              query += ` WHERE ${conditions.join(" AND ")}`;
            }

            const orderBy = compileOrderBy(args.orderBy);
            if (orderBy) {
              query += ` ORDER BY ${orderBy}`;
            }

            const limit = args.first ?? 500;
            query += ` LIMIT ?`;
            params.push(limit);

            if (args.skip) {
              query += ` OFFSET ?`;
              params.push(args.skip);
            }

            const rows = yield* s.unsafe<Record<string, any>>(query, params);
            return rows.map((row) => {
              const deserialized = deserializeRecord(row);
              // When not including drafts, overlay published snapshot values
              if (!includeDrafts && deserialized._published_snapshot) {
                const snapshot = typeof deserialized._published_snapshot === "string"
                  ? JSON.parse(deserialized._published_snapshot)
                  : deserialized._published_snapshot;
                return { ...deserialized, ...snapshot };
              }
              return deserialized;
            });
          })
        );
      }

      function countWithFilter(filter: any, includeDrafts: boolean) {
        return runSql(
          Effect.gen(function* () {
            const s = yield* SqlClient.SqlClient;

            let query = `SELECT COUNT(*) as count FROM "${tableName}"`;
            const conditions: string[] = [];
            let params: any[] = [];

            if (!includeDrafts) {
              conditions.push(`"_status" IN ('published', 'updated')`);
            }

            const compiled = compileFilterToSql(filter);
            if (compiled) {
              conditions.push(compiled.where);
              params = compiled.params;
            }

            if (conditions.length > 0) {
              query += ` WHERE ${conditions.join(" AND ")}`;
            }

            const rows = yield* s.unsafe<{ count: number }>(query, params);
            return rows[0]?.count ?? 0;
          })
        );
      }

      resolvers.Query[listName] = (_: any, args: any, context: any) => {
        const includeDrafts = context?.includeDrafts ?? false;
        // Pass locale info to nested field resolvers via context mutation
        if (args.locale) context.locale = args.locale;
        if (args.fallbackLocales) context.fallbackLocales = args.fallbackLocales;
        return queryWithFilter(args, includeDrafts);
      };

      resolvers.Query[model.api_key] = (_: any, args: any, context: any) => {
        const includeDrafts = context?.includeDrafts ?? false;
        if (args.locale) context.locale = args.locale;
        if (args.fallbackLocales) context.fallbackLocales = args.fallbackLocales;
        if (args.id) {
          return runSql(
            Effect.gen(function* () {
              const s = yield* SqlClient.SqlClient;
              const conditions = [`id = ?`];
              if (!includeDrafts) conditions.push(`"_status" IN ('published', 'updated')`);
              const rows = yield* s.unsafe<Record<string, any>>(
                `SELECT * FROM "${tableName}" WHERE ${conditions.join(" AND ")}`,
                [args.id]
              );
              if (rows.length === 0) return null;
              const deserialized = deserializeRecord(rows[0]);
              if (!includeDrafts && deserialized._published_snapshot) {
                const snapshot = typeof deserialized._published_snapshot === "string"
                  ? JSON.parse(deserialized._published_snapshot)
                  : deserialized._published_snapshot;
                return { ...deserialized, ...snapshot };
              }
              return deserialized;
            })
          );
        }
        if (args.filter) {
          const records = queryWithFilter({ filter: args.filter, first: 1 }, includeDrafts);
          return records[0] ?? null;
        }
        return null;
      };

      resolvers.Query[`_all${typeName}sMeta`] = (_: any, args: any, context: any) => {
        const includeDrafts = context?.includeDrafts ?? false;
        return { count: countWithFilter(args.filter, includeDrafts) };
      };
    }

    // _site query — DatoCMS-compatible site info
    queryFieldDefs.push("_site: SiteInfo!");
    resolvers.Query._site = () => ({
      locales: locales.map((l) => l.code),
    });

    // Asset.responsiveImage resolver
    resolvers.Asset = {
      responsiveImage: (asset: any) => {
        if (!asset.width || !asset.height) return null;
        const w = asset.width;
        const h = asset.height;
        const url = asset.url;
        const aspect = w / h;

        // Generate srcSet at common widths
        const widths = [100, 200, 400, 600, 800, 1200, 1600].filter((sw) => sw <= w);
        if (!widths.includes(w)) widths.push(w);
        widths.sort((a, b) => a - b);

        const srcSet = widths
          .map((sw) => `${url}?w=${sw} ${sw}w`)
          .join(", ");

        return {
          src: url,
          srcSet,
          width: w,
          height: h,
          alt: asset.alt ?? null,
          title: asset.title ?? null,
          base64: null, // Would need compute at upload time
          bgColor: null,
          sizes: `(max-width: ${w}px) 100vw, ${w}px`,
        };
      },
    };

    // SeoField.image resolver: look up asset by ID
    resolvers.SeoField = {
      image: (seo: any) => {
        const assetId = seo?.image;
        if (!assetId) return null;
        return runSql(
          Effect.gen(function* () {
            const s = yield* SqlClient.SqlClient;
            const rows = yield* s.unsafe<AssetRow>("SELECT * FROM assets WHERE id = ?", [assetId]);
            if (rows.length === 0) return null;
            const a = rows[0];
            return {
              id: a.id, filename: a.filename, mimeType: a.mime_type,
              size: a.size, width: a.width, height: a.height,
              alt: a.alt, title: a.title,
              url: `/assets/${a.id}/${a.filename}`,
            };
          })
        );
      },
    };

    // ColorField.hex resolver: compute hex from RGB
    resolvers.ColorField = {
      hex: (color: any) => {
        const r = color.red ?? 0;
        const g = color.green ?? 0;
        const b = color.blue ?? 0;
        return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
      },
    };

    if (queryFieldDefs.length === 0) {
      queryFieldDefs.push("_empty: String");
      resolvers.Query._empty = () => null;
    }

    return createSchema({
      typeDefs: `${typeDefs.join("\n\n")}\ntype Query {\n  ${queryFieldDefs.join("\n  ")}\n}`,
      resolvers,
    });
  });
}
