import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpApp,
  HttpServerError,
} from "@effect/platform";
import { Cause, Effect, Layer, Logger, Schema, Option } from "effect";
import { SqlClient } from "@effect/sql";
import * as ModelService from "../services/model-service.js";
import * as FieldService from "../services/field-service.js";
import * as RecordService from "../services/record-service.js";
import * as PublishService from "../services/publish-service.js";
import * as AssetService from "../services/asset-service.js";
import { AssetImportContext } from "../services/asset-service.js";
import * as LocaleService from "../services/locale-service.js";
import * as ScheduleService from "../services/schedule-service.js";
import { isCmsError, errorToResponse } from "../errors.js";
import {
  CreateModelInput, UpdateModelInput,
  CreateFieldInput, UpdateFieldInput,
  CreateRecordInput, PatchRecordInput,
  PatchBlocksInput,
  CreateAssetInput,
  ImportAssetFromUrlInput,
  SearchAssetsInput,
  UpdateAssetMetadataInput,
  CreateLocaleInput,
  BulkCreateRecordsInput,
  ScheduleRecordInput,
  ImportSchemaInput,
  ReindexSearchInput, ReorderInput, SearchInput,
  CreateUploadUrlInput,
  CreateEditorTokenInput,
} from "../services/input-schemas.js";
import { UnauthorizedError, ValidationError } from "../errors.js";
import * as SchemaIO from "../services/schema-io.js";
import * as VersionService from "../services/version-service.js";
import * as TokenService from "../services/token-service.js";
import * as PreviewService from "../services/preview-service.js";
import * as PathService from "../services/path-service.js";
import * as SearchService from "../search/search-service.js";
import type { AiBinding, VectorizeBinding } from "../search/vectorize.js";
import { VectorizeContext } from "../search/vectorize-context.js";
import { HooksContext, type CmsHooks } from "../hooks.js";
import { ensureSchema } from "../migrations.js";
import {
  actorFromHeaders,
  actorHeaders,
  type RequestActor,
} from "../attribution.js";

function describeUnknown(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
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
    Effect.tapErrorCause((cause) => Effect.logError("REST effect failed", Cause.pretty(cause))),
    Effect.catchAll((error: unknown) => {
      if (isCmsError(error)) {
        const mapped = errorToResponse(error);
        return HttpServerResponse.json(mapped.body, { status: mapped.status });
      }
      return Effect.logError("Unhandled REST error").pipe(
        Effect.annotateLogs({ error: describeUnknown(error) }),
        Effect.zipRight(HttpServerResponse.json({ error: "Internal server error" }, { status: 500 })),
      );
    }),
    Effect.catchAllDefect((defect: unknown) => {
      return Effect.logError("REST defect").pipe(
        Effect.annotateLogs({ defect: describeUnknown(defect) }),
        Effect.zipRight(HttpServerResponse.json({ error: "Internal server error" }, { status: 500 })),
      );
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

function decodeUnknownInput<A, I, R>(
  schema: Schema.Schema<A, I, R>,
  input: unknown,
  message: string = "Invalid input",
) {
  return Schema.decodeUnknown(schema)(input).pipe(
    Effect.mapError((e) => new ValidationError({ message: `${message}: ${e.message}` }))
  );
}

function readJsonBody(message: string = "Invalid JSON body") {
  return Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;
    return yield* req.json.pipe(
      Effect.mapError((e) => new ValidationError({
        message: `${message}: ${describeUnknown(e)}`,
      }))
    );
  });
}

function currentActor() {
  return Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;
    return actorFromHeaders(new Headers(req.headers));
  });
}

