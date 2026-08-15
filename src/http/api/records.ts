/**
 * HttpApiGroup for record endpoints.
 *
 * Defines the declarative API shape — handlers are implemented separately
 * via HttpApiBuilder.group().
 */
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import {
  BulkCreateRecordsInput,
  BulkRecordOperationInput,
  QueryRecordsInput,
  ValidateRecordInput,
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
    HttpApiEndpoint.post("bulkCreateRecords", "/records/bulk", {
      payload: BulkCreateRecordsInput,
      success: HttpApiSchema.status(201)(Schema.Unknown),
    })
      .annotate(OpenApi.Summary, "Bulk create records"),
  )
  // POST /records — create a record
  .add(
    HttpApiEndpoint.post("createRecord", "/records", {
      payload: CreateRecordInput,
      success: HttpApiSchema.status(201)(Schema.Unknown),
    })
      .annotate(OpenApi.Summary, "Create a record"),
  )
  // GET /records — list records
  .add(
    HttpApiEndpoint.get("listRecords", "/records", {
      query: ModelApiKeyParams,
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "List records for a model"),
  )
  // POST /records/query — filtered/paginated/sorted list with total
  .add(
    HttpApiEndpoint.post("queryRecords", "/records/query", {
      payload: QueryRecordsInput,
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Query records (filter, orderBy, pagination, status)"),
  )
  // GET /records/picker-search — model-scoped presentation-row search
  .add(
    HttpApiEndpoint.get("pickerSearchRecords", "/records/picker-search", {
      query: Schema.Struct({
        modelApiKey: Schema.String,
        q: Schema.optional(Schema.String),
        limit: Schema.optional(Schema.String),
        offset: Schema.optional(Schema.String),
      }),
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Model-scoped picker search"),
  )
  // POST /records/validate — create-shaped validation dry-run (204 / 400)
  .add(
    HttpApiEndpoint.post("validateRecord", "/records/validate", {
      payload: ValidateRecordInput,
      success: HttpApiSchema.status(204)(Schema.Void),
    })
      .annotate(OpenApi.Summary, "Validate a would-be record (dry-run, no persistence)"),
  )
  // POST /records/:id/validate — patch-shaped validation dry-run (204 / 400 / 404)
  .add(
    HttpApiEndpoint.post("validateRecordUpdate", "/records/:id/validate", {
      params: IdPath,
      payload: ValidateRecordInput,
      success: HttpApiSchema.status(204)(Schema.Void),
    })
      .annotate(OpenApi.Summary, "Validate a partial update (dry-run, no persistence)"),
  )
  // GET /records/:id/sync-state — sidebar status cluster
  .add(
    HttpApiEndpoint.get("recordSyncState", "/records/:id/sync-state", {
      params: IdPath,
      query: ModelApiKeyParams,
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Record sync state (publish/schedule + changed fields)"),
  )
  // POST /records/bulk-publish — publish many (per-id results)
  .add(
    HttpApiEndpoint.post("bulkPublishRecords", "/records/bulk-publish", {
      payload: BulkRecordOperationInput,
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Bulk publish records"),
  )
  // POST /records/bulk-unpublish — unpublish many (per-id results)
  .add(
    HttpApiEndpoint.post("bulkUnpublishRecords", "/records/bulk-unpublish", {
      payload: BulkRecordOperationInput,
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Bulk unpublish records"),
  )
  // POST /records/bulk-delete — delete many (per-id results)
  .add(
    HttpApiEndpoint.post("bulkDeleteRecords", "/records/bulk-delete", {
      payload: BulkRecordOperationInput,
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Bulk delete records"),
  )
  // GET /records/:id/links — inbound references (backlinks)
  .add(
    HttpApiEndpoint.get("recordBacklinks", "/records/:id/links", {
      params: IdPath,
      query: ModelApiKeyParams,
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Inbound references to a record"),
  )
  // POST /records/:id/duplicate — deep-copy a record
  .add(
    HttpApiEndpoint.post("duplicateRecord", "/records/:id/duplicate", {
      params: IdPath,
      payload: Schema.Struct({ modelApiKey: Schema.NonEmptyString }),
      success: HttpApiSchema.status(201)(Schema.Unknown),
    })
      .annotate(OpenApi.Summary, "Duplicate a record"),
  )
  // GET /records/:id/versions — list versions
  .add(
    HttpApiEndpoint.get("listVersions", "/records/:id/versions", {
      params: IdPath,
      query: ModelApiKeyParams,
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "List versions for a record"),
  )
  // GET /records/:id/versions/:versionId — get version
  .add(
    HttpApiEndpoint.get("getVersion", "/records/:id/versions/:versionId", {
      params: IdVersionPath,
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Get a specific version"),
  )
  // POST /records/:id/versions/:versionId/restore — restore version
  .add(
    HttpApiEndpoint.post("restoreVersion", "/records/:id/versions/:versionId/restore", {
      params: IdVersionPath,
      query: ModelApiKeyParams,
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Restore a record to a previous version"),
  )
  // GET /records/:id — get a record
  .add(
    HttpApiEndpoint.get("getRecord", "/records/:id", {
      params: IdPath,
      query: ModelApiKeyParams,
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Get a record by ID"),
  )
  // PATCH /records/:id — update a record
  .add(
    HttpApiEndpoint.patch("updateRecord", "/records/:id", {
      params: IdPath,
      payload: PatchRecordInput,
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Update a record"),
  )
  // PATCH /records/:id/blocks — patch blocks
  .add(
    HttpApiEndpoint.patch("patchBlocks", "/records/:id/blocks", {
      params: IdPath,
      payload: PatchBlocksInput,
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Patch structured text blocks on a record"),
  )
  // DELETE /records/:id — delete a record
  .add(
    HttpApiEndpoint.make("DELETE")("deleteRecord", "/records/:id", {
      params: IdPath,
      query: ModelApiKeyParams,
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Delete a record"),
  )
  // POST /records/:id/publish — publish
  .add(
    HttpApiEndpoint.post("publishRecord", "/records/:id/publish", {
      params: IdPath,
      query: ModelApiKeyParams,
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Publish a record"),
  )
  // POST /records/:id/unpublish — unpublish
  .add(
    HttpApiEndpoint.post("unpublishRecord", "/records/:id/unpublish", {
      params: IdPath,
      query: ModelApiKeyParams,
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Unpublish a record"),
  )
  // POST /records/:id/schedule-publish — schedule publish
  .add(
    HttpApiEndpoint.post("schedulePublish", "/records/:id/schedule-publish", {
      params: IdPath,
      payload: ScheduleRecordInput,
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Schedule a record for publishing"),
  )
  // POST /records/:id/schedule-unpublish — schedule unpublish
  .add(
    HttpApiEndpoint.post("scheduleUnpublish", "/records/:id/schedule-unpublish", {
      params: IdPath,
      payload: ScheduleRecordInput,
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Schedule a record for unpublishing"),
  )
  // POST /records/:id/clear-schedule — clear schedule
  .add(
    HttpApiEndpoint.post("clearSchedule", "/records/:id/clear-schedule", {
      params: IdPath,
      payload: Schema.Struct({ modelApiKey: Schema.NonEmptyString }),
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Clear scheduled publish/unpublish"),
  )
  // POST /reorder — reorder records
  .add(
    HttpApiEndpoint.post("reorderRecords", "/reorder", {
      payload: ReorderInput,
      success: Schema.Unknown,
    })
      .annotate(OpenApi.Summary, "Reorder records within a model"),
  );
