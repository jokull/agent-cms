import { createYoga, type YogaSchemaDefinition } from "graphql-yoga";
import { Effect, Layer, Logger } from "effect";
import type { DynamicRow } from "./gql-types.js";
import {
  Kind,
  type DocumentNode,
  type FragmentDefinitionNode,
  type GraphQLSchema,
  type OperationDefinitionNode,
  parse,
  print,
  execute as gqlExecute,
  validate,
  visit,
} from "graphql";
import { SqlClient } from "@effect/sql";
import { buildGraphQLSchema } from "./schema-builder.js";
import { enforceQueryLimits } from "./query-limits.js";
import { getSqlMetrics, withSqlMetrics } from "./sql-metrics.js";
import { createPublishedFastPath } from "./published-fast-path.js";

export type CredentialType = "admin" | "editor" | null;

export interface GraphQLContext {
  includeDrafts: boolean;
  excludeInvalid: boolean;
  linkedRecordCache: Map<string, Promise<DynamicRow | null>>;
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
  variables?: Record<string, unknown> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGraphqlRequestBody(value: unknown): value is GraphqlRequestBody {
  if (!isRecord(value)) return false;
  const operationNameValid = value.operationName === undefined || value.operationName === null || typeof value.operationName === "string";
  const queryValid = value.query === undefined || value.query === null || typeof value.query === "string";
  const variablesValid = value.variables === undefined || value.variables === null || isRecord(value.variables);
  return operationNameValid && queryValid && variablesValid;
}

function inferOperationName(query: string | null | undefined): string | null {
  if (!query) return null;
  const match = query.match(/\b(query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  return match?.[2] ?? null;
}

function buildFragments(document: DocumentNode) {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }
  return fragments;
}

function getOperation(document: DocumentNode, operationName?: string | null): OperationDefinitionNode | null {
  const operations = document.definitions.filter((definition): definition is OperationDefinitionNode => definition.kind === Kind.OPERATION_DEFINITION);
  if (operations.length === 0) return null;
  if (!operationName) return operations.length === 1 ? operations[0] : null;
  return operations.find((operation) => operation.name?.value === operationName) ?? null;
}

function collectReferencedFragmentNames(
  selectionSet: OperationDefinitionNode["selectionSet"],
  fragments: Map<string, FragmentDefinitionNode>,
  result: Set<string>,
) {
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD && selection.selectionSet) {
      collectReferencedFragmentNames(selection.selectionSet, fragments, result);
      continue;
    }
    if (selection.kind === Kind.INLINE_FRAGMENT) {
      collectReferencedFragmentNames(selection.selectionSet, fragments, result);
      continue;
    }
    if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const name = selection.name.value;
      if (result.has(name)) continue;
      result.add(name);
      const fragment = fragments.get(name);
      if (fragment) {
        collectReferencedFragmentNames(fragment.selectionSet, fragments, result);
      }
    }
  }
}

function buildSubsetDocument(
  document: DocumentNode,
  operation: OperationDefinitionNode,
  rootSelections: OperationDefinitionNode["selectionSet"]["selections"],
): DocumentNode {
  const fragments = buildFragments(document);
  const includedFragments = new Set<string>();
  collectReferencedFragmentNames({ kind: Kind.SELECTION_SET, selections: rootSelections }, fragments, includedFragments);

  const subsetOperation: OperationDefinitionNode = {
    ...operation,
    selectionSet: {
      kind: Kind.SELECTION_SET,
      selections: rootSelections,
    },
  };

  const subsetDocument: DocumentNode = {
    kind: Kind.DOCUMENT,
    definitions: [
      subsetOperation,
      ...[...includedFragments].map((name) => fragments.get(name)).filter((value): value is FragmentDefinitionNode => value !== undefined),
    ],
  };

  const usedVariables = new Set<string>();
  visit(subsetDocument, {
    Variable(node) {
      usedVariables.add(node.name.value);
    },
  });

  const finalizedOperation: OperationDefinitionNode = {
    ...subsetOperation,
    variableDefinitions: operation.variableDefinitions?.filter((definition) => usedVariables.has(definition.variable.name.value)),
  };

  return {
    ...subsetDocument,
    definitions: [
      finalizedOperation,
      ...subsetDocument.definitions.slice(1),
    ],
  };
}

function getRootResponseKey(selection: OperationDefinitionNode["selectionSet"]["selections"][number]) {
  return selection.kind === Kind.FIELD ? (selection.alias?.value ?? selection.name.value) : null;
}

