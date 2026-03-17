import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpApp,
  HttpServerError,
} from "@effect/platform";
import { Cause, Effect, Layer, Schema, Option } from "effect";
import { SqlClient } from "@effect/sql";
import * as ModelService from "../services/model-service.js";
import * as FieldService from "../services/field-service.js";
import * as RecordService from "../services/record-service.js";
import * as PublishService from "../services/publish-service.js";
import * as AssetService from "../services/asset-service.js";
import * as LocaleService from "../services/locale-service.js";
import { isCmsError, errorToResponse } from "../errors.js";
import { ReorderInput } from "../services/input-schemas.js";
import { ValidationError } from "../errors.js";
import * as SchemaIO from "../services/schema-io.js";
import * as VersionService from "../services/version-service.js";
import * as SearchService from "../search/search-service.js";
import type { AiBinding, VectorizeBinding } from "../search/vectorize.js";
import { VectorizeContext } from "../search/vectorize-context.js";
import { HooksContext, type CmsHooks } from "../hooks.js";

function describeUnknown(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function getRequestIdFromHeaders(headers: Headers | globalThis.Headers): string {
  return headers.get("x-request-id") ?? headers.get("cf-ray") ?? crypto.randomUUID();
}

function logEvent(level: "info" | "error", message: string, fields: Record<string, unknown>) {
  const payload = {
    level,
    message,
    ...fields,
  };
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
  } else {
    console.info(line);
  }
}

/** Helper: run a CMS Effect and return an HTTP response */
function handle<A>(
  effect: Effect.Effect<A, unknown, SqlClient.SqlClient>,
  status: number = 200
) {
  return effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json(result, { status })),
    Effect.tapErrorCause((cause) => Effect.logError("REST effect failed", Cause.pretty(cause))),
    Effect.catchAll((error: unknown) => {
      if (isCmsError(error)) {
        const mapped = errorToResponse(error);
        return HttpServerResponse.json(mapped.body, { status: mapped.status });
      }
      console.error("Unhandled error:", error);
      return HttpServerResponse.json({ error: "Internal server error" }, { status: 500 });
    }),
    Effect.catchAllDefect((defect: unknown) => {
      console.error("Defect:", defect);
      return HttpServerResponse.json({ error: "Internal server error" }, { status: 500 });
    })
  );
}

/** Extract a required path parameter, defaulting to empty string if missing */
function param(params: Record<string, string | undefined>, name: string): string {
  return params[name] ?? "";
}

/** Get query param */
function queryParam(name: string) {
  return Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(req.url, "http://localhost");
    return url.searchParams.get(name) ?? "";
  });
}

// --- Models ---
const modelsRouter = HttpRouter.empty.pipe(
  HttpRouter.get("/", handle(ModelService.listModels())),

  HttpRouter.post(
    "/",
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* req.json;
      return yield* handle(ModelService.createModel(body), 201);
    })
  ),

  HttpRouter.get(
    "/:id",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      return yield* handle(ModelService.getModel(param(params, "id")));
    })
  ),

  HttpRouter.patch(
    "/:id",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const req = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* req.json;
      return yield* handle(ModelService.updateModel(param(params, "id"), typeof body === "object" && body !== null ? Object.fromEntries(Object.entries(body)) : {}));
    })
  ),

  HttpRouter.del(
    "/:id",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      return yield* handle(ModelService.deleteModel(param(params, "id")));
    })
  )
);

// --- Fields ---
const fieldsRouter = HttpRouter.empty.pipe(
  HttpRouter.get(
    "/models/:modelId/fields",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      return yield* handle(FieldService.listFields(param(params, "modelId")));
    })
  ),

  HttpRouter.post(
    "/models/:modelId/fields",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const req = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* req.json;
      return yield* handle(FieldService.createField(param(params, "modelId"), body), 201);
    })
  ),

  HttpRouter.patch(
    "/models/:modelId/fields/:fieldId",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const req = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* req.json;
      return yield* handle(FieldService.updateField(param(params, "fieldId"), typeof body === "object" && body !== null ? Object.fromEntries(Object.entries(body)) : {}));
    })
  ),

  HttpRouter.del(
    "/models/:modelId/fields/:fieldId",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      return yield* handle(FieldService.deleteField(param(params, "fieldId")));
    })
  )
);

