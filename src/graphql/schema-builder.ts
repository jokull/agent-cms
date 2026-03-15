import { createSchema } from "graphql-yoga";
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";

function toTypeName(apiKey: string): string {
  return apiKey.charAt(0).toUpperCase() +
    apiKey.slice(1).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function fieldToSDL(
  fieldType: string,
  validators: Record<string, any>,
  typeNames: Map<string, string>
): string {
  switch (fieldType) {
    case "string": case "text": case "slug": case "media": return "String";
    case "boolean": return "Boolean";
    case "integer": return "Int";
    case "link": {
      const targets = validators.item_item_type as string[] | undefined;
      if (targets?.length === 1 && typeNames.has(targets[0])) return typeNames.get(targets[0])!;
      return "JSON";
    }
    case "links": {
      const targets = validators.items_item_type as string[] | undefined;
      if (targets?.length === 1 && typeNames.has(targets[0])) return `[${typeNames.get(targets[0])!}!]`;
      return "JSON";
    }
    case "media_gallery": case "structured_text": return "JSON";
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
          case "eq": if (v !== exp) return false; break;
          case "neq": if (v === exp) return false; break;
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
 * Returns an Effect that produces the schema.
 */
export function buildGraphQLSchema() {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Load all models and fields
    const models = yield* sql.unsafe<Record<string, any>>("SELECT * FROM models WHERE is_block = 0 ORDER BY created_at");
    const allFields = yield* sql.unsafe<Record<string, any>>("SELECT * FROM fields ORDER BY position");

    // Group fields by model
    const fieldsByModelId = new Map<string, any[]>();
    for (const f of allFields) {
      const list = fieldsByModelId.get(f.model_id) ?? [];
      list.push({ ...f, validators: JSON.parse(f.validators || "{}") });
      fieldsByModelId.set(f.model_id, list);
    }

    const typeDefs: string[] = [];
    const queryFieldDefs: string[] = [];
    const resolvers: Record<string, any> = { Query: {} };

    typeDefs.push("scalar JSON");
    typeDefs.push(`
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
          const targets = f.validators.item_item_type;
          if (targets?.length === 1 && typeNames.has(targets[0])) {
            const targetTable = `content_${targets[0]}`;
            typeResolvers[f.api_key] = (parent: any) => {
              const linkedId = parent[f.api_key];
              if (!linkedId) return null;
              return Effect.runSync(
                sql.unsafe<Record<string, any>>(`SELECT * FROM "${targetTable}" WHERE id = ?`, [linkedId])
                  .pipe(Effect.map((rows) => rows.length > 0 ? deserializeRecord(rows[0]) : null))
              );
            };
          }
        }
        if (f.field_type === "links") {
          const targets = f.validators.items_item_type;
          if (targets?.length === 1 && typeNames.has(targets[0])) {
            const targetTable = `content_${targets[0]}`;
            typeResolvers[f.api_key] = (parent: any) => {
              let linkedIds = parent[f.api_key];
              if (typeof linkedIds === "string") {
                try { linkedIds = JSON.parse(linkedIds); } catch { return []; }
              }
              if (!Array.isArray(linkedIds)) return [];
              return linkedIds.map((id: string) =>
                Effect.runSync(
                  sql.unsafe<Record<string, any>>(`SELECT * FROM "${targetTable}" WHERE id = ?`, [id])
                    .pipe(Effect.map((rows) => rows.length > 0 ? deserializeRecord(rows[0]) : null))
                )
              ).filter(Boolean);
            };
          }
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

      // Query resolvers — use captured sql client
      resolvers.Query[listName] = (_: any, args: any) => {
        let records = Effect.runSync(
          sql.unsafe<Record<string, any>>(`SELECT * FROM "${tableName}"`).pipe(
            Effect.map((rows) => rows.map(deserializeRecord))
          )
        );
        records = applyFilters(records, args.filter);
        records = applyOrdering(records, args.orderBy);
        const skip = args.skip ?? 0;
        const first = args.first ?? Math.min(records.length, 500);
        return records.slice(skip, skip + first);
      };

      resolvers.Query[model.api_key] = (_: any, args: any) => {
        if (args.id) {
          return Effect.runSync(
            sql.unsafe<Record<string, any>>(`SELECT * FROM "${tableName}" WHERE id = ?`, [args.id]).pipe(
              Effect.map((rows) => rows.length > 0 ? deserializeRecord(rows[0]) : null)
            )
          );
        }
        if (args.filter) {
          let records = Effect.runSync(
            sql.unsafe<Record<string, any>>(`SELECT * FROM "${tableName}"`).pipe(
              Effect.map((rows) => rows.map(deserializeRecord))
            )
          );
          records = applyFilters(records, args.filter);
          return records[0] ?? null;
        }
        return null;
      };

      resolvers.Query[`_all${typeName}sMeta`] = (_: any, args: any) => {
        let records = Effect.runSync(
          sql.unsafe<Record<string, any>>(`SELECT * FROM "${tableName}"`).pipe(
            Effect.map((rows) => rows.map(deserializeRecord))
          )
        );
        records = applyFilters(records, args.filter);
        return { count: records.length };
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
