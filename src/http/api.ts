/**
 * HttpApi definition for the REST surface (Wave 16 migration).
 *
 * The models group is the first slice: declared endpoints, input schemas
 * from input-schemas.ts, and the CmsErrorSchema union as the declared error
 * contract — replacing the boundary isCmsError mapping for these routes.
 * Success schemas are pass-through (Schema.Unknown) until the response
 * DTO schemas land; the response shapes are byte-identical to the previous
 * HttpRouter routes (verified by the api-models suite).
 */
import { Effect, Layer, Schema } from "effect";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import * as ModelService from "../services/model-service.js";
import * as FieldService from "../services/field-service.js";
import * as RecordService from "../services/record-service.js";
import * as VersionService from "../services/version-service.js";
import * as PublishService from "../services/publish-service.js";
import * as ScheduleService from "../services/schedule-service.js";
import * as LocaleService from "../services/locale-service.js";
import * as SchemaIO from "../services/schema-io.js";
import * as SearchService from "../search/search-service.js";
import * as TokenService from "../services/token-service.js";
import * as PreviewService from "../services/preview-service.js";
import * as PathService from "../services/path-service.js";
import { actorFromHeaders } from "../attribution.js";
import {
  CreateModelInput, UpdateModelInput, CreateFieldInput, UpdateFieldInput,
  CreateRecordInput, PatchRecordInput, PatchBlocksInput, BulkCreateRecordsInput,
  QueryRecordsInput, ValidateRecordInput, BulkRecordOperationInput,
  ScheduleRecordInput, ReorderInput,
  CreateLocaleInput, ImportSchemaInput, SearchInput, ReindexSearchInput,
} from "../services/input-schemas.js";
import { ensureSchema } from "../migrations.js";
import { SchemaEngineError, ValidationError, isCmsError, type CmsError } from "../errors.js";
import { CmsApiErrorList } from "./api-errors.js";

/**
 * Map any failure into the declared error union. Tagged errors pass through;
 * everything else (SQL layer errors, defects) becomes a SchemaEngineError —
 * the same contract the old boundary mapper gave (500 vs the mapped status).
 */
function toDeclaredError(error: unknown): CmsError {
  if (isCmsError(error)) return error;
  return new SchemaEngineError({
    message: error instanceof Error ? error.message : String(error),
  });
}