// --- Models ---
const modelsRouter = HttpRouter.empty.pipe(
  HttpRouter.get("/", handle(ModelService.listModels())),

  HttpRouter.post(
    "/",
    Effect.gen(function* () {
      const body = yield* readJsonBody();
      const input = yield* decodeUnknownInput(CreateModelInput, body);
      return yield* handle(ModelService.createModel(input), 201);
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
      const body = yield* readJsonBody();
      const input = yield* decodeUnknownInput(UpdateModelInput, body);
      return yield* handle(ModelService.updateModel(param(params, "id"), input));
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
      const body = yield* readJsonBody();
      const input = yield* decodeUnknownInput(CreateFieldInput, body);
      return yield* handle(FieldService.createField(param(params, "modelId"), input), 201);
    })
  ),

  HttpRouter.patch(
    "/models/:modelId/fields/:fieldId",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const body = yield* readJsonBody();
      const input = yield* decodeUnknownInput(UpdateFieldInput, body);
      return yield* handle(FieldService.updateField(param(params, "fieldId"), input));
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
      const body = yield* readJsonBody();
      const input = yield* decodeUnknownInput(BulkCreateRecordsInput, body);
      const actor = yield* currentActor();
      return yield* handle(RecordService.bulkCreateRecords(input, actor), 201);
    })
  ),

  HttpRouter.post(
    "/records",
    Effect.gen(function* () {
      const body = yield* readJsonBody();
      const input = yield* decodeUnknownInput(CreateRecordInput, body);
      const actor = yield* currentActor();
      return yield* handle(RecordService.createRecord(input, actor), 201);
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
      const actor = yield* currentActor();
      return yield* handle(VersionService.restoreVersion(modelApiKey, param(params, "id"), param(params, "versionId"), actor));
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
      const body = yield* readJsonBody();
      const input = yield* decodeUnknownInput(PatchRecordInput, body);
      const actor = yield* currentActor();
      return yield* handle(RecordService.patchRecord(param(params, "id"), input, actor));
    })
  ),

  // Partial block update for structured text fields
  HttpRouter.patch(
    "/records/:id/blocks",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const body = yield* readJsonBody();
      const merged = typeof body === "object" && body !== null
        ? { ...body, recordId: param(params, "id") }
        : { recordId: param(params, "id") };
      const input = yield* decodeUnknownInput(PatchBlocksInput, merged);
      const actor = yield* currentActor();
      return yield* handle(RecordService.patchBlocksForField(input, actor));
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
      const actor = yield* currentActor();
      return yield* handle(PublishService.publishRecord(modelApiKey, param(params, "id"), actor));
    })
  ),

  HttpRouter.post(
    "/records/:id/unpublish",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const modelApiKey = yield* queryParam("modelApiKey");
      const actor = yield* currentActor();
      return yield* handle(PublishService.unpublishRecord(modelApiKey, param(params, "id"), actor));
    })
  ),

  HttpRouter.post(
    "/records/:id/schedule-publish",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const body = yield* readJsonBody();
      const input = yield* decodeUnknownInput(ScheduleRecordInput, body);
      const actor = yield* currentActor();
      return yield* handle(ScheduleService.schedulePublish(input.modelApiKey, param(params, "id"), input.at, actor));
    })
  ),

  HttpRouter.post(
    "/records/:id/schedule-unpublish",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const body = yield* readJsonBody();
      const input = yield* decodeUnknownInput(ScheduleRecordInput, body);
      const actor = yield* currentActor();
      return yield* handle(ScheduleService.scheduleUnpublish(input.modelApiKey, param(params, "id"), input.at, actor));
    })
  ),

  HttpRouter.post(
    "/records/:id/clear-schedule",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const body = yield* readJsonBody();
      const input = yield* decodeUnknownInput(Schema.Struct({ modelApiKey: Schema.NonEmptyString }), body);
      const actor = yield* currentActor();
      return yield* handle(ScheduleService.clearSchedule(input.modelApiKey, param(params, "id"), actor));
    })
  ),

  // Reorder
  HttpRouter.post(
    "/reorder",
    Effect.gen(function* () {
      const rawBody = yield* readJsonBody();
      return yield* handle(
        Effect.gen(function* () {
          const { modelApiKey, recordIds } = yield* decodeUnknownInput(ReorderInput, rawBody);
          const actor = yield* currentActor();
          return yield* RecordService.reorderRecords(modelApiKey, recordIds, actor);
        })
      );
    })
  )
);

