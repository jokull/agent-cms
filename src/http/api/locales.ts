/**
 * HttpApiGroup for locale endpoints.
 *
 * Defines the declarative API shape — handlers are implemented separately
 * via HttpApiBuilder.group().
 */
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "@effect/platform";
import { Schema } from "effect";
import { CreateLocaleInput } from "../../services/input-schemas.js";

export const localesGroup = HttpApiGroup.make("locales")
  .annotate(OpenApi.Title, "Locales")
  .annotate(OpenApi.Description, "Locale management")
  .add(
    HttpApiEndpoint.get("listLocales", "/locales")
      .annotate(OpenApi.Summary, "List all locales")
      .addSuccess(Schema.Unknown),
  )
  .add(
    HttpApiEndpoint.post("createLocale", "/locales")
      .annotate(OpenApi.Summary, "Create a new locale")
      .setPayload(CreateLocaleInput)
      .addSuccess(Schema.Unknown, { status: 201 }),
  )
  .add(
    HttpApiEndpoint.del("deleteLocale", "/locales/:id")
      .annotate(OpenApi.Summary, "Delete a locale")
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(Schema.Unknown),
  );
