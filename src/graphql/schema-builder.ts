import { createSchema } from "graphql-yoga";
import type { GeneratedSchema, FieldRow } from "../schema-engine/index.js";
import { eq, ne, gt, lt, gte, lte, like, and, or, isNull, isNotNull, sql } from "drizzle-orm";

/** Map CMS field types to GraphQL SDL types */
function fieldTypeToSDL(fieldType: string): string {
  switch (fieldType) {
    case "string": case "text": case "slug": case "media": case "link":
      return "String";
    case "boolean":
      return "Boolean";
    case "integer":
      return "Int";
    case "media_gallery": case "links": case "structured_text":
      return "JSON";
    default:
      return "String";
  }
}

/** Get the filter input SDL type for a CMS field type */
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

/** Apply filters to records (in-memory filtering for dynamic tables) */
function applyFilters(records: any[], filter: Record<string, any> | undefined): any[] {
  if (!filter) return records;

  // Handle AND/OR
  if (filter.AND) {
    for (const subFilter of filter.AND) {
      records = applyFilters(records, subFilter);
    }
    return records;
  }
  if (filter.OR) {
    const results = new Set<any>();
    for (const subFilter of filter.OR) {
      for (const r of applyFilters([...records], subFilter)) {
        results.add(r);
      }
    }
    return [...results];
  }

  return records.filter((record) => {
    for (const [fieldKey, fieldFilter] of Object.entries(filter)) {
      if (fieldKey === "AND" || fieldKey === "OR") continue;
      if (typeof fieldFilter !== "object" || fieldFilter === null) continue;

      const value = record[fieldKey];
      for (const [op, expected] of Object.entries(fieldFilter as Record<string, any>)) {
        switch (op) {
          case "eq": if (value !== expected) return false; break;
          case "neq": if (value === expected) return false; break;
          case "gt": if (!(value > expected)) return false; break;
          case "lt": if (!(value < expected)) return false; break;
          case "gte": if (!(value >= expected)) return false; break;
          case "lte": if (!(value <= expected)) return false; break;
          case "matches":
            if (typeof value !== "string" || !new RegExp(expected, "i").test(value)) return false;
            break;
          case "isBlank":
            if (expected && (value !== null && value !== undefined && value !== "")) return false;
            if (!expected && (value === null || value === undefined || value === "")) return false;
            break;
          case "exists":
            if (expected && (value === null || value === undefined)) return false;
            if (!expected && value !== null && value !== undefined) return false;
            break;
        }
      }
    }
    return true;
  });
}

/** Apply ordering to records */
function applyOrdering(records: any[], orderBy: string[] | undefined): any[] {
  if (!orderBy || orderBy.length === 0) return records;

  return [...records].sort((a, b) => {
    for (const spec of orderBy) {
      const match = spec.match(/^(.+)_(ASC|DESC)$/);
      if (!match) continue;
      const [, field, direction] = match;
      const aVal = a[field];
      const bVal = b[field];
      if (aVal === bVal) continue;
      if (aVal === null || aVal === undefined) return direction === "ASC" ? -1 : 1;
      if (bVal === null || bVal === undefined) return direction === "ASC" ? 1 : -1;
      const cmp = aVal < bVal ? -1 : 1;
      return direction === "ASC" ? cmp : -cmp;
    }
    return 0;
  });
}

export function buildGraphQLSchema(generated: GeneratedSchema, db: any) {
  const typeDefinitions: string[] = [];
  const queryFieldDefs: string[] = [];
  const resolvers: Record<string, any> = { Query: {} };

  typeDefinitions.push("scalar JSON");

  // Common filter types
  typeDefinitions.push(`
    input StringFilter { eq: String, neq: String, matches: String, isBlank: Boolean, exists: Boolean }
    input IntFilter { eq: Int, neq: Int, gt: Int, lt: Int, gte: Int, lte: Int, exists: Boolean }
    input BooleanFilter { eq: Boolean, exists: Boolean }
  `);

  for (const [apiKey, model] of generated.models) {
    if (model.isBlock) continue;

    const fields = generated.fields.get(apiKey) ?? [];
    const table = generated.tables.get(apiKey);
    if (!table) continue;

    const typeName =
      apiKey.charAt(0).toUpperCase() +
      apiKey.slice(1).replace(/_([a-z])/g, (_, c) => c.toUpperCase());

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
      fieldDefs.push(`${field.apiKey}: ${fieldTypeToSDL(field.fieldType)}`);
    }
    typeDefinitions.push(`type ${typeName} {\n  ${fieldDefs.join("\n  ")}\n}`);

    // Filter input type
    const filterFields = [
      "id: StringFilter",
      "_status: StringFilter",
      "_createdAt: StringFilter",
      "_updatedAt: StringFilter",
    ];
    for (const field of fields) {
      const ft = filterInputType(field.fieldType);
      // Skip JSON fields (structured_text, media_gallery, links) — not filterable
      if (ft !== "StringFilter" || !["media_gallery", "links", "structured_text"].includes(field.fieldType)) {
        filterFields.push(`${field.apiKey}: ${ft}`);
      }
    }
    filterFields.push(`AND: [${typeName}Filter!]`);
    filterFields.push(`OR: [${typeName}Filter!]`);
    typeDefinitions.push(`input ${typeName}Filter {\n  ${filterFields.join("\n  ")}\n}`);

    // OrderBy enum
    const orderByValues: string[] = ["_createdAt_ASC", "_createdAt_DESC", "_updatedAt_ASC", "_updatedAt_DESC"];
    for (const field of fields) {
      if (!["structured_text", "media_gallery", "links"].includes(field.fieldType)) {
        orderByValues.push(`${field.apiKey}_ASC`);
        orderByValues.push(`${field.apiKey}_DESC`);
      }
    }
    typeDefinitions.push(`enum ${typeName}OrderBy { ${orderByValues.join(" ")} }`);

    // Meta type
    typeDefinitions.push(`type ${typeName}Meta { count: Int! }`);

    // Queries
    const listName = `all${typeName}s`;
    queryFieldDefs.push(`${listName}(filter: ${typeName}Filter, orderBy: [${typeName}OrderBy!], first: Int, skip: Int): [${typeName}!]!`);
    queryFieldDefs.push(`${apiKey}(id: ID, filter: ${typeName}Filter): ${typeName}`);
    queryFieldDefs.push(`_all${typeName}sMeta(filter: ${typeName}Filter): ${typeName}Meta!`);

    // Resolvers
    resolvers.Query[listName] = (_: any, args: any) => {
      let records = db.select().from(table).all();
      records = applyFilters(records, args.filter);
      records = applyOrdering(records, args.orderBy);
      const skip = args.skip ?? 0;
      const first = args.first ?? Math.min(records.length, 500);
      return records.slice(skip, skip + first);
    };

    resolvers.Query[apiKey] = (_: any, args: any) => {
      if (args.id) {
        return db.select().from(table).where(eq(table.id, args.id)).get() ?? null;
      }
      if (args.filter) {
        let records = db.select().from(table).all();
        records = applyFilters(records, args.filter);
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

  if (Object.keys(queryFieldDefs).length === 0) {
    queryFieldDefs.push("_empty: String");
    resolvers.Query._empty = () => null;
  }

  const typeDefs = `
    ${typeDefinitions.join("\n\n")}
    type Query {
      ${queryFieldDefs.join("\n      ")}
    }
  `;

  return createSchema({ typeDefs, resolvers });
}
