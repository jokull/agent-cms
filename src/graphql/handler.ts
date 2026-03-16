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
  let cachedSchema: ReturnType<typeof buildGraphQLSchema> extends Effect.Effect<infer A, any, any> ? A : never;

  const yoga = createYoga({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Yoga's schema generic doesn't align with our context type
    schema: (() => {
      if (!cachedSchema) {
        cachedSchema = Effect.runSync(
          buildGraphQLSchema(sqlLayer).pipe(Effect.provide(sqlLayer))
        );
      }
      return cachedSchema;
    }) as any,
    graphqlEndpoint: "/graphql",
    landingPage: true, // Enable GraphiQL playground
    context: ({ request }: { request: Request }) => {
      const includeDrafts = request.headers.get("X-Include-Drafts") === "true";
      return { includeDrafts } satisfies GraphQLContext;
    },
  });

  return async (request: Request): Promise<Response> => {
    return yoga.handle(request);
  };
}
