/**
 * Effect-native MCP (Model Context Protocol) server for agent-cms.
 * 3-layer architecture: Discovery -> Schema -> Content
 */
import * as McpServer from "effect/unstable/ai/McpServer";
import * as McpSchema from "effect/unstable/ai/McpSchema";
import * as McpProtocol from "effect/unstable/ai/McpProtocol";
import * as AiTool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import { Context, Effect, Layer, Option, Schema, SchemaIssue, Stream } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import * as ModelService from "../services/model-service.js";
import * as FieldService from "../services/field-service.js";
import * as RecordService from "../services/record-service.js";
import * as PublishService from "../services/publish-service.js";
import * as ScheduleService from "../services/schedule-service.js";
import * as AssetService from "../services/asset-service.js";
import { AssetImportContext, type R2UploadCredentials } from "../services/asset-service.js";
import * as VersionService from "../services/version-service.js";
import * as SchemaLifecycle from "../services/schema-lifecycle.js";
import * as SchemaIO from "../services/schema-io.js";
import * as SearchService from "../search/search-service.js";
import * as SiteSettingsService from "../services/site-settings-service.js";
import * as TokenService from "../services/token-service.js";
import * as PreviewService from "../services/preview-service.js";
import {
  CreateAssetInput as AssetInput,
  CreateUploadUrlInput,
  CreateFieldInput,
  CreateModelInput,
  CreateRecordInput,
  ImportAssetFromUrlInput,
  ImportSchemaInput,
  PatchBlocksInput,
  ReindexSearchInput,
  ReorderInput,
  SearchInput as SearchContentInput,
} from "../services/input-schemas.js";
import type { ModelRow, FieldRow, LocaleRow } from "../db/row-types.js";
import { VectorizeContext } from "../search/vectorize-context.js";
import { HooksContext } from "../hooks.js";
import { decodeJsonRecordStringOr, encodeJson } from "../json.js";
import { isObjectRecord } from "../value-utils.js";
import { likeContains } from "../sql-util.js";

import { actorFromHeaders, type RequestActor } from "../attribution.js";

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);
const CommonDependencies = [SqlClient.SqlClient, VectorizeContext, HooksContext, AssetImportContext];

const UpdateModelInput = Schema.Struct({
  modelId: Schema.String,
  name: Schema.optional(Schema.String),
  apiKey: Schema.optional(Schema.String),
  singleton: Schema.optional(Schema.Boolean),
  sortable: Schema.optional(Schema.Boolean),
  hasDraft: Schema.optional(Schema.Boolean),
  allLocalesRequired: Schema.optional(Schema.Boolean),
  canonicalPathTemplate: Schema.optional(Schema.NullOr(Schema.String)),
});

const UpdateFieldInput = Schema.Struct({
  fieldId: Schema.String,
  label: Schema.optional(Schema.String),
  apiKey: Schema.optional(Schema.String),
  validators: Schema.optional(JsonRecord),
  hint: Schema.optional(Schema.String),
});

const ModelIdInput = Schema.Struct({ modelId: Schema.String });
const FieldIdInput = Schema.Struct({ fieldId: Schema.String });
const LocaleIdInput = Schema.Struct({ localeId: Schema.String });

const SchemaInfoInput = Schema.Struct({
  filterByName: Schema.optional(Schema.String),
  filterByType: Schema.optional(Schema.Literals(["model", "block"])),
  includeFieldDetails: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.succeed(true))),
});

const UpdateRecordInput = Schema.Struct({
  recordId: Schema.optional(Schema.String),
  modelApiKey: Schema.String,
  data: JsonRecord.pipe(Schema.withDecodingDefaultType(Effect.sync(() => ({})))),
});


const DeleteRecordInput = Schema.Struct({
  modelApiKey: Schema.String,
  recordIds: Schema.Array(Schema.String).pipe(
    Schema.check(Schema.makeFilter((value) => value.length >= 1, { message: "recordIds must contain at least 1 entry" })),
    Schema.check(Schema.makeFilter((value) => value.length <= 1000, { message: "recordIds must contain at most 1000 entries" })),
  ),
});

const QueryRecordsInput = Schema.Struct({
  modelApiKey: Schema.String,
});

const BulkCreateRecordsInput = Schema.Struct({
  modelApiKey: Schema.String,
  records: Schema.Array(JsonRecord),
});

const PublishRecordsInput = Schema.Struct({
  modelApiKey: Schema.String,
  recordIds: Schema.Array(Schema.String).pipe(
    Schema.check(Schema.makeFilter((value) => value.length >= 1, { message: "recordIds must contain at least 1 entry" })),
    Schema.check(Schema.makeFilter((value) => value.length <= 1000, { message: "recordIds must contain at most 1000 entries" })),
  ),
});

const SetPublishStatusInput = Schema.Struct({
  action: Schema.Literals(["publish", "unpublish"]),
  ...PublishRecordsInput.fields,
});

const ScheduleInput = Schema.Struct({
  recordId: Schema.String,
  modelApiKey: Schema.String,
  action: Schema.Literals(["publish", "unpublish", "clear"]),
  at: Schema.optional(Schema.NullOr(Schema.String)),
});

const RecordVersionsInput = Schema.Struct({
  action: Schema.Literals(["list", "get", "restore"]),
  modelApiKey: Schema.String,
  recordId: Schema.String,
  versionId: Schema.optional(Schema.String),
});

const RemoveBlockInput = Schema.Struct({
  blockApiKey: Schema.String,
  fieldId: Schema.optional(Schema.String),
});

const ReplaceAssetInput = Schema.Struct({
  assetId: Schema.String,
  ...AssetInput.fields,
});

const SchemaIOInput = Schema.Struct({
  action: Schema.Literals(["export", "import"]),
  schema: Schema.optional(ImportSchemaInput),
});

const UpdateSiteSettingsInput = Schema.Struct({
  siteName: Schema.optional(Schema.String),
  titleSuffix: Schema.optional(Schema.String),
  noIndex: Schema.optional(Schema.Boolean),
  faviconId: Schema.optional(Schema.String),
  facebookPageUrl: Schema.optional(Schema.String),
  twitterAccount: Schema.optional(Schema.String),
  fallbackSeoTitle: Schema.optional(Schema.String),
  fallbackSeoDescription: Schema.optional(Schema.String),
  fallbackSeoImageId: Schema.optional(Schema.String),
  fallbackSeoTwitterCard: Schema.optional(Schema.String),
});

const EditorTokensInput = Schema.Struct({
  action: Schema.Literals(["create", "list", "revoke"]),
  name: Schema.optional(Schema.String),
  expiresIn: Schema.optional(Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThan(0)),
  )),
  tokenId: Schema.optional(Schema.String),
});

const GetRecordInput = Schema.Struct({
  recordId: Schema.String,
  modelApiKey: Schema.String,
});

const GetPreviewUrlInput = Schema.Struct({
  recordId: Schema.String,
  modelApiKey: Schema.String,
});

const SetupContentModelPromptInput = Schema.Struct({
  description: Schema.String,
});

const GenerateGraphqlQueriesPromptInput = Schema.Struct({
  modelApiKey: Schema.String,
});

