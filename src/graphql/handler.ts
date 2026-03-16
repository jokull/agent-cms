import { createYoga, type YogaSchemaDefinition } from "graphql-yoga";
import { Effect, Layer } from "effect";
import { SqlClient } from "@effect/sql";
import { buildGraphQLSchema } from "./schema-builder.js";

export interface GraphQLContext {
  includeDrafts: boolean;
}

export interface GraphQLHandlerOptions {
  assetBaseUrl?: string;
  isProduction?: boolean;
}

/**
 * Create a GraphQL Yoga web handler.
 * Reads X-Include-Drafts header and passes it to resolvers via context.
 * Schema is built async (required for D1's async SqlClient).
 */
export function createGraphQLHandler(
  sqlLayer: Layer.Layer<SqlClient.SqlClient>,
  options?: GraphQLHandlerOptions
) {
  function getSchema() {
    return Effect.runPromise(
      buildGraphQLSchema(sqlLayer, {
        assetBaseUrl: options?.assetBaseUrl,
        isProduction: options?.isProduction,
      }).pipe(Effect.provide(sqlLayer), Effect.orDie)
    );
  }

  const yoga = createYoga({
    // Yoga's schema function type expects the full context, but our schema is context-agnostic
    schema: (() => getSchema()) as YogaSchemaDefinition<object, GraphQLContext>,
    graphqlEndpoint: "/graphql",
    landingPage: true,
    context: ({ request }: { request: Request }) => {
      const includeDrafts = request.headers.get("X-Include-Drafts") === "true";
      return { includeDrafts } satisfies GraphQLContext;
    },
  });

  return async (request: Request): Promise<Response> => {
    return yoga.handle(request);
  };
}
