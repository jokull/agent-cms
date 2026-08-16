/**
 * HttpApiGroup for locale endpoints.
 *
 * Defines the declarative API shape — handlers are implemented separately
 * via HttpApiBuilder.group().
 */
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { CreateLocaleInput } from "../../services/input-schemas.js";

export const localesGroup = HttpApiGroup.make("locales")
  .annotate(OpenApi.Title, "Locales")
  .annotate(OpenApi.Description, "Locale management")
  .add(
    HttpApiEndpoint.get("listLocales", "/locales", {
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "List all locales"),
  )
  .add(
    HttpApiEndpoint.post("createLocale", "/locales", {
      payload: CreateLocaleInput,
      success: HttpApiSchema.status(201)(Schema.Unknown),
    })
      .annotate(OpenApi.Summary, "Create a new locale"),
  )
  .add(
    HttpApiEndpoint.make("DELETE")("deleteLocale", "/locales/:id", {
      params: Schema.Struct({ id: Schema.String }),
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Delete a locale"),
  );
