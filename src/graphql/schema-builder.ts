import { createSchema } from "graphql-yoga";
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { extractBlockIds } from "../dast/index.js";
import type { ModelRow, FieldRow, AssetRow } from "../db/row-types.js";
import { getLinkTargets, getLinksTargets } from "../db/validators.js";
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
    default: return "String";
  }
}

function filterInputType(fieldType: string): string {
  switch (fieldType) {
    case "string": case "text": case "slug": case "media": case "link": return "StringFilter";
    case "boolean": return "BooleanFilter";
    case "integer": return "IntFilter";
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
      for (const [op, exp] of Object.entries(ff as Record<string, any>)) {
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
    interface ParsedField extends Omit<FieldRow, "validators"> {
      validators: Record<string, unknown>;
    }
    const fieldsByModelId = new Map<string, ParsedField[]>();
    for (const f of allFields) {
      const list = fieldsByModelId.get(f.model_id) ?? [];
      list.push({ ...f, validators: JSON.parse(f.validators || "{}") as Record<string, unknown> });
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
      }
    `);
    typeDefs.push(`
      """DatoCMS-compatible StructuredText response"""
      type StructuredText {
        value: JSON!
        blocks: [JSON!]!
        links: [JSON!]!
      }
      input StringFilter { eq: String, neq: String, matches: String, isBlank: Boolean, exists: Boolean }
      input IntFilter { eq: Int, neq: Int, gt: Int, lt: Int, gte: Int, lte: Int, exists: Boolean }
      input BooleanFilter { eq: Boolean, exists: Boolean }
    `);

    // Collect type names
    const typeNames = new Map<string, string>();
    for (const m of models) typeNames.set(m.api_key, toTypeName(m.api_key));

    for (const model of models) {
      const fields = fieldsByModelId.get(model.id) ?? [];
      const typeName = typeNames.get(model.api_key)!;
      const tableName = `content_${model.api_key}`;

      // Object type
      const fieldDefs = [
        "id: ID!", "_status: String", "_createdAt: String", "_updatedAt: String",
        "_publishedAt: String", "_firstPublishedAt: String",
      ];
      for (const f of fields) {
        fieldDefs.push(`${f.api_key}: ${fieldToSDL(f.field_type, f.validators, typeNames)}`);
      }
      typeDefs.push(`type ${typeName} {\n  ${fieldDefs.join("\n  ")}\n}`);

      // Link resolvers
      const typeResolvers: Record<string, any> = {};
      // Map _created_at → _createdAt etc.
      typeResolvers._createdAt = (p: any) => p._created_at;
      typeResolvers._updatedAt = (p: any) => p._updated_at;
      typeResolvers._publishedAt = (p: any) => p._published_at;
      typeResolvers._firstPublishedAt = (p: any) => p._first_published_at;

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
        // StructuredText resolver: return { value, blocks, links }
        if (f.field_type === "structured_text") {
          typeResolvers[f.api_key] = (parent: any) => {
            let dast = parent[f.api_key];
            if (!dast) return null;
            if (typeof dast === "string") {
              try { dast = JSON.parse(dast); } catch { return null; }
            }

            // Extract block IDs from DAST
            const blockIds = extractBlockIds(dast);

            // Fetch blocks from their respective tables
            const blocks: any[] = [];
            if (blockIds.length > 0) {
              for (const bm of blockModels) {
                const fetched = runSql(
                  Effect.gen(function* () {
                    const s = yield* SqlClient.SqlClient;
                    // Get blocks from this block type table that match our record
                    const rows = yield* s.unsafe<Record<string, any>>(
                      `SELECT * FROM "block_${bm.api_key}" WHERE _root_record_id = ? AND _root_field_api_key = ?`,
                      [parent.id, f.api_key]
                    );
                    return rows.map((r: any) => ({
                      ...deserializeRecord(r),
                      __typename: toTypeName(bm.api_key),
                    }));
                  })
                );
                blocks.push(...fetched);
              }
            }

            return {
              value: dast,
              blocks,
              links: [], // TODO: resolve itemLink/inlineItem references
            };
          };
        }
      }
      resolvers[typeName] = typeResolvers;

      // Filter/OrderBy/Meta types
      const filterFields = ["id: StringFilter", "_status: StringFilter"];
      const orderByValues = ["_createdAt_ASC", "_createdAt_DESC", "_updatedAt_ASC", "_updatedAt_DESC"];
      for (const f of fields) {
        if (!["structured_text", "media_gallery", "links"].includes(f.field_type)) {
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
      queryFieldDefs.push(`${listName}(filter: ${typeName}Filter, orderBy: [${typeName}OrderBy!], first: Int, skip: Int): [${typeName}!]!`);
      queryFieldDefs.push(`${model.api_key}(id: ID, filter: ${typeName}Filter): ${typeName}`);
      queryFieldDefs.push(`_all${typeName}sMeta(filter: ${typeName}Filter): ${typeName}Meta!`);

      // Query resolvers — push filtering/ordering/pagination to SQL
      function queryWithFilter(args: { filter?: any; orderBy?: string[]; first?: number; skip?: number }) {
        return runSql(
          Effect.gen(function* () {
            const s = yield* SqlClient.SqlClient;

            let query = `SELECT * FROM "${tableName}"`;
            let params: any[] = [];

            // Compile filter to SQL WHERE clause
            const compiled = compileFilterToSql(args.filter);
            if (compiled) {
              query += ` WHERE ${compiled.where}`;
              params = compiled.params;
            }

            // Compile ORDER BY
            const orderBy = compileOrderBy(args.orderBy);
            if (orderBy) {
              query += ` ORDER BY ${orderBy}`;
            }

            // Pagination
            const limit = args.first ?? 500;
            query += ` LIMIT ?`;
            params.push(limit);

            if (args.skip) {
              query += ` OFFSET ?`;
              params.push(args.skip);
            }

            const rows = yield* s.unsafe<Record<string, any>>(query, params);
            return rows.map(deserializeRecord);
          })
        );
      }

      function countWithFilter(filter?: any) {
        return runSql(
          Effect.gen(function* () {
            const s = yield* SqlClient.SqlClient;

            let query = `SELECT COUNT(*) as count FROM "${tableName}"`;
            let params: any[] = [];

            const compiled = compileFilterToSql(filter);
            if (compiled) {
              query += ` WHERE ${compiled.where}`;
              params = compiled.params;
            }

            const rows = yield* s.unsafe<{ count: number }>(query, params);
            return rows[0]?.count ?? 0;
          })
        );
      }

      resolvers.Query[listName] = (_: any, args: any) => {
        return queryWithFilter(args);
      };

      resolvers.Query[model.api_key] = (_: any, args: any) => {
        if (args.id) {
          return runSql(
            Effect.gen(function* () {
              const s = yield* SqlClient.SqlClient;
              const rows = yield* s.unsafe<Record<string, any>>(`SELECT * FROM "${tableName}" WHERE id = ?`, [args.id]);
              return rows.length > 0 ? deserializeRecord(rows[0]) : null;
            })
          );
        }
        if (args.filter) {
          const records = queryWithFilter({ filter: args.filter, first: 1 });
          return records[0] ?? null;
        }
        return null;
      };

      resolvers.Query[`_all${typeName}sMeta`] = (_: any, args: any) => {
        return { count: countWithFilter(args.filter) };
      };
    }

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