// --- Records ---
const recordsRouter = HttpRouter.empty.pipe(
  HttpRouter.post(
    "/records/bulk",
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* req.json;
      return yield* handle(RecordService.bulkCreateRecords(body), 201);
    })
  ),

  HttpRouter.post(
    "/records",
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* req.json;
      return yield* handle(RecordService.createRecord(body), 201);
    })
  ),

  HttpRouter.get(
    "/records",
    Effect.gen(function* () {
      const modelApiKey = yield* queryParam("modelApiKey");
      return yield* handle(RecordService.listRecords(modelApiKey));
    })
  ),

  // --- Versions (must be before /records/:id) ---
  HttpRouter.get(
    "/records/:id/versions",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const modelApiKey = yield* queryParam("modelApiKey");
      return yield* handle(VersionService.listVersions(modelApiKey, param(params, "id")));
    })
  ),

  HttpRouter.get(
    "/records/:id/versions/:versionId",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      return yield* handle(VersionService.getVersion(param(params, "versionId")));
    })
  ),

  HttpRouter.post(
    "/records/:id/versions/:versionId/restore",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const modelApiKey = yield* queryParam("modelApiKey");
      return yield* handle(VersionService.restoreVersion(modelApiKey, param(params, "id"), param(params, "versionId")));
    })
  ),

  HttpRouter.get(
    "/records/:id",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const modelApiKey = yield* queryParam("modelApiKey");
      return yield* handle(RecordService.getRecord(modelApiKey, param(params, "id")));
    })
  ),

  HttpRouter.patch(
    "/records/:id",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const req = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* req.json;
      return yield* handle(RecordService.patchRecord(param(params, "id"), body));
    })
  ),

  HttpRouter.del(
    "/records/:id",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const modelApiKey = yield* queryParam("modelApiKey");
      return yield* handle(RecordService.removeRecord(modelApiKey, param(params, "id")));
    })
  ),

  // Publish / Unpublish
  HttpRouter.post(
    "/records/:id/publish",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const modelApiKey = yield* queryParam("modelApiKey");
      return yield* handle(PublishService.publishRecord(modelApiKey, param(params, "id")));
    })
  ),

  HttpRouter.post(
    "/records/:id/unpublish",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const modelApiKey = yield* queryParam("modelApiKey");
      return yield* handle(PublishService.unpublishRecord(modelApiKey, param(params, "id")));
    })
  ),

  // Reorder
  HttpRouter.post(
    "/reorder",
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const rawBody: unknown = yield* req.json;
      return yield* handle(
        Effect.gen(function* () {
          const { modelApiKey, recordIds } = yield* Schema.decodeUnknown(ReorderInput)(rawBody).pipe(
            Effect.mapError((e) => new ValidationError({ message: `Invalid input: ${e.message}` }))
          );
          return yield* RecordService.reorderRecords(modelApiKey, recordIds);
        })
      );
    })
  )
);

// --- Assets ---
const assetsRouter = HttpRouter.empty.pipe(
  HttpRouter.get("/", handle(AssetService.listAssets())),

  HttpRouter.post(
    "/",
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* req.json;
      return yield* handle(AssetService.createAsset(body), 201);
    })
  ),

  HttpRouter.get(
    "/:id",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      return yield* handle(AssetService.getAsset(param(params, "id")));
    })
  ),

  HttpRouter.put(
    "/:id",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const req = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* req.json;
      return yield* handle(AssetService.replaceAsset(param(params, "id"), body));
    })
  ),

  HttpRouter.del(
    "/:id",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      return yield* handle(AssetService.deleteAsset(param(params, "id")));
    })
  )
);

