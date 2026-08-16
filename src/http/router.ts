import { isString, type DynamicRow, type StoredFieldValue } from "../dynamic/row-types.js";
import {
  HttpEffect,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";


import { Cause, DateTime, Effect, Layer, Logger, Schema, SchemaIssue, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import * as AssetService from "../services/asset-service.js";
import * as TokenService from "../services/token-service.js";
import * as PreviewService from "../services/preview-service.js";
import * as PathService from "../services/path-service.js";
import { AssetImportContext, AssetUrlContext, type AssetUrlConfig } from "../services/asset-service.js";
import { isCmsError, errorToResponse } from "../errors.js";
import { ApiLayer, ApiHandlersLayer } from "./api.js";
import { openApiSpec } from "./api/index.js";
import {
  CreateAssetInput,
  ImportAssetFromUrlInput,
  ListAssetsInput,
  UpdateAssetMetadataInput,
  CreateUploadUrlInput,
} from "../services/input-schemas.js";
import { UnauthorizedError, ValidationError } from "../errors.js";
import * as ScheduleService from "../services/schedule-service.js";
import type { AiBinding, VectorizeBinding } from "../search/vectorize.js";
import { VectorizeContext } from "../search/vectorize-context.js";
import { HooksContext, type CmsHooks } from "../hooks.js";
import {
  actorFromHeaders,
  actorHeaders,
  type RequestActor,
} from "../attribution.js";

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- errors reach this serializer from Effect's opaque error/defect channels; any thrown value must be describable.
function describeUnknown(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (isString(error)) return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function getRequestIdFromHeaders(headers: Headers): string {
  return headers.get("x-request-id") ?? headers.get("cf-ray") ?? crypto.randomUUID();
}

/** Helper: run a CMS Effect and return an HTTP response */
function handle<A, R>(
  effect: Effect.Effect<A, unknown, R>,
  status: number = 200
) {
  return effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json(result, { status })),
    Effect.tapCause((cause) => Effect.logError("REST effect failed", cause)),
    Effect.catchIf(isCmsError, (error) => {
      const mapped = errorToResponse(error);
      return HttpServerResponse.json(mapped.body, { status: mapped.status });
    }),
    Effect.catch((error) =>
      Effect.logError("Unhandled REST error").pipe(
        Effect.annotateLogs({ error: describeUnknown(error) }),
        Effect.andThen(HttpServerResponse.json({ error: "Internal server error" }, { status: 500 })),
      )
    ),
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Effect's defect channel is opaque; catchDefect receives any thrown non-error value.
    Effect.catchDefect((defect: unknown) => {
      return Effect.logError("REST defect").pipe(
        Effect.annotateLogs({ defect: describeUnknown(defect) }),
        Effect.andThen(HttpServerResponse.json({ error: "Internal server error" }, { status: 500 })),
      );
    })
  );
}

/** Extract a required path parameter, defaulting to empty string if missing */
function param(params: Record<string, string | undefined>, name: string): string {
  return params[name] ?? "";
}

/** Get query param */
function decodeUnknownInput<S extends Schema.Constraint>(
  schema: S,
  input: StoredFieldValue,
  message: string = "Invalid input",
) {
  return Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((e) => new ValidationError({ message: `${message}: ${e.message}` }))
  );
}

const readJsonBody = Effect.fn("readJsonBody")(function* (message: string = "Invalid JSON body") {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const body = yield* req.json.pipe(
    Effect.mapError((e) => new ValidationError({
      message: `${message}: ${describeUnknown(e)}`,
    }))
  );
  // SAFETY: the decoded JSON body is a string/number/boolean/null/object value; JSON arrays are the
  // only Schema.Json member outside StoredFieldValue, and every downstream schema is a Struct that
  // rejects arrays with a clear ValidationError — so the type only narrows, never mis-handles.
  return body as StoredFieldValue;
});

const currentActor = Effect.fn("currentActor")(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  return actorFromHeaders(new Headers(req.headers));
});

