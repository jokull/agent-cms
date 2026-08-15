/**
 * HttpApiGroup for preview token endpoints.
 *
 * Defines the declarative API shape — handlers are implemented separately
 * via HttpApiBuilder.group().
 */
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";

export const previewTokensGroup = HttpApiGroup.make("preview-tokens")
  .annotate(OpenApi.Title, "Preview Tokens")
  .annotate(OpenApi.Description, "Preview token creation and validation")
  .add(
    HttpApiEndpoint.post("createPreviewToken", "/preview-tokens", {
      payload: Schema.Struct({
        expiresIn: Schema.optional(Schema.Number),
      }),
      success: HttpApiSchema.status(201)(Schema.Unknown),
    })
      .annotate(OpenApi.Summary, "Create a preview token"),
  )
  .add(
    HttpApiEndpoint.get("validatePreviewToken", "/preview-tokens/validate", {
      query: Schema.Struct({ token: Schema.String }),
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Validate a preview token"),
  );
