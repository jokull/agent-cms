import { createYoga, type YogaSchemaDefinition } from "graphql-yoga";
import { Effect, Layer } from "effect";
import { type GraphQLSchema, parse, execute as gqlExecute, validate } from "graphql";
import { SqlClient } from "@effect/sql";
import { buildGraphQLSchema } from "./schema-builder.js";
import { enforceQueryLimits } from "./query-limits.js";
import { getSqlMetrics, withSqlMetrics } from "./sql-metrics.js";

export type CredentialType = "admin" | "editor" | null;

export interface GraphQLContext {
  includeDrafts: boolean;
  excludeInvalid: boolean;
}

export interface GraphQLHandlerOptions {
  assetBaseUrl?: string;
  assetPathPrefix?: string;
  isProduction?: boolean;
}

interface SchemaTiming {
  cacheHit: boolean;
  buildMs: number;
  waitMs: number;
}

interface GraphqlRequestBody {
  operationName?: string | null;
  query?: string | null;
}

function isGraphqlRequestBody(value: unknown): value is GraphqlRequestBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const operationNameValid = record.operationName === undefined || record.operationName === null || typeof record.operationName === "string";
  const queryValid = record.query === undefined || record.query === null || typeof record.query === "string";
  return operationNameValid && queryValid;
}

function inferOperationName(query: string | null | undefined): string | null {
  if (!query) return null;
  const match = query.match(/\b(query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  return match?.[2] ?? null;
}

/**
 * Create a GraphQL Yoga web handler.
 * Reads X-Include-Drafts / X-Exclude-Invalid headers and passes them to resolvers via context.
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
  let schemaBuildCount = 0;
  let lastSchemaBuildMs = 0;

  function getSchema() {
    if (!schemaPromise) {
      const buildStartedAt = performance.now();
      schemaPromise = Effect.runPromise(
        buildGraphQLSchema(sqlLayer, {
          assetBaseUrl: options?.assetBaseUrl,
          assetPathPrefix: options?.assetPathPrefix,
          isProduction: options?.isProduction,
        }).pipe(Effect.provide(sqlLayer), Effect.orDie)
      ).then((schema) => {
        lastSchemaBuildMs = Number((performance.now() - buildStartedAt).toFixed(3));
        schemaBuildCount += 1;
        return schema;
      }).catch((error) => {
        schemaPromise = null;
        throw error;
      });
    }
    return schemaPromise;
  }

  async function getSchemaTiming(): Promise<SchemaTiming> {
    const cacheHit = schemaPromise !== null;
    const startedAt = performance.now();
    await getSchema();
    return {
      cacheHit,
      buildMs: cacheHit ? 0 : lastSchemaBuildMs,
      waitMs: Number((performance.now() - startedAt).toFixed(3)),
    };
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
          setResult({ errors: errors });
        }
      },
    }],
    context: ({ request }: { request: Request }) => {
      const credentialType = request.headers.get("X-Credential-Type") as CredentialType;
      const headerDrafts = request.headers.get("X-Include-Drafts") === "true";
      // Editor tokens always see drafts; admin respects header; no credential = published only
      const includeDrafts = credentialType === "editor" ? true
        : credentialType === "admin" ? headerDrafts
        : false;
      const excludeInvalid = request.headers.get("X-Exclude-Invalid") === "true";
      return { includeDrafts, excludeInvalid } satisfies GraphQLContext;
    },
  });

  function invalidateSchema() {
    schemaPromise = null;
  }

  const handle = async (request: Request): Promise<Response> => {
    return withSqlMetrics(async () => {
      const traceEnabled = request.headers.get("X-Bench-Trace") === "1" || request.headers.get("X-Debug-Sql") === "true";
      const traceId = request.headers.get("X-Trace-Id") ?? crypto.randomUUID();
      let operationName: string | null = null;

      if (traceEnabled) {
        try {
          const body = await request.clone().json();
          if (isGraphqlRequestBody(body)) {
            operationName = body.operationName ?? inferOperationName(body.query);
          }
        } catch {
          operationName = null;
        }
      }

      const requestStartedAt = performance.now();
      const schemaTiming = await getSchemaTiming();
      const yogaStartedAt = performance.now();
      const response = await yoga.handle(request);
      const yogaMs = Number((performance.now() - yogaStartedAt).toFixed(3));
      const requestMs = Number((performance.now() - requestStartedAt).toFixed(3));

      const metrics = getSqlMetrics();
      const headers = new Headers(response.headers);
      headers.set("X-Trace-Id", traceId);
      if (metrics) {
        headers.set("X-Sql-Statement-Count", String(metrics.statementCount));
        headers.set("X-Sql-Total-Ms", metrics.totalDurationMs.toFixed(3));
        headers.set("X-Sql-Slowest-Ms", metrics.slowestSamplesMs.map((value) => value.toFixed(3)).join(","));
      }

      if (traceEnabled) {
        headers.set("X-Cms-Request-Ms", requestMs.toFixed(3));
        headers.set("X-Cms-Yoga-Ms", yogaMs.toFixed(3));
        headers.set("X-Cms-Schema-Wait-Ms", schemaTiming.waitMs.toFixed(3));
        headers.set("X-Cms-Schema-Build-Ms", schemaTiming.buildMs.toFixed(3));
        headers.set("X-Cms-Schema-Cache", schemaTiming.cacheHit ? "hit" : "miss");
        headers.set("X-Cms-Schema-Build-Count", String(schemaBuildCount));
        const serverTiming = [
          `cms-total;dur=${requestMs.toFixed(3)}`,
          `cms-schema;dur=${schemaTiming.waitMs.toFixed(3)};desc="${schemaTiming.cacheHit ? "hit" : "miss"}"`,
          `cms-yoga;dur=${yogaMs.toFixed(3)}`,
          `cms-sql;dur=${metrics?.totalDurationMs.toFixed(3) ?? "0.000"}`,
        ];
        headers.set("Server-Timing", serverTiming.join(", "));
        console.info(JSON.stringify({
          scope: "cms.graphql",
          traceId,
          operationName,
          status: response.status,
          requestMs,
          yogaMs,
          schemaWaitMs: schemaTiming.waitMs,
          schemaBuildMs: schemaTiming.buildMs,
          schemaCache: schemaTiming.cacheHit ? "hit" : "miss",
          schemaBuildCount,
          sqlStatementCount: metrics?.statementCount ?? 0,
          sqlTotalMs: metrics?.totalDurationMs ?? 0,
          sqlSlowestSamplesMs: metrics?.slowestSamplesMs ?? [],
        }));
      } else if (request.headers.get("X-Debug-Sql") !== "true") {
        return response;
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    });
  };

  async function execute(
    query: string,
    variables?: Record<string, unknown>,
    context?: { includeDrafts?: boolean; excludeInvalid?: boolean }
  ): Promise<{ data: unknown; errors?: ReadonlyArray<{ message: string }> }> {
    const schema = await getSchema();
    const document = parse(query);
    const validationErrors = validate(schema, document);
    if (validationErrors.length > 0) {
      return { data: null, errors: validationErrors.map((e) => ({ message: e.message })) };
    }
    const result = await gqlExecute({
      schema,
      document,
      variableValues: variables,
      contextValue: {
        includeDrafts: context?.includeDrafts ?? false,
        excludeInvalid: context?.excludeInvalid ?? false,
      },
    });
    return result as { data: unknown; errors?: ReadonlyArray<{ message: string }> };
  }

  return { handle, getSchema, invalidateSchema, execute };
}
