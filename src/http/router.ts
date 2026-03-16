import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpApp,
} from "@effect/platform";
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import * as ModelService from "../services/model-service.js";
import * as FieldService from "../services/field-service.js";
import * as RecordService from "../services/record-service.js";
import * as PublishService from "../services/publish-service.js";
import * as AssetService from "../services/asset-service.js";
import * as LocaleService from "../services/locale-service.js";
import { type CmsError, errorToResponse } from "../errors.js";

/** Helper: run a CMS Effect and return an HTTP response */
function handle<A>(
  effect: Effect.Effect<A, unknown, SqlClient.SqlClient>,
  status: number = 200
) {
  return effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json(result, { status })),
    Effect.catchAll((error: unknown) => {
      if (error && typeof error === "object" && "_tag" in error && "message" in error) {
        const mapped = errorToResponse(error as CmsError);
        if (mapped) return HttpServerResponse.json(mapped.body, { status: mapped.status });
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
      const body: unknown = yield* req.json;
      const b = (typeof body === "object" && body !== null) ? body : {};
      const modelApiKey = "modelApiKey" in b ? String(b.modelApiKey) : "";
      const recordIds = "recordIds" in b && Array.isArray(b.recordIds) ? b.recordIds.map(String) : [];
      return yield* handle(RecordService.reorderRecords(modelApiKey, recordIds));
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
);

/**
 * Create a web handler from the router + a SqlClient layer.
 * Includes GraphQL endpoint via Yoga.
 * Uses Effect.flatten to work around @effect/platform 0.94.5 nested Effect issue.
 */
export interface WebHandlerOptions {
  assetBaseUrl?: string;
  isProduction?: boolean;
}

export function createWebHandler(sqlLayer: any, options?: WebHandlerOptions) {
  const restApp = Effect.flatten(HttpRouter.toHttpApp(appRouter)).pipe(
    Effect.catchAll(() => HttpServerResponse.json({ error: "Not found" }, { status: 404 })),
    Effect.provide(sqlLayer)
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Effect/platform router type variance
  const restHandler = HttpApp.toWebHandler(restApp as any);

  // Lazy-import handlers to avoid circular deps
  let graphqlHandler: ((req: Request) => Promise<Response>) | null = null;
  let mcpHandler: ((req: Request) => Promise<Response>) | null = null;

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

  return async (request: Request): Promise<Response> => {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), request);
    }

    const url = new URL(request.url);

    // Route /mcp to MCP HTTP transport
    if (url.pathname === "/mcp") {
      if (!mcpHandler) {
        const { createMcpServer } = await import("../mcp/server.js");
        const { createMcpHttpHandler } = await import("../mcp/http-transport.js");
        const mcpServer = createMcpServer(sqlLayer);
        mcpHandler = createMcpHttpHandler(mcpServer);
      }
      const response = await mcpHandler(request);
      return withCors(response, request);
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
      const response = await graphqlHandler(request);
      return withCors(response, request);
    }

    // Everything else to the Effect router
    const response = await restHandler(request);
    return withCors(response, request);
  };
}
