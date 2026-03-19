/**
 * Effect-native MCP (Model Context Protocol) server for agent-cms.
 * 3-layer architecture: Discovery -> Schema -> Content
 */
import * as McpServer from "@effect/ai/McpServer";
import * as McpSchema from "@effect/ai/McpSchema";
import * as AiTool from "@effect/ai/Tool";
import * as Toolkit from "@effect/ai/Toolkit";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "@effect/sql";
import * as ModelService from "../services/model-service.js";
import * as FieldService from "../services/field-service.js";
import * as RecordService from "../services/record-service.js";
import * as PublishService from "../services/publish-service.js";
import * as AssetService from "../services/asset-service.js";
import { AssetImportContext } from "../services/asset-service.js";
import * as VersionService from "../services/version-service.js";
import * as SchemaLifecycle from "../services/schema-lifecycle.js";
import * as SchemaIO from "../services/schema-io.js";
import * as SearchService from "../search/search-service.js";
import * as SiteSettingsService from "../services/site-settings-service.js";
import * as TokenService from "../services/token-service.js";
import {
  CreateAssetInput as AssetInput,
  CreateFieldInput,
  CreateModelInput,
  CreateRecordInput,
  ImportAssetFromUrlInput,
  ImportSchemaInput,
  ReindexSearchInput,
  ReorderInput,
  SearchInput as SearchContentInput,
} from "../services/input-schemas.js";
import type { ModelRow, FieldRow, LocaleRow } from "../db/row-types.js";
import { VectorizeContext } from "../search/vectorize-context.js";
import { HooksContext } from "../hooks.js";
import { decodeJsonRecordStringOr, encodeJson } from "../json.js";
import type { RequestActor } from "../attribution.js";

const JsonRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const CommonDependencies = [SqlClient.SqlClient, VectorizeContext, HooksContext, AssetImportContext];

const BuildStructuredTextInput = Schema.Struct({
  paragraphs: Schema.optional(Schema.Array(Schema.String)),
  blocks: Schema.optional(
    Schema.Array(
      Schema.Struct({
        type: Schema.String,
        data: JsonRecord,
      })
    )
  ),
});

