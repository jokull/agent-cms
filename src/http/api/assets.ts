/**
 * HttpApiGroup for asset endpoints.
 *
 * Defines the declarative API shape — handlers are implemented separately
 * via HttpApiBuilder.group().
 */
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import {
  CreateAssetInput,
  CreateUploadUrlInput,
  ImportAssetFromUrlInput,
  UpdateAssetMetadataInput,
} from "../../services/input-schemas.js";

export const assetsGroup = HttpApiGroup.make("assets")
  .annotate(OpenApi.Title, "Assets")
  .annotate(OpenApi.Description, "Asset management")
  .add(
    HttpApiEndpoint.get("listAssets", "/assets", {
      query: Schema.Struct({
        q: Schema.optional(Schema.String),
        limit: Schema.optional(Schema.String),
        offset: Schema.optional(Schema.String),
        orderBy: Schema.optional(Schema.String),
      }),
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "List or search assets"),
  )
  .add(
    HttpApiEndpoint.get("getAssetUsages", "/assets/:id/usages", {
      params: Schema.Struct({ id: Schema.String }),
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "List records referencing an asset"),
  )
  .add(
    HttpApiEndpoint.post("createAsset", "/assets", {
      payload: CreateAssetInput,
      success: HttpApiSchema.status(201)(Schema.Unknown),
    })
      .annotate(OpenApi.Summary, "Create a new asset"),
  )
  .add(
    HttpApiEndpoint.post("importAssetFromUrl", "/assets/import-from-url", {
      payload: ImportAssetFromUrlInput,
      success: HttpApiSchema.status(201)(Schema.Unknown),
    })
      .annotate(OpenApi.Summary, "Import a remote asset into R2 and register it"),
  )
  .add(
    HttpApiEndpoint.get("getAsset", "/assets/:id", {
      params: Schema.Struct({ id: Schema.String }),
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Get an asset by ID"),
  )
  .add(
    HttpApiEndpoint.put("replaceAsset", "/assets/:id", {
      params: Schema.Struct({ id: Schema.String }),
      payload: CreateAssetInput,
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Replace an asset"),
  )
  .add(
    HttpApiEndpoint.patch("updateAssetMetadata", "/assets/:id", {
      params: Schema.Struct({ id: Schema.String }),
      payload: UpdateAssetMetadataInput,
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Update asset metadata"),
  )
  .add(
    HttpApiEndpoint.make("DELETE")("deleteAsset", "/assets/:id", {
      params: Schema.Struct({ id: Schema.String }),
      query: Schema.Struct({ force: Schema.optional(Schema.String) }),
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Delete an asset (409 if referenced unless force=true)"),
  )
  .add(
    HttpApiEndpoint.post("createUploadUrl", "/assets/upload-url", {
      payload: CreateUploadUrlInput,
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Create a presigned upload URL"),
  );
