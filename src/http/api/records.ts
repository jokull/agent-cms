/**
 * HttpApiGroup for record endpoints.
 *
 * Defines the declarative API shape — handlers are implemented separately
 * via HttpApiBuilder.group().
 */
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "@effect/platform";
import { Schema } from "effect";
import {
  BulkCreateRecordsInput,
  CreateRecordInput,
  PatchRecordInput,
  PatchBlocksInput,
  ScheduleRecordInput,
  ReorderInput,
} from "../../services/input-schemas.js";

const ModelApiKeyParams = Schema.Struct({
  modelApiKey: Schema.String,
});

const IdPath = Schema.Struct({ id: Schema.String });

const IdVersionPath = Schema.Struct({
  id: Schema.String,
  versionId: Schema.String,
});

export const recordsGroup = HttpApiGroup.make("records")
  .annotate(OpenApi.Title, "Records")
  .annotate(OpenApi.Description, "Content record management")
  // POST /records/bulk — bulk create records
  .add(
    HttpApiEndpoint.post("bulkCreateRecords", "/records/bulk")
      .annotate(OpenApi.Summary, "Bulk create records")
      .setPayload(BulkCreateRecordsInput)
      .addSuccess(Schema.Unknown, { status: 201 }),
  )
  // POST /records — create a record
  .add(
    HttpApiEndpoint.post("createRecord", "/records")
      .annotate(OpenApi.Summary, "Create a record")
      .setPayload(CreateRecordInput)
      .addSuccess(Schema.Unknown, { status: 201 }),
  )
  // GET /records — list records
  .add(
    HttpApiEndpoint.get("listRecords", "/records")
      .annotate(OpenApi.Summary, "List records for a model")
      .setUrlParams(ModelApiKeyParams)
      .addSuccess(Schema.Unknown),
  )
  // GET /records/:id/versions — list versions
  .add(
    HttpApiEndpoint.get("listVersions", "/records/:id/versions")
      .annotate(OpenApi.Summary, "List versions for a record")
      .setPath(IdPath)
      .setUrlParams(ModelApiKeyParams)
      .addSuccess(Schema.Unknown),
  )
  // GET /records/:id/versions/:versionId — get version
  .add(
    HttpApiEndpoint.get("getVersion", "/records/:id/versions/:versionId")
      .annotate(OpenApi.Summary, "Get a specific version")
      .setPath(IdVersionPath)
      .addSuccess(Schema.Unknown),
  )
  // POST /records/:id/versions/:versionId/restore — restore version
  .add(
    HttpApiEndpoint.post("restoreVersion", "/records/:id/versions/:versionId/restore")
      .annotate(OpenApi.Summary, "Restore a record to a previous version")
      .setPath(IdVersionPath)
      .setUrlParams(ModelApiKeyParams)
      .addSuccess(Schema.Unknown),
  )
  // GET /records/:id — get a record
  .add(
    HttpApiEndpoint.get("getRecord", "/records/:id")
      .annotate(OpenApi.Summary, "Get a record by ID")
      .setPath(IdPath)
      .setUrlParams(ModelApiKeyParams)
      .addSuccess(Schema.Unknown),
  )
  // PATCH /records/:id — update a record
  .add(
    HttpApiEndpoint.patch("updateRecord", "/records/:id")
      .annotate(OpenApi.Summary, "Update a record")
      .setPath(IdPath)
      .setPayload(PatchRecordInput)
      .addSuccess(Schema.Unknown),
  )
  // PATCH /records/:id/blocks — patch blocks
  .add(
    HttpApiEndpoint.patch("patchBlocks", "/records/:id/blocks")
      .annotate(OpenApi.Summary, "Patch structured text blocks on a record")
      .setPath(IdPath)
      .setPayload(PatchBlocksInput)
      .addSuccess(Schema.Unknown),
  )
  // DELETE /records/:id — delete a record
  .add(
    HttpApiEndpoint.del("deleteRecord", "/records/:id")
      .annotate(OpenApi.Summary, "Delete a record")
      .setPath(IdPath)
      .setUrlParams(ModelApiKeyParams)
      .addSuccess(Schema.Unknown),
  )
  // POST /records/:id/publish — publish
  .add(
    HttpApiEndpoint.post("publishRecord", "/records/:id/publish")
      .annotate(OpenApi.Summary, "Publish a record")
      .setPath(IdPath)
      .setUrlParams(ModelApiKeyParams)
      .addSuccess(Schema.Unknown),
  )
  // POST /records/:id/unpublish — unpublish
  .add(
    HttpApiEndpoint.post("unpublishRecord", "/records/:id/unpublish")
      .annotate(OpenApi.Summary, "Unpublish a record")
      .setPath(IdPath)
      .setUrlParams(ModelApiKeyParams)
      .addSuccess(Schema.Unknown),
  )
  // POST /records/:id/schedule-publish — schedule publish
  .add(
    HttpApiEndpoint.post("schedulePublish", "/records/:id/schedule-publish")
      .annotate(OpenApi.Summary, "Schedule a record for publishing")
      .setPath(IdPath)
      .setPayload(ScheduleRecordInput)
      .addSuccess(Schema.Unknown),
  )
  // POST /records/:id/schedule-unpublish — schedule unpublish
  .add(
    HttpApiEndpoint.post("scheduleUnpublish", "/records/:id/schedule-unpublish")
      .annotate(OpenApi.Summary, "Schedule a record for unpublishing")
      .setPath(IdPath)
      .setPayload(ScheduleRecordInput)
      .addSuccess(Schema.Unknown),
  )
  // POST /records/:id/clear-schedule — clear schedule
  .add(
    HttpApiEndpoint.post("clearSchedule", "/records/:id/clear-schedule")
      .annotate(OpenApi.Summary, "Clear scheduled publish/unpublish")
      .setPath(IdPath)
      .setPayload(Schema.Struct({ modelApiKey: Schema.NonEmptyString }))
      .addSuccess(Schema.Unknown),
  )
  // POST /reorder — reorder records
  .add(
    HttpApiEndpoint.post("reorderRecords", "/reorder")
      .annotate(OpenApi.Summary, "Reorder records within a model")
      .setPayload(ReorderInput)
      .addSuccess(Schema.Unknown),
  );