const UpdateModelInput = Schema.Struct({
  modelId: Schema.String,
  name: Schema.optional(Schema.String),
  apiKey: Schema.optional(Schema.String),
  singleton: Schema.optional(Schema.Boolean),
  sortable: Schema.optional(Schema.Boolean),
  hasDraft: Schema.optional(Schema.Boolean),
  allLocalesRequired: Schema.optional(Schema.Boolean),
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
const ApiKeyInput = Schema.Struct({ apiKey: Schema.String });
const LocaleIdInput = Schema.Struct({ localeId: Schema.String });
const VersionIdInput = Schema.Struct({ versionId: Schema.String });

const SchemaInfoInput = Schema.Struct({
  filterByName: Schema.optional(Schema.String),
  filterByType: Schema.optional(Schema.Literal("model", "block")),
  includeFieldDetails: Schema.optionalWith(Schema.Boolean, { default: () => true }),
});

const UpdateRecordInput = Schema.Struct({
  recordId: Schema.String,
  modelApiKey: Schema.String,
  data: Schema.optionalWith(JsonRecord, { default: () => ({}) }),
});

const PatchBlocksInput = Schema.Struct({
  recordId: Schema.String,
  modelApiKey: Schema.String,
  fieldApiKey: Schema.String,
  value: Schema.optional(Schema.Unknown),
  blocks: Schema.Record({ key: Schema.String, value: Schema.NullOr(Schema.Unknown) }),
});

const DeleteRecordInput = Schema.Struct({
  recordId: Schema.String,
  modelApiKey: Schema.String,
});

const QueryRecordsInput = Schema.Struct({
  modelApiKey: Schema.String,
});

const BulkCreateRecordsInput = Schema.Struct({
  modelApiKey: Schema.String,
  records: Schema.Array(JsonRecord),
});

const PublishRecordInput = Schema.Struct({
  recordId: Schema.String,
  modelApiKey: Schema.String,
});

const RestoreVersionInput = Schema.Struct({
  modelApiKey: Schema.String,
  recordId: Schema.String,
  versionId: Schema.String,
});

const RemoveBlockTypeInput = Schema.Struct({
  blockApiKey: Schema.String,
});

const RemoveBlockFromWhitelistInput = Schema.Struct({
  fieldId: Schema.String,
  blockApiKey: Schema.String,
});

const ReplaceAssetInput = Schema.Struct({
  assetId: Schema.String,
  ...AssetInput.fields,
});

const ImportSchemaToolInput = Schema.Struct({
  schema: ImportSchemaInput,
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

const CreateEditorTokenMcpInput = Schema.Struct({
  name: Schema.String,
  expiresIn: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
});

const TokenIdInput = Schema.Struct({ tokenId: Schema.String });

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
    parameters: parameters ?? {},
    success: Schema.Unknown,
    failure: Schema.Unknown,
    dependencies: CommonDependencies,
  });
  const isReadonly = name.startsWith("list_")
    || name.startsWith("describe_")
    || name.startsWith("query_")
    || name.startsWith("get_")
    || name === "schema_info"
    || name === "build_structured_text"
    || name === "search_content"
    || name === "export_schema";
  tool = tool.annotate(AiTool.Readonly, isReadonly);
  tool = tool.annotate(AiTool.Idempotent, isReadonly || name.startsWith("update_") || name.startsWith("replace_"));
  tool = tool.annotate(AiTool.Destructive, name.startsWith("delete_") || name.startsWith("remove_"));
  tool = tool.annotate(AiTool.OpenWorld, name === "search_content");
  return tool;
}

function toStructuredContent(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function isToolPayload(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && typeof value === "object";
}

function parseValidators(value: unknown): Record<string, unknown> {
  if (value == null || value === "") return {};
  if (typeof value === "string") return decodeJsonRecordStringOr(value, {});
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function withDecoded<A, I, R, B, E, R2>(
  schema: Schema.Schema<A, I, R>,
  handler: (params: A) => Effect.Effect<B, E, R2>,
) {
  return (params: unknown) => Schema.decodeUnknown(schema)(params).pipe(Effect.flatMap(handler));
}

function toMcpInputSchema(tool: AiTool.Any) {
  // Effect AI's helper is typed against the concrete Tool model, while AiTool.Any is wider.
  // Runtime behavior is correct here because every entry in CmsToolkit is created via AiTool.make.
  // @ts-expect-error external type mismatch between Any and getJsonSchema helper
  const inputSchema = AiTool.getJsonSchema(tool);
  return typeof inputSchema === "object"
    && "type" in inputSchema
    && inputSchema.type === "object"
    ? inputSchema
    : { type: "object", properties: {}, additionalProperties: false };
}

function pickToolkitHandlers<T extends Record<string, unknown>>(
  toolkit: { readonly tools: Record<string, AiTool.Any> },
  handlers: T,
) {
  const filtered: Record<string, unknown> = {};
  for (const name of Object.keys(toolkit.tools)) {
    filtered[name] = handlers[name];
  }
  return filtered;
}

const ListModelsTool = cmsTool("list_models", "List all content models and block types with their fields");
const DescribeModelTool = cmsTool("describe_model", "Get detailed info about a model", ApiKeyInput.fields);
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
- any field: {"required": true} — field is required (provide default_value for existing records)`, {
  modelId: Schema.String,
  ...CreateFieldInput.fields,
});
const UpdateFieldTool = cmsTool("update_field", "Update field properties (label, apiKey, validators, hint)", UpdateFieldInput.fields);
const DeleteModelTool = cmsTool("delete_model", "Delete a model (fails if referenced)", ModelIdInput.fields);
const DeleteFieldTool = cmsTool("delete_field", "Delete a field and drop column", FieldIdInput.fields);
const SchemaInfoTool = cmsTool("schema_info", "Get the complete CMS schema in one call — models, block types, fields, relations. The primary tool for understanding the content model.", SchemaInfoInput.fields);
const CreateRecordTool = cmsTool("create_record", `Create a content record. Records start as draft — call publish_record to make them visible in GraphQL.

Field value formats:
- media: asset ID string, or {"upload_id":"<asset_id>","alt":"...","title":"...","focal_point":{"x":0.5,"y":0.2},"custom_data":{...}}
- media_gallery: array of asset IDs and/or media override objects
- link: record ID string
- links: array of record ID strings
- seo: {"title":"...","description":"...","image":"<asset_id>","twitterCard":"summary_large_image"}
- structured_text: {"value":{"schema":"dast","document":{...}},"blocks":{"<id>":{"_type":"block_api_key",...}}}
- color: {"red":255,"green":0,"blue":0,"alpha":255}
- lat_lon: {"latitude":64.13,"longitude":-21.89}`, CreateRecordInput.fields);
const UpdateRecordTool = cmsTool("update_record", "Update record fields", UpdateRecordInput.fields);
const PatchBlocksTool = cmsTool("patch_blocks", `Partially update blocks in a structured text field without resending the entire content tree.

Patch map semantics for each block ID:
- string value (the block ID) → keep block unchanged
- object with field overrides → merge into existing block (only specified fields updated)
- null → delete block and auto-prune from DAST

Block IDs not in the patch map are kept unchanged.

Optionally provide a new DAST \`value\`. If omitted, the existing DAST is preserved (with deleted blocks auto-pruned).

Example — update one block's description, delete another, keep the rest:
{ blocks: { "block-1": "block-1", "block-2": { "description": "New text" }, "block-3": null } }`, PatchBlocksInput.fields);
const DeleteRecordTool = cmsTool("delete_record", "Delete a record", DeleteRecordInput.fields);
const QueryRecordsTool = cmsTool("query_records", "List records for a model", QueryRecordsInput.fields);
const BulkCreateRecordsTool = cmsTool("bulk_create_records", `Create multiple records in one operation (up to 1000). Much faster than calling create_record in a loop.

All records must belong to the same model. Slugs are auto-generated. Returns array of created record IDs.`, BulkCreateRecordsInput.fields);
const PublishRecordTool = cmsTool("publish_record", "Publish a record", PublishRecordInput.fields);
const UnpublishRecordTool = cmsTool("unpublish_record", "Unpublish a record", PublishRecordInput.fields);
const ListRecordVersionsTool = cmsTool("list_record_versions", "List all version snapshots for a record, newest first. Versions are created on each publish or auto-republish.", PublishRecordInput.fields);
const GetRecordVersionTool = cmsTool("get_record_version", "Get a specific version snapshot by version ID", VersionIdInput.fields);
const RestoreRecordVersionTool = cmsTool("restore_record_version", "Restore a record to a previous version. The current state is versioned first, so restore is always reversible. For has_draft models, the record returns to draft status (needs re-publish). For non-draft models, the record is auto-republished.", RestoreVersionInput.fields);
const ReorderRecordsTool = cmsTool("reorder_records", "Reorder records in a sortable/tree model by providing ordered record IDs", ReorderInput.fields);
const RemoveBlockTypeTool = cmsTool("remove_block_type", "Remove a block type: cleans DAST trees, deletes blocks, drops table", RemoveBlockTypeInput.fields);
const RemoveBlockFromWhitelistTool = cmsTool("remove_block_from_whitelist", "Remove a block type from a field's whitelist and clean affected DAST trees", RemoveBlockFromWhitelistInput.fields);
const RemoveLocaleTool = cmsTool("remove_locale", "Remove a locale and strip it from all localized field values", LocaleIdInput.fields);
const BuildStructuredTextTool = cmsTool("build_structured_text", "Build a valid StructuredText value from prose and blocks. Auto-assigns ULIDs to blocks.", BuildStructuredTextInput.fields);
const UploadAssetTool = cmsTool("upload_asset", `Register an asset after uploading the original file to R2 out of band.

Upload flow:
1. Upload the original file to R2
2. Call this tool with the r2Key, filename, mimeType, and image dimensions
3. The asset metadata is registered and can be referenced in media fields by its ID`, AssetInput.fields);
const ImportAssetFromUrlTool = cmsTool("import_asset_from_url", `Download an asset from a public URL, store it in R2, and register it in one step.

Use this when you have an image URL and want an agent-friendly path.

Flow:
1. Provide the source URL
2. The CMS fetches the file, stores it in R2, and creates the asset record
3. Use the returned asset ID in media fields`, ImportAssetFromUrlInput.fields);
const ListAssetsTool = cmsTool("list_assets", "List all assets with their IDs, filenames, and R2 keys");
const ReplaceAssetTool = cmsTool("replace_asset", `Replace an asset's file metadata while keeping the same ID and URL. All content references remain stable.

Flow:
1. Upload the new original file to R2
2. Call this tool with the asset ID and new file metadata
3. The asset URL stays the same — no broken links in content`, ReplaceAssetInput.fields);
const ExportSchemaTool = cmsTool("export_schema", "Export the full CMS schema (models, fields, locales) as portable JSON. No IDs — references use api_keys. Use import_schema to restore on a fresh CMS.");
const ImportSchemaTool = cmsTool("import_schema", `Import a CMS schema from JSON. Creates all locales, models, and fields in dependency order. Use on a fresh/empty CMS.

The schema format matches export_schema output:
{ "version": 1, "locales": [...], "models": [{ "name", "apiKey", "fields": [...] }] }`, ImportSchemaToolInput.fields);
const SearchContentTool = cmsTool("search_content", `Search content records. Supports keyword search (FTS5), semantic search (Vectorize), or hybrid (both combined with rank fusion).

Keyword mode: phrases ("exact match"), prefix (word*), boolean (AND/OR).
Semantic mode: finds conceptually related content even when vocabulary differs (requires AI+Vectorize bindings).
Hybrid mode (default when Vectorize available): combines both for best results.`, SearchContentInput.fields);
const ReindexSearchTool = cmsTool("reindex_search", "Rebuild FTS5 + Vectorize search indexes. Use after deploying search to a CMS with existing content, or to recover from index drift. Scoped to a single model or all content models.", ReindexSearchInput.fields);
const GetSiteSettingsTool = cmsTool("get_site_settings", "Get global site settings (site name, title suffix, global SEO, favicon, social accounts)");
const UpdateSiteSettingsTool = cmsTool("update_site_settings", `Update global site settings. These power the _site GraphQL query (globalSeo, faviconMetaTags).`, UpdateSiteSettingsInput.fields);
const CreateEditorTokenTool = cmsTool("create_editor_token", "Create an editor token for restricted write access (no schema mutations). Optional expiresIn in seconds.", CreateEditorTokenMcpInput.fields);
const ListEditorTokensTool = cmsTool("list_editor_tokens", "List all non-expired editor tokens");
const RevokeEditorTokenTool = cmsTool("revoke_editor_token", "Revoke an editor token by its ID", TokenIdInput.fields);

const AdminTools = [
  ListModelsTool,
  DescribeModelTool,
  CreateModelTool,
  UpdateModelTool,
  CreateFieldTool,
  UpdateFieldTool,
  DeleteModelTool,
  DeleteFieldTool,
  SchemaInfoTool,
  CreateRecordTool,
  UpdateRecordTool,
  PatchBlocksTool,
  DeleteRecordTool,
  QueryRecordsTool,
  BulkCreateRecordsTool,
  PublishRecordTool,
  UnpublishRecordTool,
  ListRecordVersionsTool,
  GetRecordVersionTool,
  RestoreRecordVersionTool,
  ReorderRecordsTool,
  RemoveBlockTypeTool,
  RemoveBlockFromWhitelistTool,
  RemoveLocaleTool,
  BuildStructuredTextTool,
  UploadAssetTool,
  ImportAssetFromUrlTool,
  ListAssetsTool,
  ReplaceAssetTool,
  ExportSchemaTool,
  ImportSchemaTool,
  SearchContentTool,
  ReindexSearchTool,
  GetSiteSettingsTool,
  UpdateSiteSettingsTool,
  CreateEditorTokenTool,
  ListEditorTokensTool,
  RevokeEditorTokenTool,
];

const EditorTools = [
  ListModelsTool,
  DescribeModelTool,
  SchemaInfoTool,
  CreateRecordTool,
  UpdateRecordTool,
  PatchBlocksTool,
  DeleteRecordTool,
  QueryRecordsTool,
  BulkCreateRecordsTool,
  PublishRecordTool,
  UnpublishRecordTool,
  ListRecordVersionsTool,
  GetRecordVersionTool,
  RestoreRecordVersionTool,
  ReorderRecordsTool,
  BuildStructuredTextTool,
  UploadAssetTool,
  ImportAssetFromUrlTool,
  ListAssetsTool,
  ReplaceAssetTool,
  ExportSchemaTool,
  SearchContentTool,
  GetSiteSettingsTool,
  UpdateSiteSettingsTool,
] as const;

const CmsToolkit = Toolkit.make(...AdminTools);
const EditorToolkit = Toolkit.make(...EditorTools);

function createGuideResource() {
  return McpServer.resource({
    uri: "agent-cms://guide",
    name: "agent-cms-guide",
    description: "Orientation guide for agents: workflow, naming conventions, field formats, and lifecycle",
    mimeType: "text/plain",
    content: Effect.succeed(`agent-cms — Agent Orientation Guide

Workflow order:
  schema_info -> create_model -> create_field -> create_record -> publish_record

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
  - structured_text: {"value":{"schema":"dast","document":{...}},"blocks":{"<id>":{"_type":"block_api_key",...}}}
  - color: {"red":255,"green":0,"blue":0,"alpha":255}
  - lat_lon: {"latitude":64.13,"longitude":-21.89}

Draft/publish lifecycle:
  Records start as drafts. Call publish_record to make them visible in GraphQL.
  Edits after publishing create a new draft version — publish again to update.
  GraphQL serves published content by default; use X-Include-Drafts header for previews.

Asset upload flow:
  Preferred:
  1. Call import_asset_from_url with a public file URL
  2. Use returned asset ID in media/media_gallery fields

  Manual fallback:
  1. Upload file to R2 out of band
  2. Register with upload_asset tool (pass r2Key, filename, mimeType, dimensions)
  3. Use returned asset ID in media/media_gallery fields

Slug fields:
  Set validator {"slug_source": "title"} to auto-generate from a source field.
  Create the slug field AFTER the source field.

Pluralization:
  category -> allCategories, blog_post -> allBlogPosts, person -> allPeople
  Powered by standard English pluralization rules.`),
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
    parameters: SetupContentModelPromptInput,
    content: ({ description }) =>
      Effect.succeed(`Set up content models for: ${description}

Follow these steps:
1. Call schema_info to check existing models — avoid duplicates.
2. Design the models and fields needed. Consider:
   - Which are content models vs block types (for StructuredText embedding)?
   - Which fields need slug (add after the source field with slug_source validator)?
   - Which fields reference other models (link/links with item_item_type validator)?
   - Which fields need structured_text (with structured_text_blocks validator for allowed blocks)?
3. Present your plan before executing — list models, fields, and relationships.
4. Create models first, then fields in order (slug fields after their source).
5. Create a few sample records to verify the schema works.
6. Publish the sample records.
7. Show the GraphQL query that a frontend would use to fetch this content.
   Remember: api_key snake_case -> GraphQL camelCase fields, PascalCase types.`),
  });
}

function createGenerateGraphqlQueriesPrompt() {
  return McpServer.prompt({
    name: "generate-graphql-queries",
    description: "Generate GraphQL queries for a content model with proper naming conventions",
    parameters: GenerateGraphqlQueriesPromptInput,
    content: ({ modelApiKey }) =>
      Effect.succeed(`Generate GraphQL queries for the "${modelApiKey}" model.

Steps:
1. Call describe_model with apiKey "${modelApiKey}" to get the full field list.
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
  readonly fetch?: typeof globalThis.fetch;
  readonly actor?: RequestActor | null;
}

export function createMcpLayer(
  sqlLayer: Layer.Layer<SqlClient.SqlClient | VectorizeContext | HooksContext>,
  options?: CreateMcpLayerOptions,
){
  const mode = options?.mode ?? "admin";
  const path = options?.path ?? (mode === "editor" ? "/mcp/editor" : "/mcp");
  const toolkit = mode === "editor" ? EditorToolkit : CmsToolkit;
  const toolkitAny = toolkit as typeof CmsToolkit;
  const defaultVectorizeLayer: Layer.Layer<VectorizeContext> = Layer.succeed(VectorizeContext, Option.none());
  const defaultHooksLayer: Layer.Layer<HooksContext> = Layer.succeed(HooksContext, Option.none());
  const defaultAssetImportLayer: Layer.Layer<AssetImportContext> = Layer.succeed(AssetImportContext, {
    r2Bucket: options?.r2Bucket,
    fetch: options?.fetch ?? globalThis.fetch,
  });
  const fullLayer: Layer.Layer<SqlClient.SqlClient | VectorizeContext | HooksContext | AssetImportContext> = Layer.merge(
    Layer.merge(Layer.merge(defaultVectorizeLayer, defaultHooksLayer), defaultAssetImportLayer),
    sqlLayer,
  );
  const serverLayer = McpServer.layerHttpRouter({
    name: mode === "editor" ? "agent-cms-editor" : "agent-cms",
    version: "0.1.0",
    path: path as never,
  });

  const toolHandlers = {
    list_models: () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const models = yield* sql.unsafe<ModelRow>("SELECT * FROM models ORDER BY is_block, created_at");
        const fields = yield* sql.unsafe<FieldRow>("SELECT * FROM fields ORDER BY model_id, position");
        const fieldsByModel = new Map<string, Array<{ apiKey: string; label: string; type: string; localized: boolean }>>();
        for (const f of fields) {
          const list = fieldsByModel.get(f.model_id) ?? [];
          list.push({ apiKey: f.api_key, label: f.label, type: f.field_type, localized: !!f.localized });
          fieldsByModel.set(f.model_id, list);
        }
        return models.map((m) => ({
          id: m.id,
          name: m.name,
          apiKey: m.api_key,
          isBlock: !!m.is_block,
          singleton: !!m.singleton,
          fields: fieldsByModel.get(m.id) ?? [],
        }));
      }),
    describe_model: withDecoded(ApiKeyInput, ({ apiKey }) =>
      Effect.gen(function* () {
        const model = yield* ModelService.getModelByApiKey(apiKey);
        return {
          id: model.id,
          name: model.name,
          apiKey: model.api_key,
          isBlock: !!model.is_block,
          singleton: !!model.singleton,
          hasDraft: !!model.has_draft,
          fields: model.fields.map((f) => ({
            id: f.id,
            apiKey: f.api_key,
            label: f.label,
            type: f.field_type,
            localized: !!f.localized,
            validators: parseValidators(f.validators),
            hint: f.hint,
          })),
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
    schema_info: withDecoded(SchemaInfoInput, ({ filterByName, filterByType, includeFieldDetails }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        let modelQuery = "SELECT * FROM models";
        const conditions: string[] = [];
        const params: unknown[] = [];
        if (filterByType === "model") conditions.push("is_block = 0");
        if (filterByType === "block") conditions.push("is_block = 1");
        if (filterByName) {
          conditions.push("LOWER(name) LIKE ?");
          params.push(`%${filterByName.toLowerCase()}%`);
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
    create_record: withDecoded(CreateRecordInput, (input) => RecordService.createRecord(input, options?.actor)),
    update_record: withDecoded(UpdateRecordInput, ({ recordId, modelApiKey, data }) => RecordService.patchRecord(recordId, { modelApiKey, data }, options?.actor)),
    patch_blocks: withDecoded(PatchBlocksInput, (input) => RecordService.patchBlocksForField(input, options?.actor)),
    delete_record: withDecoded(DeleteRecordInput, ({ recordId, modelApiKey }) => RecordService.removeRecord(modelApiKey, recordId)),
    query_records: withDecoded(QueryRecordsInput, ({ modelApiKey }) => RecordService.listRecords(modelApiKey)),
    bulk_create_records: withDecoded(BulkCreateRecordsInput, ({ modelApiKey, records }) => RecordService.bulkCreateRecords({ modelApiKey, records }, options?.actor)),
    publish_record: withDecoded(PublishRecordInput, ({ recordId, modelApiKey }) => PublishService.publishRecord(modelApiKey, recordId, options?.actor)),
    unpublish_record: withDecoded(PublishRecordInput, ({ recordId, modelApiKey }) => PublishService.unpublishRecord(modelApiKey, recordId, options?.actor)),
    list_record_versions: withDecoded(PublishRecordInput, ({ modelApiKey, recordId }) => VersionService.listVersions(modelApiKey, recordId)),
    get_record_version: withDecoded(VersionIdInput, ({ versionId }) => VersionService.getVersion(versionId)),
    restore_record_version: withDecoded(RestoreVersionInput, ({ modelApiKey, recordId, versionId }) => VersionService.restoreVersion(modelApiKey, recordId, versionId, options?.actor)),
    reorder_records: withDecoded(ReorderInput, ({ modelApiKey, recordIds }) => RecordService.reorderRecords(modelApiKey, recordIds, options?.actor)),
    remove_block_type: withDecoded(RemoveBlockTypeInput, ({ blockApiKey }) => SchemaLifecycle.removeBlockType(blockApiKey)),
    remove_block_from_whitelist: withDecoded(RemoveBlockFromWhitelistInput, ({ fieldId, blockApiKey }) => SchemaLifecycle.removeBlockFromWhitelist({ fieldId, blockApiKey })),
    remove_locale: withDecoded(LocaleIdInput, ({ localeId }) => SchemaLifecycle.removeLocale(localeId)),
    build_structured_text: withDecoded(BuildStructuredTextInput, ({ paragraphs, blocks }) =>
      Effect.promise(async () => {
        const { ulid } = await import("ulidx");
        const safeParagraphs = paragraphs ?? [];
        const safeBlocks = blocks ?? [];
        const children: unknown[] = [];
        const blockMap: Record<string, unknown> = {};
        let blockIdx = 0;
        for (const text of safeParagraphs) {
          children.push({
            type: "paragraph",
            children: [{ type: "span", value: text }],
          });
          if (blockIdx < safeBlocks.length) {
            const b = safeBlocks[blockIdx];
            const id = ulid();
            children.push({ type: "block", item: id });
            blockMap[id] = { _type: b.type, ...b.data };
            blockIdx++;
          }
        }
        while (blockIdx < safeBlocks.length) {
          const b = safeBlocks[blockIdx];
          const id = ulid();
          children.push({ type: "block", item: id });
          blockMap[id] = { _type: b.type, ...b.data };
          blockIdx++;
        }
        return {
          value: { schema: "dast", document: { type: "root", children } },
          blocks: blockMap,
        };
      })),
    upload_asset: withDecoded(AssetInput, (input) => AssetService.createAsset(input, options?.actor)),
    import_asset_from_url: withDecoded(ImportAssetFromUrlInput, (input) => AssetService.importAssetFromUrl(input, options?.actor)),
    list_assets: () => AssetService.listAssets(),
    replace_asset: withDecoded(ReplaceAssetInput, ({ assetId, ...rest }) => AssetService.replaceAsset(assetId, rest, options?.actor)),
    export_schema: () => SchemaIO.exportSchema(),
    import_schema: withDecoded(ImportSchemaToolInput, ({ schema }) => SchemaIO.importSchema(schema)),
    search_content: withDecoded(SearchContentInput, SearchService.search),
    reindex_search: withDecoded(ReindexSearchInput, ({ modelApiKey }) => SearchService.reindexAll(modelApiKey)),
    get_site_settings: () => SiteSettingsService.getSiteSettings(),
    update_site_settings: withDecoded(UpdateSiteSettingsInput, SiteSettingsService.updateSiteSettings),
    create_editor_token: withDecoded(CreateEditorTokenMcpInput, TokenService.createEditorToken),
    list_editor_tokens: () => TokenService.listEditorTokens(),
    revoke_editor_token: withDecoded(TokenIdInput, ({ tokenId }) => TokenService.revokeEditorToken(tokenId)),
  } as const;

  const toolkitHandlers = toolkitAny.toLayer(pickToolkitHandlers(toolkitAny, toolHandlers) as never);

  const toolkitRegistration = Layer.effectDiscard(Effect.gen(function* () {
    const registry = yield* McpServer.McpServer;
    const built = yield* toolkitAny;
    const context = yield* Effect.context();

    for (const tool of Object.values(built.tools)) {
      const mcpTool = new McpSchema.Tool({
        name: tool.name,
        description: tool.description,
        inputSchema: toMcpInputSchema(tool),
        annotations: new McpSchema.ToolAnnotations({
          ...Context.getOption(tool.annotations, AiTool.Title).pipe(Option.map((title) => ({ title })), Option.getOrUndefined),
          readOnlyHint: Context.get(tool.annotations, AiTool.Readonly),
          destructiveHint: Context.get(tool.annotations, AiTool.Destructive),
          idempotentHint: Context.get(tool.annotations, AiTool.Idempotent),
          openWorldHint: Context.get(tool.annotations, AiTool.OpenWorld),
        }),
      });

      yield* registry.addTool({
        tool: mcpTool,
        handle(payload) {
          const params = isToolPayload(payload) ? payload : {};
          return built.handle(tool.name as never, params as never).pipe(
            Effect.provide(context),
            Effect.match({
              onFailure: (error) =>
                new McpSchema.CallToolResult({
                  isError: true,
                  structuredContent: toStructuredContent(error),
                  content: [{ type: "text", text: encodeJson(error) }],
                }),
              onSuccess: (result: { encodedResult: unknown }) =>
                new McpSchema.CallToolResult({
                  isError: false,
                  structuredContent: toStructuredContent(result.encodedResult),
                  content: [{ type: "text", text: encodeJson(result.encodedResult) }],
                }),
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
