/**
 * HttpApiGroup for field endpoints.
 *
 * Defines the declarative API shape — handlers are implemented separately
 * via HttpApiBuilder.group().
 */
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import {
  CreateFieldInput,
  UpdateFieldInput,
} from "../../services/input-schemas.js";

export const fieldsGroup = HttpApiGroup.make("fields")
  .annotate(OpenApi.Title, "Fields")
  .annotate(OpenApi.Description, "Content model field management")
  .add(
    HttpApiEndpoint.get("listFields", "/models/:modelId/fields", {
      params: Schema.Struct({ modelId: Schema.String }),
      success: Schema.Array(Schema.Unknown),
    })
      .annotate(OpenApi.Summary, "List all fields for a model"),
  )
  .add(
    HttpApiEndpoint.post("createField", "/models/:modelId/fields", {
      params: Schema.Struct({ modelId: Schema.String }),
      payload: CreateFieldInput,
      success: HttpApiSchema.status(201)(Schema.Unknown),
    })
      .annotate(OpenApi.Summary, "Create a new field on a model"),
  )
  .add(
    HttpApiEndpoint.patch("updateField", "/models/:modelId/fields/:fieldId", {
      params: Schema.Struct({ modelId: Schema.String, fieldId: Schema.String }),
      payload: UpdateFieldInput,
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Update a field"),
  )
  .add(
    HttpApiEndpoint.make("DELETE")("deleteField", "/models/:modelId/fields/:fieldId", {
      params: Schema.Struct({ modelId: Schema.String, fieldId: Schema.String }),
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Delete a field"),
  );