const ModelsGroup = HttpApiGroup.make("models").add(
  HttpApiEndpoint.get("list", "/", {
    success: Schema.Array(Schema.Unknown),
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.post("create", "/", {
    payload: CreateModelInput,
    success: HttpApiSchema.status(201)(Schema.Unknown),
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.get("get", "/:id", {
    params: Schema.Struct({ id: Schema.String }),
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.patch("update", "/:id", {
    params: Schema.Struct({ id: Schema.String }),
    payload: UpdateModelInput,
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.delete("delete", "/:id", {
    params: Schema.Struct({ id: Schema.String }),
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
).prefix("/api/models");



const FieldsGroup = HttpApiGroup.make("fields").add(
  HttpApiEndpoint.get("list", "/models/:modelId/fields", {
    params: Schema.Struct({ modelId: Schema.String }),
    success: Schema.Array(Schema.Unknown),
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.post("create", "/models/:modelId/fields", {
    params: Schema.Struct({ modelId: Schema.String }),
    payload: CreateFieldInput,
    success: HttpApiSchema.status(201)(Schema.Unknown),
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.patch("update", "/models/:modelId/fields/:fieldId", {
    params: Schema.Struct({ modelId: Schema.String, fieldId: Schema.String }),
    payload: UpdateFieldInput,
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.delete("delete", "/models/:modelId/fields/:fieldId", {
    params: Schema.Struct({ modelId: Schema.String, fieldId: Schema.String }),
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
).prefix("/api");

const ModelKeyQuery = Schema.Struct({ modelApiKey: Schema.String });
const SearchQuery = Schema.Struct({
  modelApiKey: Schema.String,
  q: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.String),
  offset: Schema.optional(Schema.String),
});
const RecordIdParams = Schema.Struct({ id: Schema.String });
const VersionParams = Schema.Struct({ id: Schema.String, versionId: Schema.String });
const NoContent = HttpApiSchema.status(204)(Schema.Void);

const RecordsGroup = HttpApiGroup.make("records").add(
  HttpApiEndpoint.post("bulkCreate", "/records/bulk", {
    payload: BulkCreateRecordsInput,
    success: HttpApiSchema.status(201)(Schema.Unknown),
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.post("create", "/records", {
    payload: CreateRecordInput,
    success: HttpApiSchema.status(201)(Schema.Unknown),
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.get("list", "/records", {
    query: ModelKeyQuery,
    success: Schema.Array(Schema.Unknown),
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.post("query", "/records/query", {
    payload: QueryRecordsInput,
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.get("pickerSearch", "/records/picker-search", {
    query: SearchQuery,
    success: Schema.Array(Schema.Unknown),
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.post("validate", "/records/validate", {
    payload: ValidateRecordInput,
    success: NoContent,
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.post("bulkPublish", "/records/bulk-publish", {
    payload: BulkRecordOperationInput,
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.post("bulkUnpublish", "/records/bulk-unpublish", {
    payload: BulkRecordOperationInput,
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.post("bulkDelete", "/records/bulk-delete", {
    payload: BulkRecordOperationInput,
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.get("listVersions", "/records/:id/versions", {
    params: RecordIdParams,
    query: ModelKeyQuery,
    success: Schema.Array(Schema.Unknown),
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.get("getVersion", "/records/:id/versions/:versionId", {
    params: VersionParams,
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.post("restoreVersion", "/records/:id/versions/:versionId/restore", {
    params: VersionParams,
    query: ModelKeyQuery,
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.get("links", "/records/:id/links", {
    params: RecordIdParams,
    query: ModelKeyQuery,
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.post("duplicate", "/records/:id/duplicate", {
    params: RecordIdParams,
    payload: Schema.Struct({ modelApiKey: Schema.NonEmptyString }),
    success: HttpApiSchema.status(201)(Schema.Unknown),
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.post("validateUpdate", "/records/:id/validate", {
    params: RecordIdParams,
    payload: ValidateRecordInput,
    success: NoContent,
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.get("syncState", "/records/:id/sync-state", {
    params: RecordIdParams,
    query: ModelKeyQuery,
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.get("get", "/records/:id", {
    params: RecordIdParams,
    query: ModelKeyQuery,
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.patch("patch", "/records/:id", {
    params: RecordIdParams,
    payload: PatchRecordInput,
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.patch("patchBlocks", "/records/:id/blocks", {
    params: RecordIdParams,
    // recordId comes from the URL, not the body (the old route merged it in).
    payload: Schema.Struct({
      ...PatchBlocksInput.fields,
      recordId: Schema.optional(Schema.String),
    }),
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.delete("delete", "/records/:id", {
    params: RecordIdParams,
    query: ModelKeyQuery,
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.post("publish", "/records/:id/publish", {
    params: RecordIdParams,
    query: ModelKeyQuery,
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.post("unpublish", "/records/:id/unpublish", {
    params: RecordIdParams,
    query: ModelKeyQuery,
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.post("schedulePublish", "/records/:id/schedule-publish", {
    params: RecordIdParams,
    payload: ScheduleRecordInput,
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.post("scheduleUnpublish", "/records/:id/schedule-unpublish", {
    params: RecordIdParams,
    payload: ScheduleRecordInput,
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.post("clearSchedule", "/records/:id/clear-schedule", {
    params: RecordIdParams,
    payload: Schema.Struct({ modelApiKey: Schema.NonEmptyString }),
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.post("reorder", "/reorder", {
    payload: ReorderInput,
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
).prefix("/api");


const IdParams = Schema.Struct({ id: Schema.String });

const LocalesGroup = HttpApiGroup.make("locales").add(
  HttpApiEndpoint.get("list", "/", { success: Schema.Array(Schema.Unknown), error: CmsApiErrorList }),
  HttpApiEndpoint.post("create", "/", {
    payload: CreateLocaleInput,
    success: HttpApiSchema.status(201)(Schema.Unknown),
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.delete("delete", "/:id", {
    params: IdParams,
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
).prefix("/api/locales");

const SchemaGroup = HttpApiGroup.make("schema").add(
  HttpApiEndpoint.get("export", "/", { success: Schema.Unknown, error: CmsApiErrorList }),
  HttpApiEndpoint.post("import", "/", {
    payload: ImportSchemaInput,
    success: HttpApiSchema.status(201)(Schema.Unknown),
    error: CmsApiErrorList,
  }),
).prefix("/api/schema");

const SearchGroup = HttpApiGroup.make("search").add(
  HttpApiEndpoint.post("search", "/", {
    payload: SearchInput,
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.post("reindex", "/reindex", {
    payload: ReindexSearchInput,
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
).prefix("/api/search");

const TokensGroup = HttpApiGroup.make("tokens").add(
  HttpApiEndpoint.get("list", "/", { success: Schema.Array(Schema.Unknown), error: CmsApiErrorList }),
  HttpApiEndpoint.post("create", "/", {
    // The expiresIn range checks live in the handler (payload-decode errors
    // would produce an empty 400 — the old flow surfaced the message).
    payload: Schema.Struct({
      name: Schema.NonEmptyString,
      expiresIn: Schema.optional(Schema.Number),
    }),
    success: HttpApiSchema.status(201)(Schema.Unknown),
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.delete("delete", "/:id", {
    params: IdParams,
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
).prefix("/api/tokens");

const PreviewTokensGroup = HttpApiGroup.make("previewTokens").add(
  HttpApiEndpoint.post("create", "/", {
    payload: Schema.Struct({ expiresIn: Schema.optional(Schema.Number) }),
    success: HttpApiSchema.status(201)(Schema.Unknown),
    error: CmsApiErrorList,
  }),
  HttpApiEndpoint.get("validate", "/", {
    query: Schema.Struct({ token: Schema.String }),
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
).prefix("/api/preview-tokens");

const PathsGroup = HttpApiGroup.make("paths").add(
  HttpApiEndpoint.get("resolve", "/:modelApiKey", {
    params: Schema.Struct({ modelApiKey: Schema.String }),
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
).prefix("/paths");

const SetupGroup = HttpApiGroup.make("setup").add(
  HttpApiEndpoint.post("run", "/", {
    success: Schema.Unknown,
    error: CmsApiErrorList,
  }),
).prefix("/api/setup");

export const CmsApi = HttpApi.make("cms").add(ModelsGroup, FieldsGroup, RecordsGroup, LocalesGroup, SchemaGroup, SearchGroup, TokensGroup, PreviewTokensGroup, PathsGroup, SetupGroup);
const LocalesHandlers = HttpApiBuilder.group(CmsApi, "locales", (handlers) =>
  handlers
    .handle("list", () => LocaleService.listLocales().pipe(Effect.mapError(toDeclaredError)))
    .handle("create", ({ payload }) => LocaleService.createLocale(payload).pipe(Effect.mapError(toDeclaredError)))
    .handle("delete", ({ params }) => LocaleService.deleteLocale(params.id).pipe(Effect.mapError(toDeclaredError))),
);

const SchemaHandlers = HttpApiBuilder.group(CmsApi, "schema", (handlers) =>
  handlers
    .handle("export", () => SchemaIO.exportSchema().pipe(Effect.mapError(toDeclaredError)))
    .handle("import", ({ payload }) => SchemaIO.importSchema(payload).pipe(Effect.mapError(toDeclaredError))),
);

const SearchHandlers = HttpApiBuilder.group(CmsApi, "search", (handlers) =>
  handlers
    .handle("search", ({ payload }) => SearchService.search(payload).pipe(Effect.mapError(toDeclaredError)))
    .handle("reindex", ({ payload }) => SearchService.reindexAll(payload.modelApiKey).pipe(Effect.mapError(toDeclaredError))),
);

const TokensHandlers = HttpApiBuilder.group(CmsApi, "tokens", (handlers) =>
  handlers
    .handle("list", () => TokenService.listEditorTokens().pipe(Effect.mapError(toDeclaredError)))
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        if (payload.expiresIn !== undefined) {
          if (payload.expiresIn <= 0) {
            return yield* new ValidationError({ message: "Expected a positive number" });
          }
          if (payload.expiresIn > 60 * 60 * 24 * 365) {
            return yield* new ValidationError({ message: "expiresIn must be <= 31536000 seconds" });
          }
        }
        return yield* TokenService.createEditorToken(payload).pipe(Effect.mapError(toDeclaredError));
      }))
    .handle("delete", ({ params }) => TokenService.revokeEditorToken(params.id).pipe(Effect.mapError(toDeclaredError))),
);

const PreviewTokensHandlers = HttpApiBuilder.group(CmsApi, "previewTokens", (handlers) =>
  handlers
    .handle("create", ({ payload }) => PreviewService.createPreviewToken(payload.expiresIn).pipe(Effect.mapError(toDeclaredError)))
    .handle("validate", ({ query }) => PreviewService.validatePreviewToken(query.token).pipe(Effect.mapError(toDeclaredError))),
);

const PathsHandlers = HttpApiBuilder.group(CmsApi, "paths", (handlers) =>
  handlers.handle("resolve", ({ params }) => PathService.resolveCanonicalPaths(params.modelApiKey).pipe(Effect.mapError(toDeclaredError))),
);

const SetupHandlers = HttpApiBuilder.group(CmsApi, "setup", (handlers) =>
  handlers.handle("run", () => ensureSchema().pipe(Effect.as({ ok: true }), Effect.mapError(toDeclaredError))),
);

const RecordsHandlers = HttpApiBuilder.group(CmsApi, "records", (handlers) => {
  const actor = (args: { request: unknown }) =>
    // SAFETY: HttpApi handler args always carry the HttpServerRequest.
    actorFromHeaders(new Headers((args.request as { headers: Headers }).headers));
  return handlers
    .handle("bulkCreate", (args) => Effect.gen(function* () {
      const a = actor(args);
      return yield* RecordService.bulkCreateRecords(args.payload, a).pipe(Effect.mapError(toDeclaredError));
    }))
    .handle("create", (args) => Effect.gen(function* () {
      const a = actor(args);
      return yield* RecordService.createRecord(args.payload, a).pipe(Effect.mapError(toDeclaredError));
    }))
    .handle("list", ({ query }) => RecordService.listRecords(query.modelApiKey).pipe(Effect.mapError(toDeclaredError)))
    .handle("query", ({ payload }) => RecordService.queryRecords(payload.modelApiKey, {
      filter: payload.filter,
      orderBy: payload.orderBy,
      page: payload.page,
      status: payload.status,
      locale: payload.locale,
    }).pipe(Effect.mapError(toDeclaredError)))
    .handle("pickerSearch", ({ query }) => RecordService.searchRecords(query.modelApiKey, query.q ?? "", {
      limit: query.limit !== undefined ? Number(query.limit) : undefined,
      offset: query.offset !== undefined ? Number(query.offset) : undefined,
    }).pipe(Effect.mapError(toDeclaredError)))
    .handle("validate", ({ payload }) => RecordService.validateRecord(payload.modelApiKey, payload.data).pipe(Effect.asVoid, Effect.mapError(toDeclaredError)))
    .handle("bulkPublish", (args) => Effect.gen(function* () {
      const a = actor(args);
      return yield* RecordService.publishRecords(args.payload.modelApiKey, args.payload.ids, a).pipe(Effect.mapError(toDeclaredError));
    }))
    .handle("bulkUnpublish", (args) => Effect.gen(function* () {
      const a = actor(args);
      return yield* RecordService.unpublishRecords(args.payload.modelApiKey, args.payload.ids, a).pipe(Effect.mapError(toDeclaredError));
    }))
    .handle("bulkDelete", (args) => Effect.gen(function* () {
      const a = actor(args);
      return yield* RecordService.deleteRecords(args.payload.modelApiKey, args.payload.ids, a).pipe(Effect.mapError(toDeclaredError));
    }))
    .handle("listVersions", ({ params, query }) => VersionService.listVersions(query.modelApiKey, params.id).pipe(Effect.mapError(toDeclaredError)))
    .handle("getVersion", ({ params }) => VersionService.getVersion(params.versionId).pipe(Effect.mapError(toDeclaredError)))
    .handle("restoreVersion", (args) => Effect.gen(function* () {
      const a = actor(args);
      return yield* VersionService.restoreVersion(args.query.modelApiKey, args.params.id, args.params.versionId, a).pipe(Effect.mapError(toDeclaredError));
    }))
    .handle("links", ({ params, query }) => RecordService.getRecordBacklinks(query.modelApiKey, params.id).pipe(Effect.mapError(toDeclaredError)))
    .handle("duplicate", (args) => Effect.gen(function* () {
      const a = actor(args);
      return yield* RecordService.duplicateRecord(args.payload.modelApiKey, args.params.id, a).pipe(Effect.mapError(toDeclaredError));
    }))
    .handle("validateUpdate", ({ params, payload }) => RecordService.validateRecordUpdate(payload.modelApiKey, params.id, payload.data).pipe(Effect.asVoid, Effect.mapError(toDeclaredError)))
    .handle("syncState", ({ params, query }) => RecordService.getSyncState(query.modelApiKey, params.id).pipe(Effect.mapError(toDeclaredError)))
    .handle("get", ({ params, query }) => RecordService.getRecord(query.modelApiKey, params.id).pipe(Effect.mapError(toDeclaredError)))
    .handle("patch", (args) => Effect.gen(function* () {
      const a = actor(args);
      return yield* RecordService.patchRecord(args.params.id, args.payload, a).pipe(Effect.mapError(toDeclaredError));
    }))
    .handle("patchBlocks", (args) => Effect.gen(function* () {
      const a = actor(args);
      return yield* RecordService.patchBlocksForField(
        { ...args.payload, recordId: args.params.id },
        a,
      ).pipe(Effect.mapError(toDeclaredError));
    }))
    .handle("delete", ({ params, query }) => RecordService.removeRecord(query.modelApiKey, params.id).pipe(Effect.mapError(toDeclaredError)))
    .handle("publish", (args) => Effect.gen(function* () {
      const a = actor(args);
      return yield* PublishService.publishRecord(args.query.modelApiKey, args.params.id, a).pipe(Effect.mapError(toDeclaredError));
    }))
    .handle("unpublish", (args) => Effect.gen(function* () {
      const a = actor(args);
      return yield* PublishService.unpublishRecord(args.query.modelApiKey, args.params.id, a).pipe(Effect.mapError(toDeclaredError));
    }))
    .handle("schedulePublish", (args) => Effect.gen(function* () {
      const a = actor(args);
      return yield* ScheduleService.schedulePublish(args.payload.modelApiKey, args.params.id, args.payload.at, a).pipe(Effect.mapError(toDeclaredError));
    }))
    .handle("scheduleUnpublish", (args) => Effect.gen(function* () {
      const a = actor(args);
      return yield* ScheduleService.scheduleUnpublish(args.payload.modelApiKey, args.params.id, args.payload.at, a).pipe(Effect.mapError(toDeclaredError));
    }))
    .handle("clearSchedule", (args) => Effect.gen(function* () {
      const a = actor(args);
      return yield* ScheduleService.clearSchedule(args.payload.modelApiKey, args.params.id, a).pipe(Effect.mapError(toDeclaredError));
    }))
    .handle("reorder", (args) => Effect.gen(function* () {
      const a = actor(args);
      return yield* RecordService.reorderRecords(args.payload.modelApiKey, args.payload.recordIds, a).pipe(Effect.mapError(toDeclaredError));
    }));
});


const ModelsHandlers = HttpApiBuilder.group(CmsApi, "models", (handlers) =>
  handlers.handle("list", () => ModelService.listModels().pipe(Effect.mapError(toDeclaredError)))
    .handle("create", ({ payload }) => ModelService.createModel(payload).pipe(Effect.mapError(toDeclaredError)))
    .handle("get", ({ params }) => ModelService.getModel(params.id).pipe(Effect.mapError(toDeclaredError)))
    .handle("update", ({ params, payload }) => ModelService.updateModel(params.id, payload).pipe(Effect.mapError(toDeclaredError)))
    .handle("delete", ({ params }) => ModelService.deleteModel(params.id).pipe(Effect.mapError(toDeclaredError))),
);


const FieldsHandlers = HttpApiBuilder.group(CmsApi, "fields", (handlers) =>
  handlers.handle("list", ({ params }) => FieldService.listFields(params.modelId).pipe(Effect.mapError(toDeclaredError)))
    .handle("create", ({ params, payload }) => FieldService.createField(params.modelId, payload).pipe(Effect.mapError(toDeclaredError)))
    .handle("update", ({ params, payload }) => FieldService.updateField(params.fieldId, payload).pipe(Effect.mapError(toDeclaredError)))
    .handle("delete", ({ params }) => FieldService.deleteField(params.fieldId).pipe(Effect.mapError(toDeclaredError))),
);

export const ApiLayer = HttpApiBuilder.layer(CmsApi);
export const ApiHandlersLayer = Layer.mergeAll(ModelsHandlers, FieldsHandlers, RecordsHandlers, LocalesHandlers, SchemaHandlers, SearchHandlers, TokensHandlers, PreviewTokensHandlers, PathsHandlers, SetupHandlers);