// --- Assets ---
// Upload URL endpoint is handled in fetchHandler (needs r2Credentials from options)
const assetsRouter = HttpRouter.empty.pipe(
  HttpRouter.get(
    "/",
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(req.url, "http://localhost");
      const q = url.searchParams.get("q");
      const limit = url.searchParams.get("limit");
      const offset = url.searchParams.get("offset");
      if (q !== null || limit !== null || offset !== null) {
        const parsed = yield* decodeUnknownInput(SearchAssetsInput, {
          query: q ?? undefined,
          limit: limit !== null ? Number(limit) : undefined,
          offset: offset !== null ? Number(offset) : undefined,
        }, "Invalid asset search input");
        return yield* handle(AssetService.searchAssets({
          query: parsed.query,
          limit: Math.min(parsed.limit, 100),
          offset: parsed.offset,
        }));
      }
      return yield* handle(AssetService.listAssets());
    })
  ),

  HttpRouter.post(
    "/",
    Effect.gen(function* () {
      const body = yield* readJsonBody();
      const input = yield* decodeUnknownInput(CreateAssetInput, body);
      const actor = yield* currentActor();
      return yield* handle(AssetService.createAsset(input, actor), 201);
    })
  ),

  HttpRouter.post(
    "/import-from-url",
    Effect.gen(function* () {
      const body = yield* readJsonBody();
      const input = yield* decodeUnknownInput(ImportAssetFromUrlInput, body);
      const actor = yield* currentActor();
      return yield* handle(AssetService.importAssetFromUrl(input, actor), 201);
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
      const body = yield* readJsonBody();
      const input = yield* decodeUnknownInput(CreateAssetInput, body);
      const actor = yield* currentActor();
      return yield* handle(AssetService.replaceAsset(param(params, "id"), input, actor));
    })
  ),

  HttpRouter.patch(
    "/:id",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const body = yield* readJsonBody();
      const input = yield* decodeUnknownInput(UpdateAssetMetadataInput, body);
      const actor = yield* currentActor();
      return yield* handle(AssetService.updateAssetMetadata(param(params, "id"), input, actor));
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
      const body = yield* readJsonBody();
      const input = yield* decodeUnknownInput(CreateLocaleInput, body);
      return yield* handle(LocaleService.createLocale(input), 201);
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
      const body = yield* readJsonBody();
      const input = yield* decodeUnknownInput(ImportSchemaInput, body);
      return yield* handle(SchemaIO.importSchema(input), 201);
    })
  )
);

// --- Search ---
const searchRouter = HttpRouter.empty.pipe(
  HttpRouter.post(
    "/",
    Effect.gen(function* () {
      const body = yield* readJsonBody();
      const parsed = yield* decodeUnknownInput(SearchInput, body, "Invalid search input");
      return yield* handle(SearchService.search(parsed));
    })
  ),

  HttpRouter.post(
    "/reindex",
    Effect.gen(function* () {
      const body = yield* readJsonBody();
      const parsed = yield* decodeUnknownInput(ReindexSearchInput, body);
      const modelApiKey = parsed.modelApiKey;
      return yield* handle(SearchService.reindexAll(modelApiKey));
    })
  )
);

// --- Tokens ---
const tokensRouter = HttpRouter.empty.pipe(
  HttpRouter.get("/", handle(TokenService.listEditorTokens())),

  HttpRouter.post(
    "/",
    Effect.gen(function* () {
      const body = yield* readJsonBody();
      const input = yield* decodeUnknownInput(CreateEditorTokenInput, body);
      return yield* handle(TokenService.createEditorToken(input), 201);
    })
  ),

  HttpRouter.del(
    "/:id",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      return yield* handle(TokenService.revokeEditorToken(param(params, "id")));
    })
  )
);

