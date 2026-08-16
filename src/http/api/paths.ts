/**
 * HttpApiGroup for canonical path resolution endpoints.
 *
 * Defines the declarative API shape — handlers are implemented separately
 * via HttpApiBuilder.group().
 */
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";

export const pathsGroup = HttpApiGroup.make("paths")
  .annotate(OpenApi.Title, "Paths")
  .annotate(OpenApi.Description, "Canonical path resolution")
  .add(
    HttpApiEndpoint.get("resolveCanonicalPaths", "/paths/:modelApiKey", {
      params: Schema.Struct({ modelApiKey: Schema.String }),
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Resolve canonical paths for a model"),
  );
