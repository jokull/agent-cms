import { createYoga, type YogaSchemaDefinition } from "graphql-yoga";
import { Effect, Layer } from "effect";
import { GraphQLError, type GraphQLSchema } from "graphql";
import { SqlClient } from "@effect/sql";
import { buildGraphQLSchema } from "./schema-builder.js";
import { enforceQueryLimits } from "./query-limits.js";
import { getSqlMetrics, withSqlMetrics } from "./sql-metrics.js";

export interface GraphQLContext {
  includeDrafts: boolean;
}

export interface GraphQLHandlerOptions {
  assetBaseUrl?: string;
  assetPathPrefix?: string;
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
  const queryLimits = {
    maxDepth: 12,
    maxSelections: 250,
  } as const;

  let schemaPromise: Promise<GraphQLSchema> | null = null;

  function getSchema() {
    if (!schemaPromise) {
      schemaPromise = Effect.runPromise(
        buildGraphQLSchema(sqlLayer, {
          assetBaseUrl: options?.assetBaseUrl,
          assetPathPrefix: options?.assetPathPrefix,
          isProduction: options?.isProduction,
        }).pipe(Effect.provide(sqlLayer), Effect.orDie)
      ).catch((error) => {
        schemaPromise = null;
        throw error;
      });
    }
    return schemaPromise;
  }

  const yoga = createYoga({
    // Yoga's schema function type expects the full context, but our schema is context-agnostic
    schema: (() => getSchema()) as YogaSchemaDefinition<object, GraphQLContext>,
    graphqlEndpoint: "/graphql",
    landingPage: true,
    plugins: [{
      onParams({ params, setResult }) {
        if (typeof params.query !== "string") return;
        const errors = enforceQueryLimits(params.query, queryLimits);
        if (errors.length > 0) {
          setResult({ errors: errors as GraphQLError[] });
        }
      },
    }],
    context: ({ request }: { request: Request }) => {
      const includeDrafts = request.headers.get("X-Include-Drafts") === "true";
      return { includeDrafts } satisfies GraphQLContext;
    },
  });

  return async (request: Request): Promise<Response> => {
    return withSqlMetrics(async () => {
      const response = await yoga.handle(request);
      if (request.headers.get("X-Debug-Sql") !== "true") {
        return response;
      }

      const metrics = getSqlMetrics();
      if (!metrics) return response;

      const headers = new Headers(response.headers);
      headers.set("X-Sql-Statement-Count", String(metrics.statementCount));
      headers.set("X-Sql-Total-Ms", metrics.totalDurationMs.toFixed(3));
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    });
  };
}
