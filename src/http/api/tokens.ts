/**
 * HttpApiGroup for editor token endpoints.
 *
 * Defines the declarative API shape — handlers are implemented separately
 * via HttpApiBuilder.group().
 */
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "@effect/platform";
import { Schema } from "effect";
import { CreateEditorTokenInput } from "../../services/input-schemas.js";

export const tokensGroup = HttpApiGroup.make("tokens")
  .annotate(OpenApi.Title, "Tokens")
  .annotate(OpenApi.Description, "Editor token management")
  .add(
    HttpApiEndpoint.get("listEditorTokens", "/tokens")
      .annotate(OpenApi.Summary, "List all editor tokens")
      .addSuccess(Schema.Unknown),
  )
  .add(
    HttpApiEndpoint.post("createEditorToken", "/tokens")
      .annotate(OpenApi.Summary, "Create an editor token")
      .setPayload(CreateEditorTokenInput)
      .addSuccess(Schema.Unknown, { status: 201 }),
  )
  .add(
    HttpApiEndpoint.del("revokeEditorToken", "/tokens/:id")
      .annotate(OpenApi.Summary, "Revoke an editor token")
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(Schema.Unknown),
  );