// --- Preview Tokens ---
const previewTokensRouter = HttpRouter.empty.pipe(
  HttpRouter.post(
    "/",
    Effect.gen(function* () {
      const body = yield* readJsonBody();
      const expiresIn = typeof body === "object" && body !== null && "expiresIn" in body
        ? (body as Record<string, unknown>).expiresIn as number | undefined
        : undefined;
      return yield* handle(PreviewService.createPreviewToken(expiresIn), 201);
    })
  ),

  HttpRouter.get(
    "/validate",
    Effect.gen(function* () {
      const token = yield* queryParam("token");
      return yield* handle(PreviewService.validatePreviewToken(token));
    })
  ),
);

// --- Canonical paths ---
const pathsRouter = HttpRouter.empty.pipe(
  HttpRouter.get(
    "/:modelApiKey",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      return yield* handle(PathService.resolveCanonicalPaths(param(params, "modelApiKey")));
    })
  ),
);

// --- Setup / bootstrap ---
const setupRouter = HttpRouter.empty.pipe(
  HttpRouter.post(
    "/setup",
    handle(ensureSchema().pipe(Effect.as({ ok: true })))
  )
);

// --- Health ---
const healthRouter = HttpRouter.empty.pipe(
  HttpRouter.get("/health", HttpServerResponse.json({ status: "ok" }))
);

// --- OpenAPI spec ---
import { openApiSpec } from "./api/index.js";
const openApiRouter = HttpRouter.empty.pipe(
  HttpRouter.get("/openapi.json", HttpServerResponse.json(openApiSpec))
);