function cmsTool<Name extends string>(
  name: Name,
  description: string,
  parameters?: Schema.Struct.Fields,
) {
  let tool = AiTool.make(name, {
    description,
    parameters: parameters ? Schema.Struct(parameters) : AiTool.EmptyParams,
    success: Schema.Unknown,
    failure: Schema.Unknown,
    dependencies: CommonDependencies,
  });
  const isReadonly = name.startsWith("query_")
    || name.startsWith("get_")
    || name === "schema_info"
    || name === "search_content";
  tool = tool.annotate(AiTool.Readonly, isReadonly);
  tool = tool.annotate(AiTool.Idempotent, isReadonly || name.startsWith("update_") || name.startsWith("replace_"));
  tool = tool.annotate(AiTool.Destructive, name.startsWith("delete_") || name === "remove_block");
  tool = tool.annotate(AiTool.OpenWorld, name === "search_content");
  return tool;
}

function toStructuredContent(value: unknown) {
  // The MCP CallToolResult `structuredContent` field is a Json codec; class
  // instances (e.g. Data.TaggedError) fail its validation, so normalize to a
  // plain JSON value before constructing the result.
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    try {
      return JSON.parse(encodeJson(value));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Turn a raw Effect Schema {@link ParseResult.ParseError} (produced when tool
 * arguments fail to decode) into a friendly ValidationError with a readable,
 * human-oriented message instead of dumping the internal ParseError tree to the
 * MCP client. Non-ParseError failures pass through unchanged.
 */
function formatToolError(error: unknown): unknown {
  if (Schema.isSchemaError(error)) {
    return {
      _tag: "ValidationError",
      message: SchemaIssue.makeFormatterDefault()(error.issue),
    };
  }
  return error;
}

function isToolPayload(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && typeof value === "object";
}

/**
 * Recursively collect "unexpected property" errors for a payload against a tool's
 * JSON Schema, enforcing the `additionalProperties: false` we advertise. The
 * @effect/ai Toolkit DECODES (and silently strips) excess keys before the tool
 * handler runs, so a caller sending `fields` instead of `data` used to succeed
 * with an empty record. We check the RAW payload here, before dispatch, so a
 * wrong key becomes one clear ValidationError. Only closed objects are checked;
 * open records (record `data`, `validators`) accept any keys.
 */
function collectExcessProperties(schema: unknown, value: unknown, path = ""): string[] {
  if (!isObjectRecord(schema) || !isObjectRecord(value)) return [];
  const props = isObjectRecord(schema.properties) ? schema.properties : {};
  const errors: string[] = [];
  if (schema.additionalProperties === false) {
    const known = Object.keys(props);
    for (const key of Object.keys(value)) {
      if (!(key in props)) {
        const where = path ? `${path}.${key}` : key;
        const hint = known.length > 0 ? ` (accepted: ${known.join(", ")})` : "";
        errors.push(`unexpected property \`${where}\`${hint}`);
      }
    }
  }
  for (const [key, sub] of Object.entries(props)) {
    if (key in value) {
      errors.push(...collectExcessProperties(sub, value[key], path ? `${path}.${key}` : key));
    }
  }
  return errors;
}

function compactPatchBlocksResponse(
  fullRecord: Record<string, unknown>,
  fieldApiKey: string,
  deletedBlockIds: string[],
): Record<string, unknown> {
  const fieldValue = fullRecord[fieldApiKey];

  const envelope: Record<string, unknown> | null = (() => {
    if (fieldValue === null || fieldValue === undefined) return null;
    if (typeof fieldValue === "string") {
      const parsed = decodeJsonRecordStringOr(fieldValue, {});
      return Object.keys(parsed).length > 0 ? parsed : null;
    }
    return isObjectRecord(fieldValue) ? fieldValue : null;
  })();

  if (!envelope) {
    return {
      recordId: fullRecord.id,
      status: fullRecord._status ?? null,
      fieldApiKey,
      field: null,
      blocks: {},
      deleted: deletedBlockIds,
      blockOrder: [],
    };
  }

  const blocks = isObjectRecord(envelope.blocks) ? envelope.blocks : {};

  // Extract block order from DAST traversal
  const blockOrder: string[] = [];
  function walkDast(node: unknown) {
    if (!isObjectRecord(node)) return;
    const n = node;
    if (n.type === "block" && typeof n.item === "string") blockOrder.push(n.item);
    if (Array.isArray(n.children)) n.children.forEach(walkDast);
  }
  const value = envelope.value;
  if (isObjectRecord(value)) {
    walkDast(value.document);
  }
  const recordId = typeof fullRecord.id === "string" ? fullRecord.id : "";

  return {
    recordId,
    status: fullRecord._status ?? null,
    fieldApiKey,
    field: envelope,
    blocks,
    deleted: deletedBlockIds,
    blockOrder,
  };
}

function parseValidators(value: unknown): Record<string, unknown> {
  if (value == null || value === "") return {};
  if (typeof value === "string") return decodeJsonRecordStringOr(value, {});
  return isObjectRecord(value) ? value : {};
}

function withDecoded<S extends Schema.Constraint, E, R2>(
  schema: S,
  handler: (params: S["Type"]) => Effect.Effect<unknown, E, R2>,
) {
  return (params: unknown) => Schema.decodeUnknownEffect(schema)(params).pipe(Effect.flatMap(handler));
}

function toMcpInputSchema(tool: AiTool.Any): Record<string, unknown> {
  // Effect AI's helper is typed against the concrete Tool model, while AiTool.Any is wider.
  // Runtime behavior is correct here because every entry in CmsToolkit is created via AiTool.make.
  const inputSchema = AiTool.getJsonSchema(tool);
  return isObjectRecord(inputSchema)
    && "type" in inputSchema
    && inputSchema.type === "object"
    ? inputSchema
    : { type: "object", properties: {}, additionalProperties: false };
}

type LooseToolHandler = (params: unknown) => Effect.Effect<unknown, unknown, unknown>;

function pickToolkitHandlers<K extends Record<string, AiTool.Any>>(
  toolkit: { readonly tools: K },
  handlers: Record<string, LooseToolHandler>,
): Record<keyof K, LooseToolHandler> {
  const filtered: Record<string, LooseToolHandler> = {};
  for (const name of Object.keys(toolkit.tools)) {
    filtered[name] = handlers[name];
  }
  // Object.keys is dynamic; the selected names are exactly the toolkit's tool
  // names, so the narrowed key set is sound.
  return filtered as Record<keyof K, LooseToolHandler>;
}

// --- Tool definitions ---

const SchemaInfoTool = cmsTool("schema_info", "Get the complete CMS schema in one call — models, block types, fields, relations. The primary tool for understanding the content model. Use filterByName to find a specific model.", SchemaInfoInput.fields);
const CreateModelTool = cmsTool("create_model", "Create a content model or block type. Use isBlock:true for block types (embeddable in StructuredText). Use singleton:true for models with exactly one record (e.g. site settings). After creating a model, add fields with create_field.", CreateModelInput.fields);
const UpdateModelTool = cmsTool("update_model", "Update model properties (name, apiKey, singleton, sortable, hasDraft, allLocalesRequired, ordering). Set ordering to a default sort like 'title_ASC', '_createdAt_DESC', '_position_ASC', or null to clear.", UpdateModelInput.fields);
const CreateFieldTool = cmsTool("create_field", `Add a field to a model. Auto-migrates the database table (adds column).

Key validators by field type:
- slug: {"slug_source": "title"} — auto-generates from source field
- string/text/slug: {"enum": ["draft","review","published"]} — restrict allowed values
- string/text/slug: {"length": {"min": 10, "max": 160}} — character count limits
- integer/float: {"number_range": {"min": 1, "max": 5}} — numeric bounds
- string/text/slug: {"format": "email"} or {"format": "url"} or {"format": {"custom_pattern": "^[A-Z]{2}\\\\d{4}$"}} — string format checks
- date/date_time: {"date_range": {"min": "now"}} — temporal bounds
- link: {"item_item_type": ["model_api_key"]} — target model
- links: {"items_item_type": ["model_api_key"]} — target model
- structured_text: {"structured_text_blocks": ["block_api_key"]} — allowed block types
- rich_text: {"rich_text_blocks": ["block_api_key"]} — modular content (ordered array of blocks, no prose)
- any field: {"required": true} — field is required (provide default_value for existing records)`, {
  modelId: Schema.String,
  ...CreateFieldInput.fields,
});
const UpdateFieldTool = cmsTool("update_field", "Update field properties (label, apiKey, validators, hint)", UpdateFieldInput.fields);
const DeleteModelTool = cmsTool("delete_model", "Delete a model (fails if referenced)", ModelIdInput.fields);
const DeleteFieldTool = cmsTool("delete_field", "Delete a field and drop column", FieldIdInput.fields);
const CreateRecordTool = cmsTool("create_record", `Create a content record. Records on draft-enabled models start as draft — call set_publish_status to make them visible in GraphQL.

Validation note:
- For models with drafts (has_draft=true), required-field validation is deferred until set_publish_status.
- For models without drafts (has_draft=false), required fields are enforced during create_record.

Field value formats:
- media: asset ID string, or {"upload_id":"<asset_id>","alt":"...","title":"...","focal_point":{"x":0.5,"y":0.2},"custom_data":{...}}
- media_gallery: array of asset IDs and/or media override objects
- link: record ID string
- links: array of record ID strings
- seo: {"title":"...","description":"...","image":"<asset_id>","twitterCard":"summary_large_image"}
- structured_text: {text:"...",blocks:[...]} (canonical), Agent Text string, {agentText:"...",blocks:[...]}, or internal DAST envelope {"value":{"schema":"dast","document":{...}},"blocks":{...}}
  Prefer {text, blocks} for agent-authored prose. It is Markdown plus opaque CMS handles:
  - Block refs: [[block:BLOCK_ID]] on their own line
  - Inline items: [[inline_item:RECORD_ID]]
  - Inline blocks: [[inline_block:BLOCK_ID]]
  - Record links: [[record:RECORD_ID|link text]]
  When using {text, blocks}, the blocks array/map provides block data and the handles place references in the document.
  Do not use DAST JSON, angle-bracket reference tags, Markdown-link record schemes, or HTML comments in agent-authored structured_text.
  Those block field values are persisted by the same create_record/update_record call — you do not need a follow-up patch_blocks call just to save the initial block payload.
- rich_text: array of block objects [{block_type:"hero_section",headline:"Welcome"},{block_type:"cta_block",label:"Sign Up"}]
  Each object must have a block_type key matching an allowed block model api_key.
  Unlike structured_text, rich_text is blocks-only (no prose, no DAST). Use for page-builder / modular content.
- color: {"red":255,"green":0,"blue":0,"alpha":255}
- lat_lon: {"latitude":64.13,"longitude":-21.89}`, CreateRecordInput.fields);
const UpdateRecordTool = cmsTool("update_record", `Update record fields. For singletons, recordId can be omitted — the single record is found automatically.

Accepts all the same field value formats as create_record, including canonical {text,blocks} mode for structured_text. For editorial content edits, prefer Agent Text handles over hand-assembled DAST.`, UpdateRecordInput.fields);
const PatchBlocksTool = cmsTool("patch_blocks", `Partially update blocks in a structured text field without resending the entire content tree.

You can target block IDs from either:
- the field's top-level \`blocks\` map, or
- nested structured_text sub-fields stored inside those blocks

Patch map semantics for each block ID:
- object with field overrides → merge into existing block (only specified fields updated)
- null → delete block and auto-prune from the relevant DAST tree

Block IDs not in the patch map are kept unchanged. Omit a block ID to leave it as-is.

If a nested block ID appears in multiple nested structured_text locations, the tool will fail and ask you to patch the parent block explicitly.

Optionally provide a new top-level DAST \`value\`. If omitted, the existing DAST is preserved (with deleted top-level blocks auto-pruned).

Use \`append\` to insert new blocks without reconstructing the DAST. Each entry is a record with \`_type\` and field values. New block IDs are auto-generated, DAST block nodes are appended to the end, and the response includes \`_appendedIds\`. Cannot be combined with \`value\`.

For blocks_only structured_text fields, you can pass an \`order\` array of block IDs to reorder blocks without constructing a full DAST document. The order array replaces the DAST children list. Cannot be combined with \`value\`. All block IDs in \`order\` must exist in the merged blocks map, and all merged blocks must appear in \`order\`.

Example — update one block's description, delete another, keep the rest:
{ blocks: { "block-2": { "description": "New text" }, "block-3": null } }

Example — append a new block while patching an existing one:
{ blocks: { "block-2": { "description": "Updated" } }, append: [{ "_type": "venue", "name": "New Place" }] }

Example — reorder blocks on a blocks_only field:
{ order: ["block-3", "block-1", "block-2"], blocks: {} }`, PatchBlocksInput.fields);
const DeleteRecordTool = cmsTool("delete_record", "Delete one or more records. Pass recordIds as an array, even for a single record (mirrors set_publish_status).", DeleteRecordInput.fields);
const GetRecordTool = cmsTool("get_record", "Get a single record by modelApiKey + recordId. Useful after search_content when you need the full materialized record, including structured_text fields, before patch_blocks or update_record. This is a workspace/content-management read tool, not a substitute for final live verification via GraphQL or the site URL.", GetRecordInput.fields);
const QueryRecordsTool = cmsTool("query_records", "List records for a model. Structured_text fields are materialized for inspection, including nested blocks inside parent block fields. Useful for finding record IDs before update_record, patch_blocks, set_publish_status, or record_versions. Use GraphQL or the site URL for final public/live verification after publishing.", QueryRecordsInput.fields);
const BulkCreateRecordsTool = cmsTool("bulk_create_records", `Create multiple records in one operation (up to 1000). Much faster than calling create_record in a loop.

All records must belong to the same model. Slugs are auto-generated. Returns {created, records}, where records is an array of objects like {id}.`, BulkCreateRecordsInput.fields);
const SetPublishStatusTool = cmsTool("set_publish_status", "Publish or unpublish one or more records. Pass recordIds as an array, even for a single record. Required-field validation is enforced at publish time for draft-enabled models.", SetPublishStatusInput.fields);
const ScheduleTool = cmsTool("schedule", `Schedule a record to publish or unpublish at a future ISO datetime, or clear both schedules.

action: "publish" | "unpublish" | "clear"
- publish/unpublish: provide at (ISO datetime string)
- clear: at is ignored`, ScheduleInput.fields);
const RecordVersionsTool = cmsTool("record_versions", `Manage record versions: list all versions, get a snapshot, or restore a previous version.

action: "list" | "get" | "restore"
- list: returns all version snapshots for a record, newest first
- get: returns a specific version snapshot (provide versionId)
- restore: restores a previous version (provide versionId). Current state is versioned first, so restore is always reversible.`, RecordVersionsInput.fields);
const ReorderRecordsTool = cmsTool("reorder_records", "Reorder records in a sortable/tree model by providing ordered record IDs", ReorderInput.fields);
const RemoveBlockTool = cmsTool("remove_block", "Remove a block type entirely (cleans DAST trees, deletes blocks, drops table), or remove it from a specific field's whitelist (provide fieldId).", RemoveBlockInput.fields);
const RemoveLocaleTool = cmsTool("remove_locale", "Remove a locale and strip it from all localized field values", LocaleIdInput.fields);
const UploadAssetTool = cmsTool("upload_asset", `Register an asset after uploading the original file to R2 out of band.

Upload flow:
1. Upload the original file to R2
2. Call this tool with the r2Key, filename, mimeType, and image dimensions
3. The asset metadata is registered and can be referenced in media fields by its ID`, AssetInput.fields);
const CreateAssetUploadUrlTool = cmsTool("create_asset_upload_url", `Create a short-lived presigned R2 upload URL for a local/generated file.

Use this when the asset exists in the agent environment and is not already available at a public URL.

Flow:
1. Call this tool with filename and mimeType
2. Upload the raw file bytes with HTTP PUT to the returned uploadUrl using the same Content-Type
3. Call upload_asset with the returned assetId as id, the returned r2Key, filename, mimeType, size, and dimensions
4. Use the returned asset ID in media/media_gallery fields

Requires the CMS instance to be configured with R2 S3-compatible signing credentials.`, CreateUploadUrlInput.fields);
const ImportAssetFromUrlTool = cmsTool("import_asset_from_url", `Download an asset from a public URL, store it in R2, and register it in one step.

Use this when you have an image URL and want an agent-friendly path.

Flow:
1. Provide the source URL
2. The CMS fetches the file (following normal public HTTP redirects), stores it in R2, and creates the asset record
3. Use the returned asset ID in media fields (e.g. {image: "<asset_id>"})

The response includes id, r2Key, url (full public URL), and metadata. The id is what you pass to media fields — the CMS validates that the asset exists when creating/updating records.`, ImportAssetFromUrlInput.fields);
const ListAssetsTool = cmsTool("list_assets", "List all assets with their IDs, filenames, and R2 keys");
const ReplaceAssetTool = cmsTool("replace_asset", `Replace an asset's file metadata while keeping the same ID and URL. All content references remain stable.

Flow:
1. Upload the new original file to R2
2. Call this tool with the asset ID and new file metadata
3. The asset URL stays the same — no broken links in content`, ReplaceAssetInput.fields);
const SchemaIOTool = cmsTool("schema_io", `Export or import the full CMS schema as portable JSON.

action: "export" | "import"
- export: returns schema JSON (models, fields, locales). No IDs — references use api_keys.
- import: creates all locales, models, and fields in dependency order from provided schema. Use on a fresh/empty CMS.
  Schema format: { "version": 1, "locales": [...], "models": [{ "name", "apiKey", "fields": [...] }] }`, SchemaIOInput.fields);
const SearchContentTool = cmsTool("search_content", `Search content records. Supports keyword search (FTS5), semantic search (Vectorize), or hybrid (both combined with rank fusion).

Keyword mode: phrases ("exact match"), prefix (word*), boolean (AND/OR).
Semantic mode: finds conceptually related content even when vocabulary differs (requires AI+Vectorize bindings).
Hybrid mode (default when Vectorize available): combines both for best results.
Results include modelApiKey, recordId, title when available, rank, and snippet.`, SearchContentInput.fields);
const ReindexSearchTool = cmsTool("reindex_search", "Rebuild FTS5 + Vectorize search indexes. Use after deploying search to a CMS with existing content, or to recover from index drift. Scoped to a single model or all content models.", ReindexSearchInput.fields);
const GetSiteSettingsTool = cmsTool("get_site_settings", "Get global site settings from the built-in site_settings table (site name, title suffix, global SEO, favicon, social accounts). This is separate from any content-model singleton also named site_settings.");
const UpdateSiteSettingsTool = cmsTool("update_site_settings", `Update global site settings in the built-in site_settings table. These power the _site GraphQL query (globalSeo, faviconMetaTags).

Use this tool for fields like siteName, titleSuffix, fallbackSeoTitle, and fallbackSeoDescription.
If your schema also has a singleton content model named site_settings with fields like tagline or logo, update that record with query_records + update_record instead of this tool.
When the task is specifically about the singleton record, avoid mixing both surfaces unless the user explicitly asks for both.`, UpdateSiteSettingsInput.fields);
const EditorTokensTool = cmsTool("editor_tokens", `Manage editor tokens: create, list, or revoke.

action: "create" | "list" | "revoke"
- create: provide name, optional expiresIn (seconds). Returns token for restricted write access (no schema mutations).
- list: returns all non-expired editor tokens.
- revoke: provide tokenId to revoke.`, EditorTokensInput.fields);

const GetPreviewUrlTool = cmsTool("get_preview_url", `Generate a preview URL for a draft record. The model must have a canonicalPathTemplate set (e.g. /posts/{slug}).

Returns a fully assembled URL with a short-lived preview token when siteUrl is configured, or the previewPath and token separately otherwise.`, GetPreviewUrlInput.fields);

const AdminTools = [
  SchemaInfoTool,
  CreateModelTool,
  UpdateModelTool,
  CreateFieldTool,
  UpdateFieldTool,
  DeleteModelTool,
  DeleteFieldTool,
  CreateRecordTool,
  UpdateRecordTool,
  PatchBlocksTool,
  DeleteRecordTool,
  GetRecordTool,
  QueryRecordsTool,
  BulkCreateRecordsTool,
  SetPublishStatusTool,
  ScheduleTool,
  RecordVersionsTool,
  ReorderRecordsTool,
  RemoveBlockTool,
  RemoveLocaleTool,
  CreateAssetUploadUrlTool,
  UploadAssetTool,
  ImportAssetFromUrlTool,
  ListAssetsTool,
  ReplaceAssetTool,
  SchemaIOTool,
  SearchContentTool,
  ReindexSearchTool,
  GetSiteSettingsTool,
  UpdateSiteSettingsTool,
  EditorTokensTool,
  GetPreviewUrlTool,
];

const EditorTools = [
  SchemaInfoTool,
  CreateRecordTool,
  UpdateRecordTool,
  PatchBlocksTool,
  DeleteRecordTool,
  GetRecordTool,
  QueryRecordsTool,
  BulkCreateRecordsTool,
  SetPublishStatusTool,
  ScheduleTool,
  RecordVersionsTool,
  ReorderRecordsTool,
  CreateAssetUploadUrlTool,
  UploadAssetTool,
  ImportAssetFromUrlTool,
  ListAssetsTool,
  ReplaceAssetTool,
  SearchContentTool,
  GetSiteSettingsTool,
  UpdateSiteSettingsTool,
  GetPreviewUrlTool,
] as const;

const CmsToolkit = Toolkit.make(...AdminTools);
const EditorToolkit = Toolkit.make(...EditorTools);

/** Tool metadata for Code Mode — extracted without MCP protocol overhead */
export function getToolMeta(mode: "admin" | "editor" = "admin") {
  const toolkit = mode === "editor" ? EditorToolkit : CmsToolkit;
  return Object.values(toolkit.tools).map((tool: AiTool.Any) => ({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: toMcpInputSchema(tool),
  }));
}

function createGuideResource() {
  return McpServer.resource({
    uri: "agent-cms://guide",
    name: "agent-cms-guide",
    description: "Orientation guide for agents: workflow, naming conventions, field formats, and lifecycle",
    mimeType: "text/plain",
    content: Effect.succeed(`agent-cms — Agent Orientation Guide

Server boundary:
  - Admin MCP: /mcp — includes schema mutation tools like create_model, create_field, delete_model, delete_field, schema_io, and token management.
  - Editor MCP: /mcp/editor — content/publishing/assets/search only. If a schema-mutation tool is missing, you are probably on the editor MCP and should switch surfaces instead of retrying.

Workflow order:
  schema_info -> create_model -> create_field -> create_record -> set_publish_status

Naming conventions:
  - api_key: snake_case (e.g. blog_post, cover_image)
  - GraphQL types: PascalCase (BlogPost, CoverImageRecord)
  - GraphQL fields: camelCase (coverImage, blogPost)
  - GraphQL list queries: allBlogPosts, allCategories
  - GraphQL single queries: blogPost, category
  - Block types get "Record" suffix in GraphQL: code_block -> CodeBlockRecord

Field value formats (composite types):
  - media: asset ID string, or {"upload_id":"<asset_id>","alt":"...","title":"...","focal_point":{"x":0.5,"y":0.2},"custom_data":{...}}
  - media_gallery: array of asset IDs and/or media override objects
  - link: record ID string
  - links: array of record ID strings
  - seo: {"title":"...","description":"...","image":"<asset_id>","twitterCard":"summary_large_image"}
  - structured_text: {text:"...",blocks:[...]} (canonical), Agent Text string, {agentText:"...",blocks:[...]}, or internal DAST envelope {"value":{"schema":"dast","document":{...}},"blocks":{...}}
    Prefer Agent Text for prose-heavy content. Inline formatting, links, and block placement all work. Initial block payloads are persisted by the same create_record/update_record call; patch_blocks is for later targeted edits, not for finishing initial block creation:
    - Standard markdown: **bold**, *italic*, \`code\`, ~~strike~~, [links](url)
    - Block refs: [[block:BLOCK_ID]] (own line)
    - Record links: [[record:RECORD_ID|link text]]
    - Inline items: [[inline_item:RECORD_ID]]
    - Inline blocks: [[inline_block:BLOCK_ID]]
  - color: {"red":255,"green":0,"blue":0,"alpha":255}
  - lat_lon: {"latitude":64.13,"longitude":-21.89}

Structured text editing notes:
  - patch_blocks can target both top-level blocks and nested blocks inside structured_text sub-fields.
  - If the same nested block ID exists in multiple locations, patch_blocks will ask you to patch the parent block explicitly.
  - patch_blocks supports an \`append\` array to insert new blocks without rebuilding the DAST. Each entry needs \`_type\` plus field values. New block nodes are appended to the end of the document. The response includes \`_appendedIds\` with the generated IDs.
  - get_record is the fastest way to inspect one known record's full materialized structured_text after search_content returns its id.
  - query_records materializes structured_text fields for inspection; on published records, _published_snapshot remains useful as a raw snapshot of what is live.

Draft/publish lifecycle:
  Records on draft-enabled models start as drafts. create_record returns the created draft record object, including its top-level id. Call set_publish_status with action "publish" and that recordId to make it visible in GraphQL.
  Use set_publish_status for both publish and unpublish, single and bulk operations — just pass an array of recordIds and the desired action.
  Required-field validation for draft-enabled models happens at publish time, not create_record time.
  Edits after publishing create a new draft version — publish again to update.
  GraphQL serves published content by default; use X-Include-Drafts header for previews.
  If a task says to verify what is live or publicly visible, do that via GraphQL or the site URL after publishing — not via query_records/get_record, which show workspace state rather than the public delivery surface.

Singletons and site settings:
  - If a singleton exists as a normal content model in your schema (for example a site_settings record with fields like tagline), treat it like content. Use update_record without recordId for direct singleton edits, or query_records + update_record if you need to inspect first.
  - get_site_settings/update_site_settings operate on the built-in global site_settings table used by the _site GraphQL query. That surface uses fields like siteName, titleSuffix, fallbackSeoTitle, and fallbackSeoDescription.

Asset upload flow:
  Preferred:
  1. Call import_asset_from_url with a public file URL (normal public redirects are followed automatically)
  2. The parsed tool payload is the asset object itself; read its top-level id field
  3. Use that returned asset ID in media/media_gallery fields

  Manual fallback:
  1. Call create_asset_upload_url for a local/generated file
  2. PUT the raw bytes to the returned uploadUrl
  3. Register with upload_asset tool (pass returned assetId as id, plus r2Key, filename, mimeType, size, dimensions)
  4. Use returned asset ID in media/media_gallery fields

Tool argument encoding:
  - Some MCP clients XML-encode tool arguments before they reach the server.
  - If a literal string value contains angle brackets (for example TypeScript generics like <T>, JSX, or inline HTML), escape them inside the JSON string as \u003C and \u003E.
  - This matters most for create_record/update_record payloads carrying code snippets in structured_text fields.

Raw HTTP / JSON-RPC access:
  - Endpoint: POST <mount>/mcp for admin, POST <mount>/mcp/editor for editor
  - The mount point may be nested (for example /cms/mcp), so scripts should reuse the exact MCP URL already configured in the client instead of assuming root-level /mcp
  - Auth: Authorization: Bearer <token>
  - For standalone curl/HTTP scripts, you can call tools/call directly; do not assume an initialize round-trip is required unless your specific client library expects it
  - Typical tool call body:
    {"jsonrpc":"2.0","method":"tools/call","params":{"name":"create_record","arguments":{...}},"id":1}
  - Tool results usually come back in result.content[0].text as a JSON string payload
  - jq extraction example:
    .result.content[0].text | fromjson
  - For single-record tools like import_asset_from_url, create_record, and get_record, that parsed payload is the object itself, so use payload.id directly rather than looking for nested arrays

Draft preview:
  Models can have a canonicalPathTemplate (e.g. /posts/{slug}) for preview URLs.
  Tool responses include _previewPath when a template is set.
  Use get_preview_url to generate a fully assembled preview link with a short-lived token.

Slug fields:
  Set validator {"slug_source": "title"} to auto-generate from a source field.
  Create the slug field AFTER the source field.

Pluralization:
  category -> allCategories, blog_post -> allBlogPosts, person -> allPeople
  Powered by standard English pluralization rules.

Translation:
  For translating structured_text fields, work with the Agent Text representation.
  Translate the full text document — not field by field — to preserve context, tone, and flow.
  Leave CMS handles ([[block:ID]], [[inline_block:ID]], [[inline_item:ID]]) untouched. For record links, translate only the visible label in [[record:ID|label]] and keep the ID unchanged.
  The CMS reconstructs DAST from Agent Text when you update the record.
  This gives full article context for fluid translations vs. isolated sentence-level machine translation.`),
  });
}

function createSchemaResource() {
  return McpServer.resource({
    uri: "agent-cms://schema",
    name: "agent-cms-schema",
    description: "Current CMS schema: models, fields, and locales as JSON",
    mimeType: "application/json",
    content: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const models = yield* sql.unsafe<ModelRow>("SELECT * FROM models ORDER BY is_block, created_at");
      const fields = yield* sql.unsafe<FieldRow>("SELECT * FROM fields ORDER BY model_id, position");
      const locales = yield* sql.unsafe<LocaleRow>("SELECT * FROM locales ORDER BY position");
      const fieldsByModel = new Map<string, FieldRow[]>();
      for (const f of fields) {
        const list = fieldsByModel.get(f.model_id) ?? [];
        list.push(f);
        fieldsByModel.set(f.model_id, list);
      }
      return encodeJson({
        locales: locales.map((l) => ({ code: l.code, position: l.position, fallbackLocaleId: l.fallback_locale_id })),
        models: models.map((m) => ({
          id: m.id,
          name: m.name,
          apiKey: m.api_key,
          isBlock: !!m.is_block,
          singleton: !!m.singleton,
          fields: (fieldsByModel.get(m.id) ?? []).map((f) => ({
            id: f.id,
            apiKey: f.api_key,
            label: f.label,
            type: f.field_type,
            localized: !!f.localized,
            validators: parseValidators(f.validators),
          })),
        })),
      });
    }),
  });
}

