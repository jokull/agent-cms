/**
 * HttpApiGroup for asset endpoints.
 *
 * Defines the declarative API shape — handlers are implemented separately
 * via HttpApiBuilder.group().
 */
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "@effect/platform";
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
    HttpApiEndpoint.get("listAssets", "/assets")
      .annotate(OpenApi.Summary, "List or search assets")
      .setUrlParams(
        Schema.Struct({
          q: Schema.optional(Schema.String),
          limit: Schema.optional(Schema.String),
          offset: Schema.optional(Schema.String),
        }),
      )
      .addSuccess(Schema.Unknown),
  )
  .add(
    HttpApiEndpoint.post("createAsset", "/assets")
      .annotate(OpenApi.Summary, "Create a new asset")
      .setPayload(CreateAssetInput)
      .addSuccess(Schema.Unknown, { status: 201 }),
  )
  .add(
    HttpApiEndpoint.post("importAssetFromUrl", "/assets/import-from-url")
      .annotate(OpenApi.Summary, "Import a remote asset into R2 and register it")
      .setPayload(ImportAssetFromUrlInput)
      .addSuccess(Schema.Unknown, { status: 201 }),
  )
  .add(
    HttpApiEndpoint.get("getAsset", "/assets/:id")
      .annotate(OpenApi.Summary, "Get an asset by ID")
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(Schema.Unknown),
  )
  .add(
    HttpApiEndpoint.put("replaceAsset", "/assets/:id")
      .annotate(OpenApi.Summary, "Replace an asset")
      .setPath(Schema.Struct({ id: Schema.String }))
      .setPayload(CreateAssetInput)
      .addSuccess(Schema.Unknown),
  )
  .add(
    HttpApiEndpoint.patch("updateAssetMetadata", "/assets/:id")
      .annotate(OpenApi.Summary, "Update asset metadata")
      .setPath(Schema.Struct({ id: Schema.String }))
      .setPayload(UpdateAssetMetadataInput)
      .addSuccess(Schema.Unknown),
  )
  .add(
    HttpApiEndpoint.del("deleteAsset", "/assets/:id")
      .annotate(OpenApi.Summary, "Delete an asset")
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(Schema.Unknown),
  )
  .add(
    HttpApiEndpoint.post("createUploadUrl", "/assets/upload-url")
      .annotate(OpenApi.Summary, "Create a presigned upload URL")
      .setPayload(CreateUploadUrlInput)
      .addSuccess(Schema.Unknown),
  );
