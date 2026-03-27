/**
 * HttpApiGroup for search endpoints.
 *
 * Defines the declarative API shape — handlers are implemented separately
 * via HttpApiBuilder.group().
 */
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "@effect/platform";
import { Schema } from "effect";
import {
  SearchInput,
  ReindexSearchInput,
} from "../../services/input-schemas.js";

export const searchGroup = HttpApiGroup.make("search")
  .annotate(OpenApi.Title, "Search")
  .annotate(OpenApi.Description, "Full-text and vector search")
  .add(
    HttpApiEndpoint.post("search", "/search")
      .annotate(OpenApi.Summary, "Search content")
      .setPayload(SearchInput)
      .addSuccess(Schema.Unknown),
  )
  .add(
    HttpApiEndpoint.post("reindexSearch", "/search/reindex")
      .annotate(OpenApi.Summary, "Reindex search")
      .setPayload(ReindexSearchInput)
      .addSuccess(Schema.Unknown),
  );
