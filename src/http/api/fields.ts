/**
 * HttpApiGroup for field endpoints.
 *
 * Defines the declarative API shape — handlers are implemented separately
 * via HttpApiBuilder.group().
 */
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "@effect/platform";
import { Schema } from "effect";
import {
  CreateFieldInput,
  UpdateFieldInput,
} from "../../services/input-schemas.js";

export const fieldsGroup = HttpApiGroup.make("fields")
  .annotate(OpenApi.Title, "Fields")
  .annotate(OpenApi.Description, "Content model field management")
  .add(
    HttpApiEndpoint.get("listFields", "/models/:modelId/fields")
      .annotate(OpenApi.Summary, "List all fields for a model")
      .setPath(Schema.Struct({ modelId: Schema.String }))
      .addSuccess(Schema.Array(Schema.Unknown)),
  )
  .add(
    HttpApiEndpoint.post("createField", "/models/:modelId/fields")
      .annotate(OpenApi.Summary, "Create a new field on a model")
      .setPath(Schema.Struct({ modelId: Schema.String }))
      .setPayload(CreateFieldInput)
      .addSuccess(Schema.Unknown, { status: 201 }),
  )
  .add(
    HttpApiEndpoint.patch("updateField", "/models/:modelId/fields/:fieldId")
      .annotate(OpenApi.Summary, "Update a field")
      .setPath(
        Schema.Struct({ modelId: Schema.String, fieldId: Schema.String }),
      )
      .setPayload(UpdateFieldInput)
      .addSuccess(Schema.Unknown),
  )
  .add(
    HttpApiEndpoint.del("deleteField", "/models/:modelId/fields/:fieldId")
      .annotate(OpenApi.Summary, "Delete a field")
      .setPath(
        Schema.Struct({ modelId: Schema.String, fieldId: Schema.String }),
      )
      .addSuccess(Schema.Unknown),
  );
