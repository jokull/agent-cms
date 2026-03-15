import { createYoga } from "graphql-yoga";
import { Effect, Layer } from "effect";
import { SqlClient } from "@effect/sql";
import { buildGraphQLSchema } from "./schema-builder.js";

/**
 * Create a GraphQL Yoga web handler.
 */
export function createGraphQLHandler(sqlLayer: Layer.Layer<SqlClient.SqlClient>) {
  const yoga = createYoga({
    schema: () => {
      return Effect.runSync(
        buildGraphQLSchema(sqlLayer).pipe(Effect.provide(sqlLayer))
      );
    },
    graphqlEndpoint: "/graphql",
    landingPage: false,
  });

  return async (request: Request): Promise<Response> => {
    return yoga.handle(request);
  };
}
