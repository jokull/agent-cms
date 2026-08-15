/**
 * HttpApiGroup for search endpoints.
 *
 * Defines the declarative API shape — handlers are implemented separately
 * via HttpApiBuilder.group().
 */
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import {
  SearchInput,
  ReindexSearchInput,
} from "../../services/input-schemas.js";

export const searchGroup = HttpApiGroup.make("search")
  .annotate(OpenApi.Title, "Search")
  .annotate(OpenApi.Description, "Full-text and vector search")
  .add(
    HttpApiEndpoint.post("search", "/search", {
      payload: SearchInput,
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Search content"),
  )
  .add(
    HttpApiEndpoint.post("reindexSearch", "/search/reindex", {
      payload: ReindexSearchInput,
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Reindex search"),
  );