function createSetupContentModelPrompt() {
  return McpServer.prompt({
    name: "setup-content-model",
    description: "Guide an agent through designing and creating content models from a description",
    parameters: SetupContentModelPromptInput.fields,
    content: ({ description }) =>
      Effect.succeed(`Set up content models for: ${description}

Follow these steps:
1. Call schema_info to check existing models — avoid duplicates.
2. Design the models and fields needed. Consider:
   - Which are content models vs block types (for StructuredText embedding)?
   - Which fields need slug (add after the source field with slug_source validator)?
   - Which fields reference other models (link/links with item_item_type validator)?
   - Which fields need structured_text (with structured_text_blocks validator for allowed blocks)?
   - Which fields need rich_text for modular/page-builder content (with rich_text_blocks validator)?
3. Present your plan before executing — list models, fields, and relationships.
4. Create models first, then fields in order (slug fields after their source).
5. Create a few sample records to verify the schema works.
6. Publish the sample records with set_publish_status.
7. Show the GraphQL query that a frontend would use to fetch this content.
   Remember: api_key snake_case -> GraphQL camelCase fields, PascalCase types.`),
  });
}

function createGenerateGraphqlQueriesPrompt() {
  return McpServer.prompt({
    name: "generate-graphql-queries",
    description: "Generate GraphQL queries for a content model with proper naming conventions",
    parameters: GenerateGraphqlQueriesPromptInput.fields,
    content: ({ modelApiKey }) =>
      Effect.succeed(`Generate GraphQL queries for the "${modelApiKey}" model.

Steps:
1. Call schema_info with filterByName "${modelApiKey}" to get the full field list.
2. Map field names from snake_case (api_key) to camelCase (GraphQL).
3. Generate these queries:
   a. List query: all_<pluralized> with pagination, filtering, and ordering
   b. Single query: <model_api_key> by ID or filter
   c. Meta query: _all_<pluralized>_meta for total count
4. For each field type, use the right GraphQL fragment:
   - media -> { url width height alt title }
   - structured_text -> { value blocks { ... on <BlockType>Record { id <fields> } } }
   - link -> { id <fields of target model> }
   - links -> same as link but array
   - seo -> { title description image { url } twitterCard }
   - color -> { red green blue alpha hex }
   - lat_lon -> { latitude longitude }
5. Include both a "full" query with all fields and a "list" query with essential fields only.`),
  });
}

