import { createYoga } from "graphql-yoga";
import { Effect, Layer } from "effect";
import { SqlClient } from "@effect/sql";
import { buildGraphQLSchema } from "./schema-builder.js";

export interface GraphQLContext {
  includeDrafts: boolean;
}

/**
 * Create a GraphQL Yoga web handler.
 * Reads X-Include-Drafts header and passes it to resolvers via context.
 */
export function createGraphQLHandler(sqlLayer: Layer.Layer<SqlClient.SqlClient>) {
  const yoga = createYoga<GraphQLContext>({
    schema: () => {
      return Effect.runSync(
        buildGraphQLSchema(sqlLayer).pipe(Effect.provide(sqlLayer))
      );
    },
    graphqlEndpoint: "/graphql",
    landingPage: false,
    context: ({ request }) => {
      const includeDrafts = request.headers.get("X-Include-Drafts") === "true";
      return { includeDrafts };
    },
  });

  return async (request: Request): Promise<Response> => {
    return yoga.handle(request);
  };
}
