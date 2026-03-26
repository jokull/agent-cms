/**
 * HttpApiGroup for content model endpoints.
 *
 * Defines the declarative API shape — handlers are implemented separately
 * via HttpApiBuilder.group().
 */
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "@effect/platform";
import { Schema } from "effect";
import {
  CreateModelInput,
  UpdateModelInput,
} from "../../services/input-schemas.js";

const ModelResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  apiKey: Schema.String,
  isBlock: Schema.Boolean,
  singleton: Schema.Boolean,
  sortable: Schema.Boolean,
  tree: Schema.Boolean,
  hasDraft: Schema.Boolean,
  allLocalesRequired: Schema.Boolean,
  ordering: Schema.NullOr(Schema.String),
  canonicalPathTemplate: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const ModelWithFieldsResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  api_key: Schema.String,
  is_block: Schema.Number,
  singleton: Schema.Number,
  sortable: Schema.Number,
  tree: Schema.Number,
  has_draft: Schema.Number,
  all_locales_required: Schema.Number,
  ordering: Schema.NullOr(Schema.String),
  canonical_path_template: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
  fields: Schema.Array(Schema.Unknown),
});

const DeleteModelResponse = Schema.Struct({
  deleted: Schema.Boolean,
  recordsDestroyed: Schema.Number,
});

export const modelsGroup = HttpApiGroup.make("models")
  .annotate(OpenApi.Title, "Models")
  .annotate(OpenApi.Description, "Content model management")
  .add(
    HttpApiEndpoint.get("listModels", "/models")
      .annotate(OpenApi.Summary, "List all content models")
      .addSuccess(Schema.Array(ModelResponse)),
  )
  .add(
    HttpApiEndpoint.post("createModel", "/models")
      .annotate(OpenApi.Summary, "Create a new content model")
      .setPayload(CreateModelInput)
      .addSuccess(ModelResponse, { status: 201 }),
  )
  .add(
    HttpApiEndpoint.get("getModel", "/models/:id")
      .annotate(OpenApi.Summary, "Get a content model by ID or api_key")
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(ModelWithFieldsResponse),
  )
  .add(
    HttpApiEndpoint.patch("updateModel", "/models/:id")
      .annotate(OpenApi.Summary, "Update a content model")
      .setPath(Schema.Struct({ id: Schema.String }))
      .setPayload(UpdateModelInput)
      .addSuccess(ModelResponse),
  )
  .add(
    HttpApiEndpoint.del("deleteModel", "/models/:id")
      .annotate(OpenApi.Summary, "Delete a content model")
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(DeleteModelResponse),
  );
