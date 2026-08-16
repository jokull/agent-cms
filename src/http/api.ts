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
import { CreateModelInput, UpdateModelInput, CreateFieldInput, UpdateFieldInput } from "../services/input-schemas.js";
import { SchemaEngineError, isCmsError, type CmsError } from "../errors.js";
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

export const CmsApi = HttpApi.make("cms").add(ModelsGroup, FieldsGroup);

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
export const ApiHandlersLayer = Layer.mergeAll(ModelsHandlers, FieldsHandlers);
