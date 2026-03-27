/**
 * HttpApiGroup for preview token endpoints.
 *
 * Defines the declarative API shape — handlers are implemented separately
 * via HttpApiBuilder.group().
 */
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "@effect/platform";
import { Schema } from "effect";

export const previewTokensGroup = HttpApiGroup.make("preview-tokens")
  .annotate(OpenApi.Title, "Preview Tokens")
  .annotate(OpenApi.Description, "Preview token creation and validation")
  .add(
    HttpApiEndpoint.post("createPreviewToken", "/preview-tokens")
      .annotate(OpenApi.Summary, "Create a preview token")
      .setPayload(
        Schema.Struct({
          expiresIn: Schema.optional(Schema.Number),
        }),
      )
      .addSuccess(Schema.Unknown, { status: 201 }),
  )
  .add(
    HttpApiEndpoint.get("validatePreviewToken", "/preview-tokens/validate")
      .annotate(OpenApi.Summary, "Validate a preview token")
      .setUrlParams(Schema.Struct({ token: Schema.String }))
      .addSuccess(Schema.Unknown),
  );
