import { createSchema } from "graphql-yoga";
import type { GeneratedSchema, FieldRow } from "../schema-engine/index.js";
import { eq } from "drizzle-orm";

/** Convert api_key to PascalCase type name */
function toTypeName(apiKey: string): string {
  return apiKey.charAt(0).toUpperCase() +
    apiKey.slice(1).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Map CMS field types to GraphQL SDL types, considering link targets */
function fieldToSDL(
  field: FieldRow,
  typeNames: Map<string, string> // apiKey → TypeName
): string {
  switch (field.fieldType) {
    case "string": case "text": case "slug": case "media":
      return "String";
    case "boolean":
      return "Boolean";
    case "integer":
      return "Int";
    case "link": {
      const validators = (field.validators ?? {}) as Record<string, any>;
      const targets = validators.item_item_type as string[] | undefined;
      if (targets && targets.length === 1 && typeNames.has(targets[0])) {
        return typeNames.get(targets[0])!;
      }
      // Multiple targets or unknown → JSON (could be union later)
      return "JSON";
    }
    case "links": {
      const validators = (field.validators ?? {}) as Record<string, any>;
      const targets = validators.items_item_type as string[] | undefined;
      if (targets && targets.length === 1 && typeNames.has(targets[0])) {
        return `[${typeNames.get(targets[0])!}!]`;
      }
      return "JSON";
    }
    case "media_gallery":
      return "JSON";
    case "structured_text":
      return "JSON";
    default:
      return "String";
  }
}

function filterInputType(fieldType: string): string {
  switch (fieldType) {
    case "string": case "text": case "slug": case "media": case "link":
      return "StringFilter";
    case "boolean":
      return "BooleanFilter";
    case "integer":
      return "IntFilter";
    default:
      return "StringFilter";
  }
}

function applyFilters(records: any[], filter: Record<string, any> | undefined): any[] {
  if (!filter) return records;
  if (filter.AND) {
    for (const sub of filter.AND) records = applyFilters(records, sub);
    return records;
  }
  if (filter.OR) {
    const results = new Set<any>();
    for (const sub of filter.OR) for (const r of applyFilters([...records], sub)) results.add(r);
    return [...results];
  }
  return records.filter((record) => {
    for (const [key, fieldFilter] of Object.entries(filter)) {
      if (key === "AND" || key === "OR" || typeof fieldFilter !== "object" || fieldFilter === null) continue;
      const value = record[key];
      for (const [op, expected] of Object.entries(fieldFilter as Record<string, any>)) {
        switch (op) {
          case "eq": if (value !== expected) return false; break;
          case "neq": if (value === expected) return false; break;
          case "gt": if (!(value > expected)) return false; break;
          case "lt": if (!(value < expected)) return false; break;
          case "gte": if (!(value >= expected)) return false; break;
          case "lte": if (!(value <= expected)) return false; break;
          case "matches": if (typeof value !== "string" || !new RegExp(expected, "i").test(value)) return false; break;
          case "isBlank": if (expected && value !== null && value !== undefined && value !== "") return false; if (!expected && (value === null || value === undefined || value === "")) return false; break;
          case "exists": if (expected && (value === null || value === undefined)) return false; if (!expected && value !== null && value !== undefined) return false; break;
        }
      }
    }
    return true;
  });
}

function applyOrdering(records: any[], orderBy: string[] | undefined): any[] {
  if (!orderBy || orderBy.length === 0) return records;
  return [...records].sort((a, b) => {
    for (const spec of orderBy) {
      const match = spec.match(/^(.+)_(ASC|DESC)$/);
      if (!match) continue;
      const [, field, dir] = match;
      if (a[field] === b[field]) continue;
      if (a[field] == null) return dir === "ASC" ? -1 : 1;
      if (b[field] == null) return dir === "ASC" ? 1 : -1;
      return (a[field] < b[field] ? -1 : 1) * (dir === "ASC" ? 1 : -1);
    }
    return 0;
  });
}

export function buildGraphQLSchema(generated: GeneratedSchema, db: any) {
  const typeDefs: string[] = [];
  const queryFieldDefs: string[] = [];
  const resolvers: Record<string, any> = { Query: {} };

  typeDefs.push("scalar JSON");
  typeDefs.push(`
    input StringFilter { eq: String, neq: String, matches: String, isBlank: Boolean, exists: Boolean }
    input IntFilter { eq: Int, neq: Int, gt: Int, lt: Int, gte: Int, lte: Int, exists: Boolean }
    input BooleanFilter { eq: Boolean, exists: Boolean }
  `);

  // First pass: collect type names for all content models
  const typeNames = new Map<string, string>();
  for (const [apiKey, model] of generated.models) {
    if (!model.isBlock) typeNames.set(apiKey, toTypeName(apiKey));
  }

  // Second pass: generate types with resolved link targets
  for (const [apiKey, model] of generated.models) {
    if (model.isBlock) continue;

    const fields = generated.fields.get(apiKey) ?? [];
    const table = generated.tables.get(apiKey);
    if (!table) continue;
    const typeName = typeNames.get(apiKey)!;

    // Object type
    const fieldDefs = [
      "id: ID!",
      "_status: String",
      "_createdAt: String",
      "_updatedAt: String",
      "_publishedAt: String",
      "_firstPublishedAt: String",
    ];
    for (const field of fields) {
      fieldDefs.push(`${field.apiKey}: ${fieldToSDL(field, typeNames)}`);
    }
    typeDefs.push(`type ${typeName} {\n  ${fieldDefs.join("\n  ")}\n}`);

    // Type-level resolvers for link fields
    const typeResolvers: Record<string, any> = {};
    for (const field of fields) {
      if (field.fieldType === "link") {
        const validators = (field.validators ?? {}) as Record<string, any>;
        const targets = validators.item_item_type as string[] | undefined;
        if (targets && targets.length === 1 && generated.tables.has(targets[0])) {
          const targetTable = generated.tables.get(targets[0])!;
          typeResolvers[field.apiKey] = (parent: any) => {
            const linkedId = parent[field.apiKey];
            if (!linkedId) return null;
            return db.select().from(targetTable).where(eq(targetTable.id, linkedId)).get() ?? null;
          };
        }
      }
      if (field.fieldType === "links") {
        const validators = (field.validators ?? {}) as Record<string, any>;
        const targets = validators.items_item_type as string[] | undefined;
        if (targets && targets.length === 1 && generated.tables.has(targets[0])) {
          const targetTable = generated.tables.get(targets[0])!;
          typeResolvers[field.apiKey] = (parent: any) => {
            const linkedIds = parent[field.apiKey];
            if (!Array.isArray(linkedIds)) return [];
            return linkedIds
              .map((id: string) => db.select().from(targetTable).where(eq(targetTable.id, id)).get())
              .filter(Boolean);
          };
        }
      }
    }
    if (Object.keys(typeResolvers).length > 0) {
      resolvers[typeName] = typeResolvers;
    }

    // Filter input
    const filterFields = ["id: StringFilter", "_status: StringFilter", "_createdAt: StringFilter", "_updatedAt: StringFilter"];
    for (const field of fields) {
      if (!["structured_text", "media_gallery", "links"].includes(field.fieldType)) {
        filterFields.push(`${field.apiKey}: ${filterInputType(field.fieldType)}`);
      }
    }
    filterFields.push(`AND: [${typeName}Filter!]`, `OR: [${typeName}Filter!]`);
    typeDefs.push(`input ${typeName}Filter {\n  ${filterFields.join("\n  ")}\n}`);

    // OrderBy enum
    const orderByValues = ["_createdAt_ASC", "_createdAt_DESC", "_updatedAt_ASC", "_updatedAt_DESC"];
    for (const field of fields) {
      if (!["structured_text", "media_gallery", "links"].includes(field.fieldType)) {
        orderByValues.push(`${field.apiKey}_ASC`, `${field.apiKey}_DESC`);
      }
    }
    typeDefs.push(`enum ${typeName}OrderBy { ${orderByValues.join(" ")} }`);
    typeDefs.push(`type ${typeName}Meta { count: Int! }`);

    // Queries
    const listName = `all${typeName}s`;
    queryFieldDefs.push(`${listName}(filter: ${typeName}Filter, orderBy: [${typeName}OrderBy!], first: Int, skip: Int): [${typeName}!]!`);
    queryFieldDefs.push(`${apiKey}(id: ID, filter: ${typeName}Filter): ${typeName}`);
    queryFieldDefs.push(`_all${typeName}sMeta(filter: ${typeName}Filter): ${typeName}Meta!`);

    resolvers.Query[listName] = (_: any, args: any) => {
      let records = db.select().from(table).all();
      records = applyFilters(records, args.filter);
      records = applyOrdering(records, args.orderBy);
      const skip = args.skip ?? 0;
      const first = args.first ?? Math.min(records.length, 500);
      return records.slice(skip, skip + first);
    };

    resolvers.Query[apiKey] = (_: any, args: any) => {
      if (args.id) return db.select().from(table).where(eq(table.id, args.id)).get() ?? null;
      if (args.filter) {
        const records = applyFilters(db.select().from(table).all(), args.filter);
        return records[0] ?? null;
      }
      return null;
    };

    resolvers.Query[`_all${typeName}sMeta`] = (_: any, args: any) => {
      let records = db.select().from(table).all();
      records = applyFilters(records, args.filter);
      return { count: records.length };
    };
  }

  if (queryFieldDefs.length === 0) {
    queryFieldDefs.push("_empty: String");
    resolvers.Query._empty = () => null;
  }

  const schemaDef = `
    ${typeDefs.join("\n\n")}
    type Query {
      ${queryFieldDefs.join("\n      ")}
    }
  `;

  return createSchema({ typeDefs: schemaDef, resolvers });
}
