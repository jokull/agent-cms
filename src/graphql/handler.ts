import { createYoga } from "graphql-yoga";
import * as schema from "../db/schema.js";
import { generateSchema } from "../schema-engine/index.js";
import { buildGraphQLSchema } from "./schema-builder.js";

/**
 * Create a GraphQL Yoga handler that dynamically builds the schema
 * from current CMS metadata on each request.
 *
 * In production, the schema would be cached and rebuilt only on changes.
 * For now, we rebuild on every request for correctness.
 */
export function createGraphQLHandler(db: any) {
  return createYoga({
    schema: () => {
      const allModels = db.select().from(schema.models).all();
      const allFields = db.select().from(schema.fields).all();
      const generated = generateSchema(allModels as any, allFields as any);
      return buildGraphQLSchema(generated, db);
    },
    graphqlEndpoint: "/graphql",
    // Disable landing page in production
    landingPage: false,
  });
}