// --- Locales ---
const localesRouter = HttpRouter.empty.pipe(
  HttpRouter.get("/", handle(LocaleService.listLocales())),
  HttpRouter.post(
    "/",
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* req.json;
      return yield* handle(LocaleService.createLocale(body), 201);
    })
  ),
  HttpRouter.del(
    "/:id",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      return yield* handle(LocaleService.deleteLocale(param(params, "id")));
    })
  )
);

// --- Schema Import/Export ---
const schemaRouter = HttpRouter.empty.pipe(
  HttpRouter.get("/", handle(SchemaIO.exportSchema())),

  HttpRouter.post(
    "/",
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* req.json;
      return yield* handle(SchemaIO.importSchema(body), 201);
    })
  )
);

// --- Search ---
const searchRouter = HttpRouter.empty.pipe(
  HttpRouter.post(
    "/",
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* req.json;
      const SearchInput = Schema.Struct({
        query: Schema.String,
        modelApiKey: Schema.optional(Schema.String),
        first: Schema.optional(Schema.Number),
        skip: Schema.optional(Schema.Number),
        mode: Schema.optional(Schema.Literal("keyword", "semantic", "hybrid")),
      });
      const parsed = yield* Schema.decodeUnknown(SearchInput)(body).pipe(
        Effect.mapError((e) => new ValidationError({ message: `Invalid search input: ${e.message}` }))
      );
      return yield* handle(SearchService.search(parsed));
    })
  ),

  HttpRouter.post(
    "/reindex",
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* req.json;
      const ReindexInput = Schema.Struct({
        modelApiKey: Schema.optional(Schema.String),
      });
      const parsed = yield* Schema.decodeUnknown(ReindexInput)(body).pipe(
        Effect.mapError((e) => new ValidationError({ message: `Invalid input: ${e.message}` }))
      );
      const modelApiKey = parsed.modelApiKey;
      return yield* handle(SearchService.reindexAll(modelApiKey));
    })
  )
);

// --- Health ---
const healthRouter = HttpRouter.empty.pipe(
  HttpRouter.get("/health", HttpServerResponse.json({ status: "ok" }))
);

// --- Combine all routes ---
export const appRouter = HttpRouter.empty.pipe(
  HttpRouter.concat(healthRouter),
  HttpRouter.concat(modelsRouter.pipe(HttpRouter.prefixAll("/api/models"))),
  HttpRouter.concat(fieldsRouter.pipe(HttpRouter.prefixAll("/api"))),
  HttpRouter.concat(recordsRouter.pipe(HttpRouter.prefixAll("/api"))),
  HttpRouter.concat(assetsRouter.pipe(HttpRouter.prefixAll("/api/assets"))),
  HttpRouter.concat(localesRouter.pipe(HttpRouter.prefixAll("/api/locales"))),
  HttpRouter.concat(schemaRouter.pipe(HttpRouter.prefixAll("/api/schema"))),
  HttpRouter.concat(searchRouter.pipe(HttpRouter.prefixAll("/api/search"))),
);

/**
 * Create a web handler from the router + a SqlClient layer.
 * Includes GraphQL endpoint via Yoga.
 * Uses Effect.flatten to work around @effect/platform 0.94.5 nested Effect issue.
 */
export interface WebHandlerOptions {
  assetBaseUrl?: string;
  isProduction?: boolean;
  /** Read API key — if set, required for GraphQL reads (like DatoCMS CDA token) */
  readKey?: string;
  /** Write API key — if set, required for REST writes, MCP, publish/unpublish (like DatoCMS CMA token) */
  writeKey?: string;
  /** R2 bucket for serving asset files */
  r2Bucket?: R2Bucket;
  /** Workers AI binding for embedding generation (optional — enables vector search) */
  ai?: AiBinding;
  /** Vectorize index binding (optional — enables semantic search) */
  vectorize?: VectorizeBinding;
  /** Lifecycle hooks fired on content events */
  hooks?: CmsHooks;
}

