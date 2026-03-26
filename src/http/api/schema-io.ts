/**
 * HttpApiGroup for schema import/export endpoints.
 *
 * Defines the declarative API shape — handlers are implemented separately
 * via HttpApiBuilder.group().
 */
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "@effect/platform";
import { Schema } from "effect";
import { ImportSchemaInput } from "../../services/input-schemas.js";

export const schemaGroup = HttpApiGroup.make("schema")
  .annotate(OpenApi.Title, "Schema")
  .annotate(OpenApi.Description, "Schema import and export")
  .add(
    HttpApiEndpoint.get("exportSchema", "/schema")
      .annotate(OpenApi.Summary, "Export the full schema")
      .addSuccess(Schema.Unknown),
  )
  .add(
    HttpApiEndpoint.post("importSchema", "/schema")
      .annotate(OpenApi.Summary, "Import a schema")
      .setPayload(ImportSchemaInput)
      .addSuccess(Schema.Unknown, { status: 201 }),
  );
