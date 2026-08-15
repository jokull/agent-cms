/**
 * HttpApiGroup for editor token endpoints.
 *
 * Defines the declarative API shape — handlers are implemented separately
 * via HttpApiBuilder.group().
 */
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { CreateEditorTokenInput } from "../../services/input-schemas.js";

export const tokensGroup = HttpApiGroup.make("tokens")
  .annotate(OpenApi.Title, "Tokens")
  .annotate(OpenApi.Description, "Editor token management")
  .add(
    HttpApiEndpoint.get("listEditorTokens", "/tokens", {
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "List all editor tokens"),
  )
  .add(
    HttpApiEndpoint.post("createEditorToken", "/tokens", {
      payload: CreateEditorTokenInput,
      success: HttpApiSchema.status(201)(Schema.Unknown),
    })
      .annotate(OpenApi.Summary, "Create an editor token"),
  )
  .add(
    HttpApiEndpoint.make("DELETE")("revokeEditorToken", "/tokens/:id", {
      params: Schema.Struct({ id: Schema.String }),
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Revoke an editor token"),
  );
