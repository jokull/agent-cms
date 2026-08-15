/**
 * HttpApiGroup for schema import/export endpoints.
 *
 * Defines the declarative API shape — handlers are implemented separately
 * via HttpApiBuilder.group().
 */
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { ImportSchemaInput } from "../../services/input-schemas.js";

export const schemaGroup = HttpApiGroup.make("schema")
  .annotate(OpenApi.Title, "Schema")
  .annotate(OpenApi.Description, "Schema import and export")
  .add(
    HttpApiEndpoint.get("exportSchema", "/schema", {
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Export the full schema"),
  )
  .add(
    HttpApiEndpoint.post("importSchema", "/schema", {
      payload: ImportSchemaInput,
      success: HttpApiSchema.status(201)(Schema.Unknown),
    })
      .annotate(OpenApi.Summary, "Import a schema"),
  );