// --- Assets ---
// Upload URL endpoint is handled in fetchHandler (needs r2Credentials from options)
const assetsRouter = HttpRouter.use((router) => {
  const api = router.prefixed("/api/assets");
  return Effect.all([
  api.add("GET", 
    "/",
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(req.url, "http://localhost");
      const q = url.searchParams.get("q");
      const limit = url.searchParams.get("limit");
      const offset = url.searchParams.get("offset");
      const orderByParam = url.searchParams.get("orderBy");
      const parsed = yield* decodeUnknownInput(ListAssetsInput, {
        q: q ?? undefined,
        orderBy: orderByParam !== null ? orderByParam.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        page: (limit !== null || offset !== null) ? {
          limit: limit !== null ? Number(limit) : undefined,
          offset: offset !== null ? Number(offset) : undefined,
        } : undefined,
      }, "Invalid asset list input");
      return yield* handle(AssetService.listAssets({
        query: parsed.q,
        page: parsed.page ? { limit: Math.min(parsed.page.limit, 100), offset: parsed.page.offset } : undefined,
        orderBy: parsed.orderBy,
      }));
    })
  ),

  api.add("POST", 
    "/",
    Effect.gen(function* () {
      const body = yield* readJsonBody();
      const input = yield* decodeUnknownInput(CreateAssetInput, body);
      const actor = yield* currentActor();
      return yield* handle(AssetService.createAsset(input, actor), 201);
    })
  ),

  api.add("POST", 
    "/import-from-url",
    Effect.gen(function* () {
      const body = yield* readJsonBody();
      const input = yield* decodeUnknownInput(ImportAssetFromUrlInput, body);
      const actor = yield* currentActor();
      return yield* handle(AssetService.importAssetFromUrl(input, actor), 201);
    })
  ),

  api.add("GET", 
    "/:id",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      return yield* handle(AssetService.getAsset(param(params, "id")));
    })
  ),

  api.add("GET", 
    "/:id/usages",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      return yield* handle(
        AssetService.getAssetUsages(param(params, "id")).pipe(Effect.map((usages) => ({ usages })))
      );
    })
  ),

  api.add("PUT", 
    "/:id",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const body = yield* readJsonBody();
      const input = yield* decodeUnknownInput(CreateAssetInput, body);
      const actor = yield* currentActor();
      return yield* handle(AssetService.replaceAsset(param(params, "id"), input, actor));
    })
  ),

  api.add("PATCH", 
    "/:id",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const body = yield* readJsonBody();
      const input = yield* decodeUnknownInput(UpdateAssetMetadataInput, body);
      const actor = yield* currentActor();
      return yield* handle(AssetService.updateAssetMetadata(param(params, "id"), input, actor));
    })
  ),

  api.add("DELETE", 
    "/:id",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const req = yield* HttpServerRequest.HttpServerRequest;
      const force = new URL(req.url, "http://localhost").searchParams.get("force") === "true";
      return yield* handle(AssetService.deleteAsset(param(params, "id"), force));
    })
  )
  ]);
});

// --- Locales ---
// --- Combine all routes ---
const healthRouter = HttpRouter.use((router) =>
  router.add("GET", "/health", HttpServerResponse.json({ status: "ok" }))
);

const openApiRouter = HttpRouter.use((router) =>
  Effect.all([
    router.add("GET", "/openapi.json", HttpServerResponse.json(openApiSpec)),
  ])
);

export const appRouter = Layer.mergeAll(
  openApiRouter,
  healthRouter,
  ApiLayer.pipe(Layer.provide(ApiHandlersLayer)),
  assetsRouter,
);

/**
 * Create a web handler from the router + a SqlClient layer.
 * Includes GraphQL endpoint via Yoga.
 * Uses Effect.flatten to work around @effect/platform 0.94.5 nested Effect issue.
 */
export interface WebHandlerOptions {
  assetBaseUrl?: string;
  isProduction?: boolean;
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
  /** R2 credentials for generating presigned upload URLs */
  r2Credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    bucketName: string;
    accountId: string;
  };
  /** Public URL of the frontend site — used for assembling preview URLs */
  siteUrl?: string;
  /** Worker Loader binding for Code Mode MCP (optional — enables /mcp/codemode) */
  loader?: unknown;
  /** Fetch implementation for asset import helpers */
  fetch?: typeof fetch;
}