export function createWebHandler(sqlLayer: Layer.Layer<SqlClient.SqlClient>, options?: WebHandlerOptions) {
  const vectorizeLayer = Layer.succeed(
    VectorizeContext,
    options?.ai && options?.vectorize
      ? Option.some({ ai: options.ai, vectorize: options.vectorize })
      : Option.none()
  );
  const hooksLayer = Layer.succeed(
    HooksContext,
    options?.hooks ? Option.some(options.hooks) : Option.none()
  );
  const fullLayer = Layer.merge(Layer.merge(sqlLayer, vectorizeLayer), hooksLayer);

  const restApp = Effect.flatten(HttpRouter.toHttpApp(appRouter)).pipe(
    Effect.catchAll((error: unknown) => {
      if (isCmsError(error)) {
        const mapped = errorToResponse(error);
        return HttpServerResponse.json(mapped.body, { status: mapped.status });
      }
      // RouteNotFound from @effect/platform router
      if (error instanceof HttpServerError.RouteNotFound) {
        return HttpServerResponse.json({ error: "Not found" }, { status: 404 });
      }
      console.error("REST handler error:", error);
      return HttpServerResponse.json({ error: "Internal server error" }, { status: 500 });
    }),
    Effect.provide(fullLayer)
  );
  // @effect/platform router type variance requires this assertion
  const restHandler = HttpApp.toWebHandler(restApp as HttpApp.Default);

  // Lazy-import handlers to avoid circular deps
  let graphqlHandler: ((req: Request) => Promise<Response>) | null = null;
  let mcpHandler: ((req: Request) => Promise<Response>) | null = null;

  function invalidateGraphqlSchemaCache() {
    graphqlHandler = null;
  }

  function isSchemaMutationRequest(url: URL, method: string): boolean {
    if (!["POST", "PATCH", "DELETE"].includes(method)) return false;
    return (
      url.pathname.startsWith("/api/models") ||
      url.pathname.startsWith("/api/locales") ||
      url.pathname.startsWith("/api/schema")
    );
  }

  /** Add CORS headers to a response */
  function withCors(response: Response, request: Request): Response {
    const origin = request.headers.get("Origin") ?? "*";
    const headers = new Headers(response.headers);
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, X-Include-Drafts, Authorization");
    headers.set("Access-Control-Max-Age", "86400");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  /**
   * Extract Bearer token from Authorization header.
   * Accepts: "Bearer <token>" or raw "<token>"
   */
  function getBearerToken(request: Request): string | null {
    const header = request.headers.get("Authorization");
    if (!header) return null;
    if (header.startsWith("Bearer ")) return header.slice(7);
    return header;
  }

  /**
   * Check if a request is authorized for the given access level.
   * If no keys are configured, all requests are allowed (local dev).
   */
  function checkAuth(request: Request, level: "read" | "write"): Response | null {
    const token = getBearerToken(request);

    if (level === "write" && options?.writeKey) {
      if (token !== options.writeKey) {
        return new Response(JSON.stringify({ error: "Unauthorized. Provide a valid write API key via Authorization: Bearer <key>" }), {
          status: 401, headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (level === "read" && options?.readKey) {
      // Write key also grants read access
      if (token !== options.readKey && token !== options?.writeKey) {
        return new Response(JSON.stringify({ error: "Unauthorized. Provide a valid API key via Authorization: Bearer <key>" }), {
          status: 401, headers: { "Content-Type": "application/json" },
        });
      }
    }

    return null; // authorized
  }

  return async (request: Request): Promise<Response> => {
    const requestId = getRequestIdFromHeaders(request.headers);
    const headers = new Headers(request.headers);
    headers.set("x-request-id", requestId);
    const instrumentedRequest = new Request(request, { headers });
    const startedAt = Date.now();

    const finish = (response: Response) => {
      const corsResponse = withCors(response, instrumentedRequest);
      const responseHeaders = new Headers(corsResponse.headers);
      responseHeaders.set("x-request-id", requestId);
      const wrapped = new Response(corsResponse.body, {
        status: corsResponse.status,
        statusText: corsResponse.statusText,
        headers: responseHeaders,
      });
      const durationMs = Date.now() - startedAt;
      if (wrapped.status >= 500 || instrumentedRequest.url.includes("/api/assets/")) {
        logEvent(wrapped.status >= 500 ? "error" : "info", "worker request completed", {
          requestId,
          method: instrumentedRequest.method,
          path: new URL(instrumentedRequest.url).pathname,
          status: wrapped.status,
          durationMs,
        });
      }
      return wrapped;
    };

    // Handle CORS preflight
    try {
      if (instrumentedRequest.method === "OPTIONS") {
        return finish(new Response(null, { status: 204 }));
      }

      const url = new URL(instrumentedRequest.url);

      // /assets/{id}/{filename} — serve files from R2 (no auth, public, immutable cache)
      if (url.pathname.startsWith("/assets/") && options?.r2Bucket) {
        // Extract asset ID from path, look up r2Key from DB
        const pathParts = url.pathname.replace("/assets/", "").split("/");
        const assetId = pathParts[0];
        if (assetId) {
          // Look up the r2Key from the assets table
          const r2Key = await Effect.runPromise(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const rows = yield* sql.unsafe<{ r2_key: string }>(
                "SELECT r2_key FROM assets WHERE id = ?", [assetId]
              );
              return rows[0]?.r2_key ?? null;
            }).pipe(Effect.provide(fullLayer), Effect.orDie)
          );
          if (r2Key) {
            const object = await options.r2Bucket.get(r2Key);
            if (object) {
              const headers = new Headers();
              headers.set("Content-Type", object.httpMetadata?.contentType || "application/octet-stream");
              headers.set("Cache-Control", "public, max-age=31536000, immutable");
              return finish(new Response(object.body, { headers }));
            }
          }
        }
        return finish(new Response("Not found", { status: 404 }));
      }

      // /health — no auth
      if (url.pathname === "/health") {
        return finish(new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json" },
        }));
      }

      // /graphql GET (GraphiQL playground) — no auth
      if (url.pathname === "/graphql" && instrumentedRequest.method === "GET") {
        // Fall through to graphql handler below (landingPage: true serves GraphiQL)
      }
      // /graphql POST — read auth
      else if (url.pathname === "/graphql" && instrumentedRequest.method === "POST") {
        const denied = checkAuth(instrumentedRequest, "read");
        if (denied) return finish(denied);
      }
      // /mcp — write auth
      else if (url.pathname === "/mcp") {
        const denied = checkAuth(instrumentedRequest, "write");
        if (denied) return finish(denied);
      }
      // /api/* — write auth
      else if (url.pathname.startsWith("/api/")) {
        const denied = checkAuth(instrumentedRequest, "write");
        if (denied) return finish(denied);
      }

      // Route /mcp to MCP HTTP transport
      if (url.pathname === "/mcp") {
        if (!mcpHandler) {
          const { createMcpServer } = await import("../mcp/server.js");
          const { createMcpHttpHandler } = await import("../mcp/http-transport.js");
          const mcpServer = createMcpServer(fullLayer);
          mcpHandler = createMcpHttpHandler(mcpServer);
        }
        const response = await mcpHandler(instrumentedRequest);
        return finish(response);
      }

      // Route /graphql to Yoga
      if (url.pathname === "/graphql") {
        if (!graphqlHandler) {
          const { createGraphQLHandler } = await import("../graphql/handler.js");
          graphqlHandler = createGraphQLHandler(sqlLayer, {
            assetBaseUrl: options?.assetBaseUrl,
            isProduction: options?.isProduction,
          });
        }
        const response = await graphqlHandler(instrumentedRequest);
        return finish(response);
      }

      // Everything else to the Effect router
      const response = await restHandler(instrumentedRequest);
      if (response.status < 400 && isSchemaMutationRequest(url, instrumentedRequest.method)) {
        invalidateGraphqlSchemaCache();
      }
      return finish(response);
    } catch (error) {
      logEvent("error", "worker request crashed", {
        requestId,
        method: instrumentedRequest.method,
        path: new URL(instrumentedRequest.url).pathname,
        error: describeUnknown(error),
      });
      return finish(new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }));
    }
  };
}
