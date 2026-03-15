import { createSchema } from "graphql-yoga";
import type { GeneratedSchema, FieldRow } from "../schema-engine/index.js";
import { eq } from "drizzle-orm";

/** Map CMS field types to GraphQL SDL types */
function fieldTypeToSDL(fieldType: string): string {
  switch (fieldType) {
    case "string":
    case "text":
    case "slug":
    case "media":
    case "link":
      return "String";
    case "boolean":
      return "Boolean";
    case "integer":
      return "Int";
    case "media_gallery":
    case "links":
    case "structured_text":
      return "JSON";
    default:
      return "String";
  }
}

/**
 * Build a GraphQL schema from CMS metadata using SDL (schema definition language).
 * This avoids the CJS/ESM graphql module duplication issue by using Yoga's createSchema.
 */
export function buildGraphQLSchema(generated: GeneratedSchema, db: any) {
  const typeDefinitions: string[] = [];
  const queryFieldDefs: string[] = [];
  const resolvers: Record<string, any> = { Query: {} };

  // JSON scalar
  typeDefinitions.push("scalar JSON");

  for (const [apiKey, model] of generated.models) {
    if (model.isBlock) continue;

    const fields = generated.fields.get(apiKey) ?? [];
    const table = generated.tables.get(apiKey);
    if (!table) continue;

    const typeName =
      apiKey.charAt(0).toUpperCase() +
      apiKey.slice(1).replace(/_([a-z])/g, (_, c) => c.toUpperCase());

    // Build type definition
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

    // Meta type
    typeDefinitions.push(`type ${typeName}Meta {\n  count: Int!\n}`);

    // Query fields
    const listName = `all${typeName}s`;
    queryFieldDefs.push(`${listName}(first: Int, skip: Int): [${typeName}!]!`);
    queryFieldDefs.push(`${apiKey}(id: ID): ${typeName}`);
    queryFieldDefs.push(`_all${typeName}sMeta: ${typeName}Meta!`);

    // Resolvers
    resolvers.Query[listName] = (_: any, args: { first?: number; skip?: number }) => {
      const records = db.select().from(table).all();
      const skip = args.skip ?? 0;
      const first = args.first ?? records.length;
      return records.slice(skip, skip + first);
    };

    resolvers.Query[apiKey] = (_: any, args: { id?: string }) => {
      if (!args.id) return null;
      return db.select().from(table).where(eq(table.id, args.id)).get() ?? null;
    };

    resolvers.Query[`_all${typeName}sMeta`] = () => {
      const records = db.select().from(table).all();
      return { count: records.length };
    };
  }

  // If no models, add placeholder
  if (queryFieldDefs.length === 0) {
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