// --- Combine all routes ---
export const appRouter = HttpRouter.empty.pipe(
  HttpRouter.concat(openApiRouter),
  HttpRouter.concat(healthRouter),
  HttpRouter.concat(modelsRouter.pipe(HttpRouter.prefixAll("/api/models"))),
  HttpRouter.concat(fieldsRouter.pipe(HttpRouter.prefixAll("/api"))),
  HttpRouter.concat(recordsRouter.pipe(HttpRouter.prefixAll("/api"))),
  HttpRouter.concat(assetsRouter.pipe(HttpRouter.prefixAll("/api/assets"))),
  HttpRouter.concat(localesRouter.pipe(HttpRouter.prefixAll("/api/locales"))),
  HttpRouter.concat(schemaRouter.pipe(HttpRouter.prefixAll("/api/schema"))),
  HttpRouter.concat(searchRouter.pipe(HttpRouter.prefixAll("/api/search"))),
  HttpRouter.concat(tokensRouter.pipe(HttpRouter.prefixAll("/api/tokens"))),
  HttpRouter.concat(previewTokensRouter.pipe(HttpRouter.prefixAll("/api/preview-tokens"))),
  HttpRouter.concat(setupRouter.pipe(HttpRouter.prefixAll("/api"))),
  HttpRouter.concat(pathsRouter.pipe(HttpRouter.prefixAll("/paths"))),
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
    fetch: options?.fetch ?? globalThis.fetch,
  });
  const fullLayer = Layer.mergeAll(sqlLayer, vectorizeLayer, hooksLayer, assetImportLayer, Logger.json);

  const runLoggedEffect = (effect: Effect.Effect<unknown, unknown>) => {
    Effect.runFork(effect.pipe(Effect.provide(fullLayer), Effect.orDie));
  };

  const logInfo = (message: string, fields: Record<string, unknown>) => {
    runLoggedEffect(Effect.logInfo(message).pipe(Effect.annotateLogs(fields)));
  };

  const logError = (message: string, fields: Record<string, unknown>) => {
    runLoggedEffect(Effect.logError(message).pipe(Effect.annotateLogs(fields)));
  };

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
      return Effect.logError("REST handler error").pipe(
        Effect.annotateLogs({ error: describeUnknown(error) }),
        Effect.zipRight(HttpServerResponse.json({ error: "Internal server error" }, { status: 500 })),
      );
    }),
    Effect.provide(fullLayer)
  );
  // @effect/platform router type variance requires this assertion
  const restHandler = HttpApp.toWebHandler(restApp as HttpApp.Default);

  // Lazy-import handlers to avoid circular deps
  let graphqlInstance: {
    handle: (req: Request) => Promise<Response>;
    getSchema: () => Promise<import("graphql").GraphQLSchema>;
    invalidateSchema: () => void;
    execute: (
      query: string,
      variables?: Record<string, unknown>,
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

  async function runScheduledTransitions(now = new Date()) {
    const result = await Effect.runPromise(
      ScheduleService.runScheduledTransitions(now).pipe(
        Effect.withSpan("schedule.run_transitions"),
        Effect.annotateLogs({ now: now.toISOString() }),
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
      try {
        await Effect.runPromise(
          TokenService.validateEditorToken(token).pipe(Effect.provide(fullLayer))
        );
        return null;
      } catch {
        return new UnauthorizedError({
          message: "Unauthorized. Invalid or expired editor token.",
        });
      }
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
      try {
        const editorToken = await Effect.runPromise(
          TokenService.validateEditorToken(token).pipe(Effect.provide(fullLayer))
        );
        return {
          type: "editor",
          label: editorToken.name,
          tokenId: editorToken.id,
        };
      } catch {
        return null;
      }
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
          try {
            const result = await Effect.runPromise(
              PreviewService.validatePreviewToken(previewToken).pipe(Effect.provide(fullLayer))
            );
            if (result.valid) {
              h.set("X-Include-Drafts", "true");
            }
          } catch {
            // Invalid preview token — ignore, don't grant draft access
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
          const stubCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
          return finish(await handler(instrumentedRequest, {}, stubCtx));
        }
        // Standard MCP fallback (no loader)
        const { createMcpHttpHandler } = await import("../mcp/http-transport.js");
        const actor = await getRequestActor(instrumentedRequest);
        const handler = actor?.type === "admin"
          ? (mcpHandler ??= createMcpHttpHandler(fullLayer, {
              mode: "admin",
              path: "/mcp",
              r2Bucket: options?.r2Bucket,
              assetBaseUrl: options?.assetBaseUrl,
              siteUrl: options?.siteUrl,
              actor,
            }))
          : createMcpHttpHandler(fullLayer, {
              mode: "admin",
              path: "/mcp",
              r2Bucket: options?.r2Bucket,
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
          const stubCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
          return finish(await handler(instrumentedRequest, {}, stubCtx));
        }
        // Standard MCP fallback (no loader)
        const { createMcpHttpHandler } = await import("../mcp/http-transport.js");
        const actor = await getRequestActor(instrumentedRequest);
        const handler = actor?.type === "editor"
          ? createMcpHttpHandler(fullLayer, {
              mode: "editor",
              path: "/mcp/editor",
              r2Bucket: options?.r2Bucket,
              assetBaseUrl: options?.assetBaseUrl,
              siteUrl: options?.siteUrl,
              actor,
            })
          : (mcpEditorHandler ??= createMcpHttpHandler(fullLayer, {
              mode: "editor",
              path: "/mcp/editor",
              r2Bucket: options?.r2Bucket,
              assetBaseUrl: options?.assetBaseUrl,
              siteUrl: options?.siteUrl,
              actor,
            }));
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
        const parsed = Schema.decodeUnknownSync(CreateUploadUrlInput)(body);
        const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
        const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
        const creds = options.r2Credentials;
        const assetId = crypto.randomUUID();
        const r2Key = `uploads/${assetId}/${parsed.filename}`;
        const s3 = new S3Client({
          region: "auto",
          endpoint: `https://${creds.accountId}.r2.cloudflarestorage.com`,
          credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
        });
        const command = new PutObjectCommand({
          Bucket: creds.bucketName,
          Key: r2Key,
          ContentType: parsed.mimeType,
        });
        const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
        return finish(new Response(JSON.stringify({ uploadUrl, r2Key, assetId }), {
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
      const response = await restHandler(instrumentedRequest);
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
      variables?: Record<string, unknown>,
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
