/**
 * HttpApiGroup for canonical path resolution endpoints.
 *
 * Defines the declarative API shape — handlers are implemented separately
 * via HttpApiBuilder.group().
 */
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "@effect/platform";
import { Schema } from "effect";

export const pathsGroup = HttpApiGroup.make("paths")
  .annotate(OpenApi.Title, "Paths")
  .annotate(OpenApi.Description, "Canonical path resolution")
  .add(
    HttpApiEndpoint.get("resolveCanonicalPaths", "/paths/:modelApiKey")
      .annotate(OpenApi.Summary, "Resolve canonical paths for a model")
      .setPath(Schema.Struct({ modelApiKey: Schema.String }))
      .addSuccess(Schema.Unknown),
  );