export function createWebHandler(sqlLayer: Layer.Layer<SqlClient.SqlClient>, options?: WebHandlerOptions) {
  const vectorizeLayer = Layer.succeed(
    VectorizeContext,
    options?.ai && options.vectorize
      ? Option.some({ ai: options.ai, vectorize: options.vectorize })
      : Option.none()
  );
  const hooksLayer = Layer.succeed(
    HooksContext,
    options?.hooks ? Option.some(options.hooks) : Option.none()
  );
  const assetImportLayer = Layer.succeed(AssetImportContext, {
    r2Bucket: options?.r2Bucket,
    r2Credentials: options?.r2Credentials,
    fetch: options?.fetch ?? globalThis.fetch,
  });
  /**
   * Asset-URL config for every read on this handler. `baseUrl` is fixed at
   * construction (`ASSET_BASE_URL`); `origin` is learned per request, because
   * the layer is built once per Worker but only a request knows the host the
   * CMS is reachable on. With neither, reads fall back to the relative
   * `/assets/:id/:filename` path this router serves from R2.
   */
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- the object is mutated later (assetUrlLayer closure) and read through AssetUrlConfig.
  const assetUrlConfig: { baseUrl: string | undefined; origin: string | undefined } = {
    baseUrl: options?.assetBaseUrl,
    origin: undefined,
  };
  const assetUrlLayer = Layer.succeed(AssetUrlContext, {
    current: (): AssetUrlConfig => assetUrlConfig,
  });
  const fullLayer = Layer.mergeAll(sqlLayer, vectorizeLayer, hooksLayer, assetImportLayer, assetUrlLayer, Logger.layer([Logger.formatJson]));

  const runLoggedEffect = (effect: Effect.Effect<unknown, unknown>) => {
    Effect.runFork(effect.pipe(Effect.provide(fullLayer), Effect.orDie));
  };

  const logInfo = (message: string, fields: DynamicRow) => {
    runLoggedEffect(Effect.logInfo(message).pipe(Effect.annotateLogs(fields)));
  };

  const logError = (message: string, fields: DynamicRow) => {
    runLoggedEffect(Effect.logError(message).pipe(Effect.annotateLogs(fields)));
  };

  const restHandler = HttpEffect.toWebHandlerLayer(
    Effect.provide(
      Effect.flatten(HttpRouter.toHttpEffect(appRouter)).pipe(
        Effect.catch((error) => {
          if (isCmsError(error)) {
            const mapped = errorToResponse(error);
            return HttpServerResponse.json(mapped.body, { status: mapped.status });
          }
          return Effect.logError("REST handler error").pipe(
            Effect.annotateLogs({ error: describeUnknown(error) }),
            Effect.andThen(HttpServerResponse.json({ error: "Internal server error" }, { status: 500 })),
          );
        }),
      ),
      fullLayer,
    ),
    Layer.empty,
  ).handler;

  // Lazy-import handlers to avoid circular deps
  let graphqlInstance: {
    handle: (req: Request) => Promise<Response>;
    getSchema: () => Promise<import("graphql").GraphQLSchema>;
    invalidateSchema: () => void;
    execute: (
      query: string,
      variables?: DynamicRow,
      context?: { includeDrafts?: boolean; excludeInvalid?: boolean }
    ) => Promise<{ data: unknown; errors?: ReadonlyArray<{ message: string }> }>;
  } | null = null;
  let mcpHandler: ((req: Request) => Promise<Response>) | null = null;
  let graphqlModulePromise: Promise<typeof import("../graphql/handler.js")> | null = null;
  let mcpEditorHandler: ((req: Request) => Promise<Response>) | null = null;

  function invalidateGraphqlSchemaCache() {
    if (graphqlInstance) graphqlInstance.invalidateSchema();
  }

  async function getGraphqlInstance() {
    if (!graphqlInstance) {
      if (!graphqlModulePromise) {
        graphqlModulePromise = import("../graphql/handler.js");
      }
      const module = await graphqlModulePromise;
      graphqlInstance = module.createGraphQLHandler(sqlLayer, {
        assetBaseUrl: options?.assetBaseUrl,
        isProduction: options?.isProduction,
      });
    }
    return graphqlInstance;
  }

  async function runScheduledTransitions(now = DateTime.nowUnsafe()) {
    const result = await Effect.runPromise(
      ScheduleService.runScheduledTransitions(now).pipe(
        Effect.withSpan("schedule.run_transitions"),
        Effect.annotateLogs({ now: DateTime.formatIso(now) }),
        Effect.provide(fullLayer),
      )
    );
    if (result.published.length > 0 || result.unpublished.length > 0) {
      invalidateGraphqlSchemaCache();
    }
    return result;
  }

  function isSchemaMutationRequest(url: URL, method: string): boolean {
    if (!["POST", "PATCH", "DELETE"].includes(method)) return false;
    return (
      url.pathname.startsWith("/api/models") ||
      url.pathname.startsWith("/api/locales") ||
      url.pathname.startsWith("/api/schema") ||
      url.pathname === "/api/setup"
    );
  }

  /** Add CORS headers to a response */
  function withCors(response: Response, request: Request): Response {
    const origin = request.headers.get("Origin") ?? "*";
    const headers = new Headers(response.headers);
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Include-Drafts, X-Exclude-Invalid, X-Filename, X-Requested-With, Accept, User-Agent, X-Preview-Token");
    headers.set("Access-Control-Max-Age", "600");
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
   * Check if a request is authorized for write access.
   * If no writeKey is configured, all requests are allowed (local dev).
   * When adminOnly is true, only writeKey is accepted (not editor tokens).
   */
  async function checkWriteAuth(request: Request, adminOnly = false): Promise<UnauthorizedError | null> {
    if (!options?.writeKey) return null;
    const token = getBearerToken(request);
    if (token === options.writeKey) return null;

    if (adminOnly) {
      return new UnauthorizedError({
        message: "Unauthorized. This endpoint requires admin (writeKey) access.",
      });
    }

    if (token && token.startsWith("etk_")) {
      const valid = await Effect.runPromise(
        TokenService.validateEditorToken(token).pipe(
          Effect.provide(fullLayer),
          Effect.isSuccess,
        )
      );
      if (valid) return null;
      return new UnauthorizedError({
        message: "Unauthorized. Invalid or expired editor token.",
      });
    }

    return new UnauthorizedError({
      message: "Unauthorized. Provide a valid write API key or editor token via Authorization: Bearer <key>",
    });
  }

  async function getRequestActor(request: Request): Promise<RequestActor | null> {
    if (!options?.writeKey) return { type: "admin", label: "admin" };
    const token = getBearerToken(request);
    if (token === options.writeKey) {
      return { type: "admin", label: "admin" };
    }
    if (token && token.startsWith("etk_")) {
      const editorToken = await Effect.runPromise(
        TokenService.validateEditorToken(token).pipe(
          Effect.provide(fullLayer),
          Effect.option,
        )
      );
      if (Option.isSome(editorToken)) {
        return {
          type: "editor",
          label: editorToken.value.name,
          tokenId: editorToken.value.id,
        };
      }
      return null;
    }
    return null;
  }

  async function getCredentialType(request: Request): Promise<"admin" | "editor" | null> {
    const actor = await getRequestActor(request);
    return actor?.type ?? null;
  }

  const fetchHandler = async (request: Request): Promise<Response> => {
    const requestId = getRequestIdFromHeaders(request.headers);
    const headers = new Headers(request.headers);
    headers.set("x-request-id", requestId);
    let instrumentedRequest = new Request(request, { headers });
    const startedAt = performance.now();

    const finish = (response: Response) => {
      const corsResponse = withCors(response, instrumentedRequest);
      const responseHeaders = new Headers(corsResponse.headers);
      responseHeaders.set("x-request-id", requestId);
      const wrapped = new Response(corsResponse.body, {
        status: corsResponse.status,
        statusText: corsResponse.statusText,
        headers: responseHeaders,
      });
      const durationMs = performance.now() - startedAt;
      if (wrapped.status >= 500 || instrumentedRequest.url.includes("/api/assets/")) {
        const logFields = {
          requestId,
          method: instrumentedRequest.method,
          path: new URL(instrumentedRequest.url).pathname,
          status: wrapped.status,
          durationMs,
        };
        if (wrapped.status >= 500) {
          logError("worker request completed", logFields);
        } else {
          logInfo("worker request completed", logFields);
        }
      }
      return wrapped;
    };

    // Handle CORS preflight
    try {
      if (instrumentedRequest.method === "OPTIONS") {
        return finish(new Response(null, { status: 204 }));
      }

      const url = new URL(instrumentedRequest.url);
      // Fallback origin for asset URLs when no ASSET_BASE_URL is configured —
      // reads then point at this Worker's own /assets/:id/:filename route.
      assetUrlConfig.origin = url.origin;

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

      // /graphql — no auth required, but detect credential type for draft visibility
      if (url.pathname === "/graphql") {
        const credentialType = await getCredentialType(instrumentedRequest);
        // Always overwrite — prevents forged X-Credential-Type headers
        const h = new Headers(instrumentedRequest.headers);
        if (credentialType) {
          h.set("X-Credential-Type", credentialType);
        } else {
          h.delete("X-Credential-Type");
        }
        // Check for X-Preview-Token header — if valid, enable draft mode
        const previewToken = instrumentedRequest.headers.get("X-Preview-Token");
        if (previewToken) {
          const result = await Effect.runPromise(
            PreviewService.validatePreviewToken(previewToken).pipe(
              Effect.provide(fullLayer),
              Effect.option,
            )
          );
          if (Option.isSome(result) && result.value.valid) {
            h.set("X-Include-Drafts", "true");
          }
        }
        instrumentedRequest = new Request(instrumentedRequest, { headers: h });
        // Fall through to graphql handler below
      }
      // /mcp — admin only (Code Mode when loader available, standard MCP fallback)
      else if (url.pathname === "/mcp") {
        const actor = await getRequestActor(instrumentedRequest);
        if (actor?.type === "editor") {
          return finish(new Response(JSON.stringify({
            error: "Unauthorized. Editor tokens must use /mcp/editor.",
          }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          }));
        }
        const denied = await checkWriteAuth(instrumentedRequest, true);
        if (denied) {
          const mapped = errorToResponse(denied);
          return finish(new Response(JSON.stringify(mapped.body), {
            status: mapped.status,
            headers: { "Content-Type": "application/json" },
          }));
        }
      }
      else if (url.pathname === "/mcp/editor") {
        const denied = await checkWriteAuth(instrumentedRequest, false);
        if (denied) {
          const mapped = errorToResponse(denied);
          return finish(new Response(JSON.stringify(mapped.body), {
            status: mapped.status,
            headers: { "Content-Type": "application/json" },
          }));
        }
      }
      // /api/preview-tokens/validate — no auth required (public validation endpoint)
      else if (url.pathname === "/api/preview-tokens/validate") {
        // Fall through to router — no auth needed
      }
      // /api/* — write auth (schema mutations and token management require admin)
      else if (url.pathname.startsWith("/api/")) {
        const adminOnly = isSchemaMutationRequest(url, instrumentedRequest.method)
          || url.pathname.startsWith("/api/tokens");
        const denied = await checkWriteAuth(instrumentedRequest, adminOnly);
        if (denied) {
          const mapped = errorToResponse(denied);
          return finish(new Response(JSON.stringify(mapped.body), {
            status: mapped.status,
            headers: { "Content-Type": "application/json" },
          }));
        }
        const actor = await getRequestActor(instrumentedRequest);
        const h = new Headers(instrumentedRequest.headers);
        for (const [key, value] of Object.entries(actorHeaders(actor))) {
          h.set(key, value);
        }
        instrumentedRequest = new Request(instrumentedRequest, { headers: h });
      }

      // Route /mcp — Code Mode when loader available, standard MCP fallback
      if (url.pathname === "/mcp") {
        if (options?.loader) {
          // Code Mode: wrap admin MCP tools in V8 sandbox
          const { createMcpHttpHandler } = await import("../mcp/http-transport.js");
          const adminMcpHandler = mcpHandler ??= createMcpHttpHandler(fullLayer, {
            mode: "admin",
            path: "/mcp",
            r2Bucket: options.r2Bucket,
            r2Credentials: options.r2Credentials,
            assetBaseUrl: options.assetBaseUrl,
            siteUrl: options.siteUrl,
            actor: { type: "admin", label: "admin" },
          });
          const { createCodeModeMcpServer } = await import("../mcp/codemode-handler.js");
          const { createMcpHandler } = await import("agents/mcp");
          const codeModeServer = await createCodeModeMcpServer({
            loader: options.loader,
            mcpHandler: adminMcpHandler,
          });
          const handler = createMcpHandler(codeModeServer, { route: "/mcp" });
          // SAFETY: agents/mcp's createMcpHandler only reads ctx.props (absent → no auth context)
          // and calls ctx.waitUntil on SSE teardown; the stub provides both waitUntil and
          // passThroughOnException, so this minimal object satisfies the runtime contract.
          // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- agents' MCP runtime types ctx as opaque; the stub satisfies the ExecutionContext surface used here.
          const stubCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
          return finish(await handler(instrumentedRequest, {}, stubCtx));
        }
        // Standard MCP fallback (no loader)
        const { createMcpHttpHandler } = await import("../mcp/http-transport.js");
        const actor = await getRequestActor(instrumentedRequest);
        const mcpHeaders = new Headers(instrumentedRequest.headers);
        for (const [key, value] of Object.entries(actorHeaders(actor))) {
          mcpHeaders.set(key, value);
        }
        instrumentedRequest = new Request(instrumentedRequest, { headers: mcpHeaders });
        const handler = mcpHandler ??= createMcpHttpHandler(fullLayer, {
          mode: "admin",
          path: "/mcp",
          r2Bucket: options?.r2Bucket,
          r2Credentials: options?.r2Credentials,
          assetBaseUrl: options?.assetBaseUrl,
          siteUrl: options?.siteUrl,
          actor,
        });
        return finish(await handler(instrumentedRequest));
      }

      // Route /mcp/editor — Code Mode when loader available, standard MCP fallback
      if (url.pathname === "/mcp/editor") {
        if (options?.loader) {
          // Code Mode: wrap editor MCP tools in V8 sandbox
          const { createMcpHttpHandler } = await import("../mcp/http-transport.js");
          const editorMcpHandler = mcpEditorHandler ??= createMcpHttpHandler(fullLayer, {
            mode: "editor",
            path: "/mcp/editor",
            r2Bucket: options.r2Bucket,
            r2Credentials: options.r2Credentials,
            assetBaseUrl: options.assetBaseUrl,
            siteUrl: options.siteUrl,
            actor: { type: "editor", label: "editor" },
          });
          const { createCodeModeMcpServer } = await import("../mcp/codemode-handler.js");
          const { createMcpHandler } = await import("agents/mcp");
          const codeModeServer = await createCodeModeMcpServer({
            loader: options.loader,
            mcpHandler: editorMcpHandler,
            mode: "editor",
            mcpPath: "/mcp/editor",
          });
          const handler = createMcpHandler(codeModeServer, { route: "/mcp/editor" });
          // SAFETY: agents/mcp's createMcpHandler only reads ctx.props (absent → no auth context)
          // and calls ctx.waitUntil on SSE teardown; the stub provides both waitUntil and
          // passThroughOnException, so this minimal object satisfies the runtime contract.
          // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- agents' MCP runtime types ctx as opaque; the stub satisfies the ExecutionContext surface used here.
          const stubCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
          return finish(await handler(instrumentedRequest, {}, stubCtx));
        }
        // Standard MCP fallback (no loader)
        const { createMcpHttpHandler } = await import("../mcp/http-transport.js");
        const actor = await getRequestActor(instrumentedRequest);
        const mcpHeaders = new Headers(instrumentedRequest.headers);
        for (const [key, value] of Object.entries(actorHeaders(actor))) {
          mcpHeaders.set(key, value);
        }
        instrumentedRequest = new Request(instrumentedRequest, { headers: mcpHeaders });
        const handler = mcpEditorHandler ??= createMcpHttpHandler(fullLayer, {
          mode: "editor",
          path: "/mcp/editor",
          r2Bucket: options?.r2Bucket,
          r2Credentials: options?.r2Credentials,
          assetBaseUrl: options?.assetBaseUrl,
          siteUrl: options?.siteUrl,
          actor,
        });
        return finish(await handler(instrumentedRequest));
      }

      // Route /graphql to Yoga
      if (url.pathname === "/graphql") {
        const traceEnabled = instrumentedRequest.headers.get("X-Bench-Trace") === "1" || instrumentedRequest.headers.get("X-Debug-Sql") === "true";
        let graphqlImportMs = 0;
        let graphqlInitMs = 0;
        let graphqlImportCache: "hit" | "miss" = "hit";
        let graphqlInitCache: "hit" | "miss" = "hit";
        if (!graphqlInstance) {
          graphqlInitCache = "miss";
          if (!graphqlModulePromise) {
            graphqlImportCache = "miss";
            const importStartedAt = performance.now();
            graphqlModulePromise = import("../graphql/handler.js").then((module) => {
              graphqlImportMs = Number((performance.now() - importStartedAt).toFixed(3));
              return module;
            });
          }
          const module = await graphqlModulePromise;
          const initStartedAt = performance.now();
          graphqlInstance = module.createGraphQLHandler(sqlLayer, {
            assetBaseUrl: options?.assetBaseUrl,
            isProduction: options?.isProduction,
          });
          graphqlInitMs = Number((performance.now() - initStartedAt).toFixed(3));
        }
        const response = await graphqlInstance.handle(instrumentedRequest);
        if (!traceEnabled) return finish(response);

        const headers = new Headers(response.headers);
        headers.set("X-Cms-Graphql-Import-Ms", graphqlImportMs.toFixed(3));
        headers.set("X-Cms-Graphql-Import-Cache", graphqlImportCache);
        headers.set("X-Cms-Graphql-Init-Ms", graphqlInitMs.toFixed(3));
        headers.set("X-Cms-Graphql-Init-Cache", graphqlInitCache);
        return finish(new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        }));
      }

      // POST /api/assets/upload-url — generate presigned R2 upload URL
      if (url.pathname === "/api/assets/upload-url" && instrumentedRequest.method === "POST") {
        if (!options?.r2Credentials) {
          return finish(new Response(JSON.stringify({ error: "Presigned uploads not configured" }), {
            status: 501,
            headers: { "Content-Type": "application/json" },
          }));
        }
        const body = await instrumentedRequest.json();
        const decoded = Schema.decodeUnknownExit(CreateUploadUrlInput)(body);
        if (decoded._tag === "Failure") {
          const error = Cause.findErrorOption(decoded.cause).pipe(Option.getOrThrow);
          return finish(new Response(JSON.stringify({
            error: `Invalid upload URL request: ${SchemaIssue.makeFormatterDefault()(error.issue)}`,
          }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }));
        }
        const result = await Effect.runPromise(
          AssetService.createAssetUploadUrl(decoded.value).pipe(Effect.provide(fullLayer))
        );
        return finish(new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }

      // PUT /api/assets/:id/file — fallback binary upload via R2 binding
      if (url.pathname.match(/^\/api\/assets\/[^/]+\/file$/) && instrumentedRequest.method === "PUT") {
        if (!options?.r2Bucket) {
          return finish(new Response(JSON.stringify({ error: "R2 bucket not configured" }), {
            status: 501,
            headers: { "Content-Type": "application/json" },
          }));
        }
        const assetId = url.pathname.split("/")[3];
        const contentType = instrumentedRequest.headers.get("Content-Type") ?? "application/octet-stream";
        const filename = instrumentedRequest.headers.get("X-Filename") ?? "upload";
        const r2Key = `uploads/${assetId}/${filename}`;
        const body = await instrumentedRequest.arrayBuffer();
        await options.r2Bucket.put(r2Key, body, {
          httpMetadata: { contentType },
        });
        return finish(new Response(JSON.stringify({ r2Key, assetId }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }

      // Everything else to the Effect router
      // SAFETY: the HttpApi layer types the handler as requiring extra context
      // (its request service is provided per-fetch by toWebHandlerLayer);
      // undefined skips the extra-context merge in toWebHandlerWith.
      const response = await restHandler(instrumentedRequest, undefined as never);
      if (response.status < 400 && isSchemaMutationRequest(url, instrumentedRequest.method)) {
        invalidateGraphqlSchemaCache();
      }
      return finish(response);
    } catch (error) {
      logError("worker request crashed", {
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

  return {
    fetch: fetchHandler,

    /**
     * Execute a GraphQL query directly, without HTTP serialization.
     * For in-process queries when CMS and site share a Worker.
     * Skips CORS, auth, and request logging — caller is trusted.
     */
    async execute(
      query: string,
      variables?: DynamicRow,
      context?: { includeDrafts?: boolean; excludeInvalid?: boolean }
    ): Promise<{ data: unknown; errors?: ReadonlyArray<{ message: string }> }> {
      const instance = await getGraphqlInstance();
      return instance.execute(query, variables, context);
    },

    runScheduledTransitions,

    /**
     * Resolve canonical paths for all published records of a model.
     * For in-process sitemap generation when CMS and site share a Worker.
     */
    resolveCanonicalPaths(modelApiKey: string): Promise<Array<{ id: string; path: string; lastmod: string }>> {
      return Effect.runPromise(
        PathService.resolveCanonicalPaths(modelApiKey).pipe(Effect.provide(fullLayer))
      );
    },
  };
}