export interface CreateMcpLayerOptions {
  readonly mode?: "admin" | "editor";
  readonly path?: string;
  readonly r2Bucket?: R2Bucket;
  readonly r2Credentials?: R2UploadCredentials;
  readonly fetch?: typeof globalThis.fetch;
  readonly actor?: RequestActor | null;
  readonly assetBaseUrl?: string;
  readonly siteUrl?: string;
}

export function createMcpLayer(
  sqlLayer: Layer.Layer<SqlClient.SqlClient | VectorizeContext | HooksContext>,
  options?: CreateMcpLayerOptions,
){
  const mode = options?.mode ?? "admin";
  const path = options?.path ?? (mode === "editor" ? "/mcp/editor" : "/mcp");
  const defaultVectorizeLayer: Layer.Layer<VectorizeContext> = Layer.succeed(VectorizeContext, Option.none());
  const defaultHooksLayer: Layer.Layer<HooksContext> = Layer.succeed(HooksContext, Option.none());
  const defaultAssetImportLayer: Layer.Layer<AssetImportContext> = Layer.succeed(AssetImportContext, {
    r2Bucket: options?.r2Bucket,
    r2Credentials: options?.r2Credentials,
    fetch: options?.fetch ?? globalThis.fetch,
  });
  const fullLayer: Layer.Layer<SqlClient.SqlClient | VectorizeContext | HooksContext | AssetImportContext> = Layer.merge(
    Layer.merge(Layer.merge(defaultVectorizeLayer, defaultHooksLayer), defaultAssetImportLayer),
    sqlLayer,
  );
  const serverLayer = McpServer.layerHttp({
    name: mode === "editor" ? "agent-cms-editor" : "agent-cms",
    version: "0.1.0",
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Effect MCP path is typed as a route literal, but this server accepts a runtime-configured route.
    path: path as never,
    protocols: [McpProtocol.v2025_06_18],
  });

  function assetUrl(r2Key: string): string | undefined {
    if (!options?.assetBaseUrl) return undefined;
    return `${options.assetBaseUrl.replace(/\/$/, "")}/${r2Key}`;
  }

  /** Resolve the acting identity per request (headers set by the worker dispatch), falling back to construction-time options. */
  function requestActor() {
    return Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      return actorFromHeaders(new Headers(req.headers)) ?? options?.actor ?? null;
    });
  }

  function withAssetUrl<T extends { r2Key: string }>(asset: T) {
    const url = assetUrl(asset.r2Key);
    return url ? { ...asset, url } : asset;
  }

  /** Look up canonical_path_template for a model and resolve _previewPath if set */
  function addPreviewPath(modelApiKey: string, record: unknown) {
    return Effect.gen(function* () {
      if (!isObjectRecord(record)) return record;
      const sql = yield* SqlClient.SqlClient;
      const models = yield* sql.unsafe<{ canonical_path_template: string | null }>(
        "SELECT canonical_path_template FROM models WHERE api_key = ?",
        [modelApiKey]
      );
      const template = models[0]?.canonical_path_template;
      if (!template) return record;
      const previewPath = PreviewService.resolvePreviewPath(template, record);
      return { ...record, _previewPath: previewPath };
    });
  }

  function addPreviewPathToList(modelApiKey: string, records: unknown) {
    return Effect.gen(function* () {
      if (!Array.isArray(records)) return records;
      const recordList: readonly unknown[] = records;
      const sql = yield* SqlClient.SqlClient;
      const models = yield* sql.unsafe<{ canonical_path_template: string | null }>(
        "SELECT canonical_path_template FROM models WHERE api_key = ?",
        [modelApiKey]
      );
      const template = models[0]?.canonical_path_template;
      if (!template) return recordList;
      return recordList.map((r) => {
        if (!isObjectRecord(r)) return r;
        const previewPath = PreviewService.resolvePreviewPath(template, r);
        return { ...r, _previewPath: previewPath };
      });
    });
  }

  const toolHandlers: Record<string, (params: unknown) => Effect.Effect<unknown, unknown, unknown>> = {
    schema_info: withDecoded(SchemaInfoInput, ({ filterByName, filterByType, includeFieldDetails }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        let modelQuery = "SELECT * FROM models";
        const conditions: string[] = [];
        const params: unknown[] = [];
        if (filterByType === "model") conditions.push("is_block = 0");
        if (filterByType === "block") conditions.push("is_block = 1");
        if (filterByName) {
          conditions.push("LOWER(name) LIKE ? ESCAPE '\\'");
          params.push(likeContains(filterByName.toLowerCase()));
        }
        if (conditions.length > 0) modelQuery += ` WHERE ${conditions.join(" AND ")}`;
        modelQuery += " ORDER BY is_block, created_at";

        const models = yield* sql.unsafe<ModelRow>(modelQuery, params);
        const allFields = yield* sql.unsafe<FieldRow>("SELECT * FROM fields ORDER BY model_id, position");
        const locales = yield* sql.unsafe<LocaleRow>("SELECT * FROM locales ORDER BY position");
        const fieldsByModel = new Map<string, FieldRow[]>();
        for (const f of allFields) {
          const list = fieldsByModel.get(f.model_id) ?? [];
          list.push(f);
          fieldsByModel.set(f.model_id, list);
        }

        return {
          locales: locales.map((l) => ({ code: l.code, position: l.position, fallbackLocaleId: l.fallback_locale_id })),
          models: models.map((m) => {
            const mFields = fieldsByModel.get(m.id) ?? [];
            return {
              id: m.id,
              name: m.name,
              apiKey: m.api_key,
              isBlock: !!m.is_block,
              singleton: !!m.singleton,
              sortable: !!m.sortable,
              tree: !!m.tree,
              allLocalesRequired: !!m.all_locales_required,
              canonicalPathTemplate: m.canonical_path_template ?? null,
              ...(includeFieldDetails
                ? {
                    fields: mFields.map((f) => ({
                      id: f.id,
                      label: f.label,
                      apiKey: f.api_key,
                      type: f.field_type,
                      localized: !!f.localized,
                      validators: parseValidators(f.validators),
                      hint: f.hint,
                    })),
                  }
                : {
                    fieldCount: mFields.length,
                    fieldNames: mFields.map((f) => f.api_key),
                  }),
            };
          }),
        };
      })),
    create_model: withDecoded(CreateModelInput, ModelService.createModel),
    update_model: withDecoded(UpdateModelInput, ({ modelId, ...rest }) => ModelService.updateModel(modelId, rest)),
    create_field: withDecoded(
      Schema.Struct({ modelId: Schema.String, ...CreateFieldInput.fields }),
      ({ modelId, ...rest }) => FieldService.createField(modelId, rest),
    ),
    update_field: withDecoded(UpdateFieldInput, ({ fieldId, ...rest }) => FieldService.updateField(fieldId, rest)),
    delete_model: withDecoded(ModelIdInput, ({ modelId }) => ModelService.deleteModel(modelId)),
    delete_field: withDecoded(FieldIdInput, ({ fieldId }) => FieldService.deleteField(fieldId)),
    create_record: withDecoded(CreateRecordInput, (input) =>
      Effect.gen(function* () {
        const actor = yield* requestActor();
        return yield* RecordService.createRecord(input, actor).pipe(Effect.flatMap((r) => addPreviewPath(input.modelApiKey, r)));
      })),
    update_record: withDecoded(UpdateRecordInput, ({ recordId, modelApiKey, data }) =>
      Effect.gen(function* () {
        const actor = yield* requestActor();
        const effect = recordId
          ? RecordService.patchRecord(recordId, { modelApiKey, data }, actor)
          : RecordService.updateSingletonRecord(modelApiKey, data, actor);
        return yield* effect.pipe(Effect.flatMap((r) => addPreviewPath(modelApiKey, r)));
      })),
    patch_blocks: withDecoded(PatchBlocksInput, (input) =>
      Effect.gen(function* () {
        const actor = yield* requestActor();
        return yield* RecordService.patchBlocksForField(input, actor).pipe(
          Effect.map((record) => {
            const deletedIds = Object.entries(input.blocks)
              .filter(([, v]) => v === null)
              .map(([k]) => k);
            if (!record) {
              return {
                recordId: null,
                status: null,
                fieldApiKey: input.fieldApiKey,
                field: null,
                blocks: {},
                deleted: deletedIds,
                blockOrder: [],
              };
            }
            return compactPatchBlocksResponse(record, input.fieldApiKey, deletedIds);
          }),
        );
      })),
    delete_record: withDecoded(DeleteRecordInput, ({ recordIds, modelApiKey }) =>
      Effect.forEach(recordIds, (recordId) => RecordService.removeRecord(modelApiKey, recordId)).pipe(
        Effect.map((results) => ({ deleted: true, count: results.length })),
      )),
    get_record: withDecoded(GetRecordInput, ({ recordId, modelApiKey }) =>
      RecordService.getRecord(modelApiKey, recordId).pipe(Effect.flatMap((r) => addPreviewPath(modelApiKey, r)))),
    query_records: withDecoded(QueryRecordsInput, ({ modelApiKey }) =>
      RecordService.listRecords(modelApiKey).pipe(Effect.flatMap((r) => addPreviewPathToList(modelApiKey, r)))),
    bulk_create_records: withDecoded(BulkCreateRecordsInput, ({ modelApiKey, records }) =>
      Effect.gen(function* () {
        const actor = yield* requestActor();
        return yield* RecordService.bulkCreateRecords({ modelApiKey, records }, actor);
      })),
    set_publish_status: withDecoded(SetPublishStatusInput, ({ action, recordIds, modelApiKey }) =>
      Effect.gen(function* () {
        const actor = yield* requestActor();
        const op = action === "publish"
          ? (recordIds.length === 1
              ? PublishService.publishRecord(modelApiKey, recordIds[0], actor)
              : PublishService.bulkPublishRecords(modelApiKey, recordIds, actor))
          : (recordIds.length === 1
              ? PublishService.unpublishRecord(modelApiKey, recordIds[0], actor)
              : PublishService.bulkUnpublishRecords(modelApiKey, recordIds, actor));
        return yield* op;
      })),
    schedule: withDecoded(ScheduleInput, ({ recordId, modelApiKey, action, at }) =>
      Effect.gen(function* () {
        const actor = yield* requestActor();
        if (action === "clear") return yield* ScheduleService.clearSchedule(modelApiKey, recordId, actor);
        if (action === "publish") return yield* ScheduleService.schedulePublish(modelApiKey, recordId, at ?? null, actor);
        return yield* ScheduleService.scheduleUnpublish(modelApiKey, recordId, at ?? null, actor);
      })),
    record_versions: withDecoded(RecordVersionsInput, ({ action, modelApiKey, recordId, versionId }) => {
      if (action === "list") return VersionService.listVersions(modelApiKey, recordId);
      if (action === "get") {
        if (!versionId) return Effect.fail({ _tag: "ValidationError", message: "versionId is required for get action" });
        return VersionService.getVersion(versionId);
      }
      if (!versionId) return Effect.fail({ _tag: "ValidationError", message: "versionId is required for restore action" });
      return Effect.gen(function* () {
        const actor = yield* requestActor();
        return yield* VersionService.restoreVersion(modelApiKey, recordId, versionId, actor);
      });
    }),
    reorder_records: withDecoded(ReorderInput, ({ modelApiKey, recordIds }) =>
      Effect.gen(function* () {
        const actor = yield* requestActor();
        return yield* RecordService.reorderRecords(modelApiKey, recordIds, actor);
      })),
    remove_block: withDecoded(RemoveBlockInput, ({ blockApiKey, fieldId }) => {
      if (fieldId) return SchemaLifecycle.removeBlockFromWhitelist({ fieldId, blockApiKey });
      return SchemaLifecycle.removeBlockType(blockApiKey);
    }),
    remove_locale: withDecoded(LocaleIdInput, ({ localeId }) => SchemaLifecycle.removeLocale(localeId)),
    create_asset_upload_url: withDecoded(CreateUploadUrlInput, AssetService.createAssetUploadUrl),
    upload_asset: withDecoded(AssetInput, (input) =>
      Effect.gen(function* () {
        const actor = yield* requestActor();
        return yield* AssetService.createAsset(input, actor).pipe(Effect.map(withAssetUrl));
      })),
    import_asset_from_url: withDecoded(ImportAssetFromUrlInput, (input) =>
      Effect.gen(function* () {
        const actor = yield* requestActor();
        return yield* AssetService.importAssetFromUrl(input, actor).pipe(Effect.map(withAssetUrl));
      })),
    list_assets: () =>
      AssetService.listAssets().pipe(Effect.map(({ assets }) => assets.map((a) => {
        const url = assetUrl(a.r2_key);
        return url ? { ...a, url } : a;
      }))),
    replace_asset: withDecoded(ReplaceAssetInput, ({ assetId, ...rest }) =>
      Effect.gen(function* () {
        const actor = yield* requestActor();
        return yield* AssetService.replaceAsset(assetId, rest, actor).pipe(Effect.map(withAssetUrl));
      })),
    schema_io: withDecoded(SchemaIOInput, ({ action, schema }) => {
      if (action === "export") return SchemaIO.exportSchema();
      if (!schema) return Effect.fail({ _tag: "ValidationError", message: "schema is required for import action" });
      return SchemaIO.importSchema(schema);
    }),
    search_content: withDecoded(SearchContentInput, SearchService.search),
    reindex_search: withDecoded(ReindexSearchInput, ({ modelApiKey }) => SearchService.reindexAll(modelApiKey)),
    get_site_settings: () => SiteSettingsService.getSiteSettings(),
    update_site_settings: withDecoded(UpdateSiteSettingsInput, SiteSettingsService.updateSiteSettings),
    get_preview_url: withDecoded(GetPreviewUrlInput, ({ recordId, modelApiKey }) =>
      Effect.gen(function* () {
        const model = yield* ModelService.getModelByApiKey(modelApiKey);
        if (!model.canonical_path_template) {
          return yield* Effect.fail({ _tag: "ValidationError", message: `Model '${modelApiKey}' has no canonicalPathTemplate configured` });
        }
        const record = yield* RecordService.getRecord(modelApiKey, recordId);
        const previewPath = PreviewService.resolvePreviewPath(model.canonical_path_template, record);
        const { token, expiresAt } = yield* PreviewService.createPreviewToken();
        const siteUrl = options?.siteUrl;
        if (siteUrl) {
          const base = siteUrl.replace(/\/$/, "");
          const url = `${base}/api/draft-mode/enable?token=${encodeURIComponent(token)}&redirect=${encodeURIComponent(previewPath)}`;
          return { url, previewPath, token, expiresAt };
        }
        return { previewPath, token, expiresAt };
      })),
    editor_tokens: withDecoded(EditorTokensInput, ({ action, name, expiresIn, tokenId }) => {
      if (action === "list") return TokenService.listEditorTokens();
      if (action === "create") {
        if (!name) return Effect.fail({ _tag: "ValidationError", message: "name is required for create action" });
        return TokenService.createEditorToken({ name, expiresIn });
      }
      if (!tokenId) return Effect.fail({ _tag: "ValidationError", message: "tokenId is required for revoke action" });
      return TokenService.revokeEditorToken(tokenId);
    }),
  } as const;

  // Handler layer built against the admin toolkit (editor tools are a subset);
  // the registration loop below selects which tools each mode actually exposes.
  const toolkitHandlers = CmsToolkit.toLayer(pickToolkitHandlers(CmsToolkit, toolHandlers));

  const toolkitRegistration = Layer.effectDiscard(Effect.gen(function* () {
    const registry = yield* McpServer.McpServer;
    // Editor tools are a strict subset of admin tools (same consts), so the
    // registration mechanics run against the admin toolkit while the mode
    // selects which tools actually get registered.
    const built = yield* CmsToolkit;
    const context = yield* Effect.context();
    const registeredTools = mode === "editor" ? EditorToolkit.tools : built.tools;

    for (const tool of Object.values(registeredTools)) {
      const mcpTool = new McpSchema.Tool({
        name: tool.name,
        description: tool.description,
        inputSchema: toMcpInputSchema(tool),
        annotations: {
          ...Context.getOption(tool.annotations, AiTool.Title).pipe(Option.map((title) => ({ title })), Option.getOrUndefined),
          readOnlyHint: Context.get(tool.annotations, AiTool.Readonly),
          destructiveHint: Context.get(tool.annotations, AiTool.Destructive),
          idempotentHint: Context.get(tool.annotations, AiTool.Idempotent),
          openWorldHint: Context.get(tool.annotations, AiTool.OpenWorld),
        },
      });

      yield* registry.addTool({
        tool: mcpTool,
        annotations: Context.empty(),
        handle(payload) {
          const params = isToolPayload(payload) ? payload : {};
          // Enforce `additionalProperties: false` on the raw payload before the
          // Toolkit decode silently strips unknown keys (see collectExcessProperties).
          const excess = collectExcessProperties(mcpTool.inputSchema, params);
          if (excess.length > 0) {
            const error = {
              _tag: "ValidationError",
              message: `${excess.join("; ")}. Check the tool's inputSchema.`,
            };
            return Effect.succeed(
              new McpSchema.CallToolResult({
                isError: true,
                structuredContent: toStructuredContent(error),
                content: [{ type: "text", text: encodeJson(error) }],
              }),
            );
          }
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- dynamic MCP registry dispatch crosses Effect Toolkit's generated tool-name/payload types.
          return built.handle(tool.name as never, params as never).pipe(
            Effect.provide(context),
            Effect.flatMap((stream) => Stream.runLast(stream)),
            Effect.map((maybeResult) =>
              Option.isSome(maybeResult)
                ? new McpSchema.CallToolResult({
                    isError: maybeResult.value.isFailure,
                    structuredContent: toStructuredContent(maybeResult.value.encodedResult),
                    content: [{ type: "text", text: encodeJson(maybeResult.value.encodedResult) }],
                  })
                : new McpSchema.CallToolResult({
                    content: [{ type: "text", text: "Tool returned no result" }],
                  }),
            ),
            Effect.catch((rawError) => {
              const error = formatToolError(rawError);
              return Effect.succeed(new McpSchema.CallToolResult({
                isError: true,
                structuredContent: toStructuredContent(error),
                content: [{ type: "text", text: encodeJson(error) }],
              }));
            }),
          );
        },
      });
    }
  })).pipe(Layer.provide(toolkitHandlers));

  const registeredContent = Layer.mergeAll(
    toolkitRegistration,
    createGuideResource(),
    createSchemaResource(),
    createSetupContentModelPrompt(),
    createGenerateGraphqlQueriesPrompt(),
  ).pipe(Layer.provide(serverLayer));

  return Layer.merge(serverLayer, registeredContent).pipe(Layer.provide(fullLayer));
}
