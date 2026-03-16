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
function handle<A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient>,
  status: number = 200
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, SqlClient.SqlClient> {
  return effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json(result, { status })),
    Effect.catchAll((error) => {
      // Check if it's one of our typed CMS errors
      if (error && typeof error === "object" && "_tag" in error && "message" in error) {
        const mapped = errorToResponse(error as CmsError); // narrowed by _tag + message check
        if (mapped) {
          return HttpServerResponse.json(mapped.body, { status: mapped.status });
        }
      }
      // Unknown error — 500
      console.error("Unhandled error:", error);
      return HttpServerResponse.json({ error: "Internal server error" }, { status: 500 });
    }),
    Effect.catchAllDefect((defect) => {
      console.error("Defect:", defect);
      return HttpServerResponse.json({ error: "Internal server error" }, { status: 500 });
    })
  );
}

/** Get path params */
function pathParams() {
  return HttpRouter.params;
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
      return yield* handle(ModelService.getModel(params.id));
    })
  ),

  HttpRouter.patch(
    "/:id",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const req = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* req.json;
      return yield* handle(ModelService.updateModel(params.id, body));
    })
  ),

  HttpRouter.del(
    "/:id",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      return yield* handle(ModelService.deleteModel(params.id));
    })
  )
);

// --- Fields ---
const fieldsRouter = HttpRouter.empty.pipe(
  HttpRouter.get(
    "/models/:modelId/fields",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      return yield* handle(FieldService.listFields(params.modelId));
    })
  ),

  HttpRouter.post(
    "/models/:modelId/fields",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const req = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* req.json;
      return yield* handle(FieldService.createField(params.modelId, body), 201);
    })
  ),

  HttpRouter.patch(
    "/models/:modelId/fields/:fieldId",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const req = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* req.json;
      return yield* handle(FieldService.updateField(params.fieldId, body));
    })
  ),

  HttpRouter.del(
    "/models/:modelId/fields/:fieldId",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      return yield* handle(FieldService.deleteField(params.fieldId));
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
      return yield* handle(RecordService.getRecord(modelApiKey, params.id));
    })
  ),

  HttpRouter.patch(
    "/records/:id",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const req = yield* HttpServerRequest.HttpServerRequest;
      const body = yield* req.json;
      return yield* handle(RecordService.patchRecord(params.id, body));
    })
  ),

  HttpRouter.del(
    "/records/:id",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const modelApiKey = yield* queryParam("modelApiKey");
      return yield* handle(RecordService.removeRecord(modelApiKey, params.id));
    })
  ),

  // Publish / Unpublish
  HttpRouter.post(
    "/records/:id/publish",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const modelApiKey = yield* queryParam("modelApiKey");
      return yield* handle(PublishService.publishRecord(modelApiKey, params.id));
    })
  ),

  HttpRouter.post(
    "/records/:id/unpublish",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const modelApiKey = yield* queryParam("modelApiKey");
      return yield* handle(PublishService.unpublishRecord(modelApiKey, params.id));
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
      return yield* handle(AssetService.getAsset(params.id));
    })
  ),

  HttpRouter.del(
    "/:id",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      return yield* handle(AssetService.deleteAsset(params.id));
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
      return yield* handle(LocaleService.deleteLocale(params.id));
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
export function createWebHandler(sqlLayer: any) {
  const restHandler = HttpApp.toWebHandler(
    Effect.flatten(HttpRouter.toHttpApp(appRouter)).pipe(
      Effect.provide(sqlLayer)
    )
  );

  // Lazy-import GraphQL handler to avoid circular deps
  let graphqlHandler: ((req: Request) => Promise<Response>) | null = null;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    // Route /graphql to Yoga
    if (url.pathname === "/graphql") {
      if (!graphqlHandler) {
        const { createGraphQLHandler } = await import("../graphql/handler.js");
        graphqlHandler = createGraphQLHandler(sqlLayer);
      }
      return graphqlHandler(request);
    }

    // Everything else to the Effect router
    return restHandler(request);
  };
}