function formatFastPathSqlBreakdown(
  metrics: {
    byCategory: Partial<Record<"metadata" | "root" | "meta" | "linked_record" | "asset", { statementCount: number; totalDurationMs: number }>>;
  },
) {
  return Object.entries(metrics.byCategory)
    .map(([category, value]) => `${category}:${value?.statementCount ?? 0}/${value?.totalDurationMs.toFixed(3) ?? "0.000"}`)
    .join(",");
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
  const runtimeLayer = Layer.merge(sqlLayer, Logger.json);
  const queryLimits = {
    maxDepth: 12,
    maxSelections: 250,
  } as const;

  let schemaBuildCount = 0;
  let lastSchemaBuildMs = 0;
  let schemaPromise: Promise<GraphQLSchema> | null = null;

  function buildSchema() {
    const buildStartedAt = performance.now();
    return Effect.runPromise(
      buildGraphQLSchema(sqlLayer, {
        assetBaseUrl: options?.assetBaseUrl,
        assetPathPrefix: options?.assetPathPrefix,
        isProduction: options?.isProduction,
      }).pipe(
        Effect.withSpan("graphql.build_schema"),
        Effect.annotateSpans({
          assetBaseUrl: options?.assetBaseUrl ?? "",
          isProduction: options?.isProduction ?? false,
        }),
        Effect.tap(() => Effect.sync(() => {
          lastSchemaBuildMs = Number((performance.now() - buildStartedAt).toFixed(3));
          schemaBuildCount += 1;
        })),
        Effect.provide(runtimeLayer),
      ),
    );
  }

  function getSchema() {
    if (!schemaPromise) {
      schemaPromise = buildSchema().catch((error) => {
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

  const publishedFastPath = createPublishedFastPath(sqlLayer, {
    assetBaseUrl: options?.assetBaseUrl,
    isProduction: options?.isProduction,
  });

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
      return {
        includeDrafts,
        excludeInvalid,
        linkedRecordCache: new Map(),
      } satisfies GraphQLContext;
    },
  });

  function invalidateSchema() {
    schemaPromise = null;
    return Promise.resolve();
  }

  function logGraphqlInfo(message: string, fields: Record<string, unknown>) {
    Effect.runFork(
      Effect.logInfo(message).pipe(
        Effect.annotateLogs(fields),
        Effect.provide(runtimeLayer),
        Effect.orDie,
      )
    );
  }

  async function executeDocument(
    document: DocumentNode,
    variables?: Record<string, unknown>,
    context?: { includeDrafts?: boolean; excludeInvalid?: boolean },
  ): Promise<{ data: unknown; errors?: ReadonlyArray<{ message: string }> }> {
    const schema = await getSchema();
    const validationErrors = validate(schema, document);
    if (validationErrors.length > 0) {
      return { data: null, errors: validationErrors.map((error) => ({ message: error.message })) };
    }
    const result = await gqlExecute({
      schema,
      document,
      variableValues: variables,
      contextValue: {
        includeDrafts: context?.includeDrafts ?? false,
        excludeInvalid: context?.excludeInvalid ?? false,
        linkedRecordCache: new Map(),
      },
    });
    return result as { data: unknown; errors?: ReadonlyArray<{ message: string }> };
  }

  async function executeWithRootFallback(
    query: string,
    variables?: Record<string, unknown>,
    context?: { includeDrafts?: boolean; excludeInvalid?: boolean },
  ): Promise<{ data: unknown; errors?: ReadonlyArray<{ message: string }>; _trace?: Record<string, unknown> }> {
    const directFastPath = await publishedFastPath.tryExecute({
      query,
      variables,
      operationName: null,
    }, {
      includeDrafts: context?.includeDrafts ?? false,
      excludeInvalid: context?.excludeInvalid ?? false,
    });
    if (directFastPath) {
      return {
        ...directFastPath.response,
        _trace: {
          path: "fast-path",
          rootPaths: Object.fromEntries(Object.keys(directFastPath.response.data).map((key) => [key, "fast-path"])),
          fastPathSql: directFastPath.metrics,
        },
      };
    }

    const document = parse(query);
    const operation = getOperation(document, null);
    if (!operation || operation.operation !== "query") {
      const yogaResult = await executeDocument(document, variables, context);
      return { ...yogaResult, _trace: { path: "yoga" } };
    }

    const rootSelections = operation.selectionSet.selections.filter((selection) => selection.kind === Kind.FIELD);
    if (rootSelections.length !== operation.selectionSet.selections.length) {
      const yogaResult = await executeDocument(document, variables, context);
      return { ...yogaResult, _trace: { path: "yoga" } };
    }

    const supportedSelections: typeof rootSelections = [];
    const unsupportedSelections: typeof rootSelections = [];
    const rootPaths: Record<string, string> = {};
    const rootReasons: Record<string, string> = {};

    for (const selection of rootSelections) {
      const subsetDocument = buildSubsetDocument(document, operation, [selection]);
      const subsetRequest = {
        query: print(subsetDocument),
        variables,
        operationName: operation.name?.value ?? null,
      };
      const subsetResult = await publishedFastPath.tryExecute(subsetRequest, {
        includeDrafts: context?.includeDrafts ?? false,
        excludeInvalid: context?.excludeInvalid ?? false,
      });
      const responseKey = getRootResponseKey(selection) ?? "unknown";
      if (subsetResult) {
        supportedSelections.push(selection);
        rootPaths[responseKey] = "fast-path";
      } else {
        unsupportedSelections.push(selection);
        rootPaths[responseKey] = "yoga";
        const supportAnalysis = await publishedFastPath.analyze(subsetRequest, {
          includeDrafts: context?.includeDrafts ?? false,
          excludeInvalid: context?.excludeInvalid ?? false,
        });
        if (supportAnalysis.reason) {
          rootReasons[responseKey] = supportAnalysis.reason;
        }
      }
    }

    if (supportedSelections.length === 0) {
      const yogaResult = await executeDocument(document, variables, context);
      return { ...yogaResult, _trace: { path: "yoga", rootPaths, rootReasons } };
    }

    const mergedData: Record<string, unknown> = {};
    const mergedErrors: Array<{ message: string }> = [];
    let fastPathMetrics: Record<string, unknown> | undefined;

    const supportedDocument = buildSubsetDocument(document, operation, supportedSelections);
    const supportedCombinedResult = await publishedFastPath.tryExecute({
      query: print(supportedDocument),
      variables,
      operationName: operation.name?.value ?? null,
    }, {
      includeDrafts: context?.includeDrafts ?? false,
      excludeInvalid: context?.excludeInvalid ?? false,
    });

    if (supportedCombinedResult) {
      Object.assign(mergedData, supportedCombinedResult.response.data);
      fastPathMetrics = supportedCombinedResult.metrics as unknown as Record<string, unknown>;
    } else {
      for (const selection of supportedSelections) {
        const subsetDocument = buildSubsetDocument(document, operation, [selection]);
        const subsetResult = await publishedFastPath.tryExecute({
          query: print(subsetDocument),
          variables,
          operationName: operation.name?.value ?? null,
        }, {
          includeDrafts: context?.includeDrafts ?? false,
          excludeInvalid: context?.excludeInvalid ?? false,
        });
        if (subsetResult) {
          Object.assign(mergedData, subsetResult.response.data);
        }
      }
    }

    if (unsupportedSelections.length > 0) {
      const unsupportedDocument = buildSubsetDocument(document, operation, unsupportedSelections);
      const unsupportedResult = await executeDocument(unsupportedDocument, variables, context);
      if (unsupportedResult.data && typeof unsupportedResult.data === "object" && unsupportedResult.data !== null) {
        Object.assign(mergedData, unsupportedResult.data as Record<string, unknown>);
      }
      if (unsupportedResult.errors) {
        mergedErrors.push(...unsupportedResult.errors);
      }
    }

    return {
      data: mergedData,
      ...(mergedErrors.length > 0 ? { errors: mergedErrors } : {}),
      _trace: {
        path: unsupportedSelections.length > 0 ? "partial" : "fast-path",
        rootPaths,
        rootReasons,
        fastPathSql: fastPathMetrics,
      },
    };
  }

  const handle = async (request: Request): Promise<Response> => {
    const debugSql = request.headers.get("X-Debug-Sql") === "true";
    const traceEnabled = request.headers.get("X-Bench-Trace") === "1" || debugSql;

    if (!traceEnabled) {
      const credentialType = request.headers.get("X-Credential-Type") as CredentialType;
      const headerDrafts = request.headers.get("X-Include-Drafts") === "true";
      const includeDrafts = credentialType === "editor" ? true
        : credentialType === "admin" ? headerDrafts
        : false;
      const excludeInvalid = request.headers.get("X-Exclude-Invalid") === "true";
      const contentType = request.headers.get("content-type") ?? "";
      if (request.method === "POST" && contentType.includes("application/json")) {
        try {
          const body = await request.clone().json();
          if (isGraphqlRequestBody(body) && typeof body.query === "string") {
            const errors = enforceQueryLimits(body.query, queryLimits);
            if (errors.length === 0) {
              const fastPathResult = await publishedFastPath.tryExecute({
                query: body.query,
                variables: body.variables ?? undefined,
                operationName: body.operationName,
              }, {
                includeDrafts,
                excludeInvalid,
              });
              if (fastPathResult) {
                return Response.json(fastPathResult.response, {
                  headers: {
                    "X-Published-Fast-Path": "hit",
                    "X-Published-Fast-Path-Sql-Count": String(fastPathResult.metrics.statementCount),
                    "X-Published-Fast-Path-Sql-Total-Ms": fastPathResult.metrics.totalDurationMs.toFixed(3),
                    "X-Published-Fast-Path-Sql-Breakdown": formatFastPathSqlBreakdown(fastPathResult.metrics),
                  },
                });
              }
            }
          }
        } catch {
          // Fall through to Yoga when the request body is unsupported.
        }
      }
      return yoga.handle(request);
    }

    return withSqlMetrics(async () => {
      const traceId = request.headers.get("X-Trace-Id") ?? crypto.randomUUID();
      let operationName: string | null = null;

      try {
        const body = await request.clone().json();
        if (isGraphqlRequestBody(body)) {
          operationName = body.operationName ?? inferOperationName(body.query);
        }
      } catch {
        operationName = null;
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
      logGraphqlInfo("graphql request completed", {
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
      });

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
  ): Promise<{ data: unknown; errors?: ReadonlyArray<{ message: string }>; _trace?: Record<string, unknown> }> {
    return executeWithRootFallback(query, variables, context);
  }

  return { handle, getSchema, invalidateSchema, execute };
}
