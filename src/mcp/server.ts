/**
 * MCP (Model Context Protocol) server for agent-cms.
 * 3-layer architecture: Discovery → Schema → Content
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "@effect/sql";
import { z } from "zod";
import * as ModelService from "../services/model-service.js";
import * as FieldService from "../services/field-service.js";
import * as RecordService from "../services/record-service.js";
import * as PublishService from "../services/publish-service.js";
import * as AssetService from "../services/asset-service.js";
import * as VersionService from "../services/version-service.js";
import * as SchemaLifecycle from "../services/schema-lifecycle.js";
import * as SchemaIO from "../services/schema-io.js";
import * as SearchService from "../search/search-service.js";
import { isCmsError } from "../errors.js";
import type { ModelRow, FieldRow, LocaleRow } from "../db/row-types.js";
import { VectorizeContext } from "../search/vectorize-context.js";
import { HooksContext } from "../hooks.js";

export function createMcpServer(sqlLayer: Layer.Layer<SqlClient.SqlClient | VectorizeContext | HooksContext>) {
  // Ensure optional contexts are always available (defaults to Option.none())
  const defaultVectorizeLayer = Layer.succeed(VectorizeContext, Option.none());
  const defaultHooksLayer = Layer.succeed(HooksContext, Option.none());
  const fullLayer = Layer.merge(Layer.merge(defaultVectorizeLayer, defaultHooksLayer), sqlLayer);

  const server = new McpServer({
    name: "agent-cms",
    version: "0.1.0",
  });

  function run<A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient | VectorizeContext | HooksContext>): Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }> {
    return Effect.runPromise(
      effect.pipe(
        Effect.map((result) => ({
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        })),
        Effect.catchAll((error: unknown) => {
          const errorInfo: Record<string, unknown> = {};
          if (isCmsError(error)) {
            errorInfo.type = error._tag;
            errorInfo.message = error.message;
          } else if (error instanceof Error) {
            errorInfo.message = error.message;
          } else {
            errorInfo.message = String(error);
          }
          // Add guidance for common errors
          if (errorInfo.message && typeof errorInfo.message === "string") {
            if (errorInfo.message.includes("UNIQUE constraint"))
              errorInfo.hint = "This resource already exists. Use list_models or schema_info to see current state.";
            if (errorInfo.message.includes("not found") || errorInfo.message.includes("NOT NULL"))
              errorInfo.hint = "Check the ID/apiKey. Use list_models to find valid values.";
            if (errorInfo.message.includes("referenced"))
              errorInfo.hint = "This resource is referenced by other models. Remove references first.";
          }
          return Effect.succeed({
            content: [{ type: "text" as const, text: JSON.stringify(errorInfo) }],
            isError: true,
          });
        }),
        Effect.provide(fullLayer)
      )
    );
  }

  // --- Discovery ---

  server.tool("list_models", "List all content models and block types with their fields", {},
    async () => run(
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
          id: m.id, name: m.name, apiKey: m.api_key,
          isBlock: !!m.is_block, singleton: !!m.singleton,
          fields: fieldsByModel.get(m.id) ?? [],
        }));
      })
    )
  );

  server.tool("describe_model", "Get detailed info about a model",
    { apiKey: z.string().describe("The model's api_key") },
    async ({ apiKey }) => run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const models = yield* sql.unsafe<ModelRow>("SELECT * FROM models WHERE api_key = ?", [apiKey]);
        if (models.length === 0) return { error: `Model '${apiKey}' not found` };
        const model = models[0];
        const fields = yield* sql.unsafe<FieldRow>("SELECT * FROM fields WHERE model_id = ? ORDER BY position", [model.id]);
        return {
          id: model.id, name: model.name, apiKey: model.api_key,
          isBlock: !!model.is_block, singleton: !!model.singleton, hasDraft: !!model.has_draft,
          fields: fields.map((f) => ({
            id: f.id, apiKey: f.api_key, label: f.label, type: f.field_type,
            localized: !!f.localized, validators: JSON.parse(f.validators || "{}"), hint: f.hint,
          })),
        };
      })
    )
  );

  // --- Schema ---

  server.tool("create_model", "Create a content model or block type. Use isBlock:true for block types (embeddable in StructuredText). Use singleton:true for models with exactly one record (e.g. site settings). After creating a model, add fields with create_field.",
    {
      name: z.string().describe("Human-readable name (e.g. 'Blog Post')"),
      apiKey: z.string().describe("Snake_case identifier used in code (e.g. 'blog_post')"),
      isBlock: z.boolean().optional().describe("true = block type for StructuredText embedding"),
      singleton: z.boolean().optional().describe("true = only one record allowed (e.g. site settings)"),
      allLocalesRequired: z.boolean().optional().describe("true = records must have values for all project locales on localized fields"),
    },
    async (args) => run(ModelService.createModel(args))
  );

  server.tool("update_model", "Update model properties (name, apiKey, singleton, sortable, hasDraft, allLocalesRequired)",
    {
      modelId: z.string(),
      name: z.string().optional(),
      apiKey: z.string().optional(),
      singleton: z.boolean().optional(),
      sortable: z.boolean().optional(),
      hasDraft: z.boolean().optional().describe("Enable draft/published system. When disabled, records auto-publish on create/edit."),
      allLocalesRequired: z.boolean().optional().describe("Require all project locales on localized fields"),
    },
    async ({ modelId, ...rest }) => run(ModelService.updateModel(modelId, rest))
  );

  server.tool("create_field", `Add a field to a model. Auto-migrates the database table (adds column).

Key validators by field type:
- slug: {"slug_source": "title"} — auto-generates from source field
- link: {"item_item_type": ["model_api_key"]} — target model
- links: {"items_item_type": ["model_api_key"]} — target model
- structured_text: {"structured_text_blocks": ["block_api_key"]} — allowed block types
- any field: {"required": true} — field is required (provide default_value for existing records)`,
    {
      modelId: z.string().describe("ID of the model (from create_model response)"),
      label: z.string().describe("Human-readable label (e.g. 'Cover Image')"),
      apiKey: z.string().describe("Snake_case field name used in code (e.g. 'cover_image')"),
      fieldType: z.string().describe("string|text|boolean|integer|float|date|date_time|slug|media|media_gallery|link|links|structured_text|seo|json|color|lat_lon"),
      localized: z.boolean().optional(),
      validators: z.record(z.string(), z.unknown()).optional().describe("Validation rules — see tool description for common patterns"),
      defaultValue: z.unknown().optional().describe("Default value for existing records when adding a required field"),
    },
    async ({ modelId, ...rest }) => run(FieldService.createField(modelId, rest))
  );

  server.tool("update_field", "Update field properties (label, apiKey, validators, hint)",
    {
      fieldId: z.string(),
      label: z.string().optional(),
      apiKey: z.string().optional(),
      validators: z.record(z.string(), z.unknown()).optional(),
      hint: z.string().optional(),
    },
    async ({ fieldId, ...rest }) => run(FieldService.updateField(fieldId, rest))
  );

  server.tool("delete_model", "Delete a model (fails if referenced)",
    { modelId: z.string() },
    async ({ modelId }) => run(ModelService.deleteModel(modelId))
  );

  server.tool("delete_field", "Delete a field and drop column",
    { fieldId: z.string() },
    async ({ fieldId }) => run(FieldService.deleteField(fieldId))
  );

  // --- Schema Info (power tool) ---

  server.tool("schema_info", "Get the complete CMS schema in one call — models, block types, fields, relations. The primary tool for understanding the content model.",
    {
      filterByName: z.string().optional().describe("Filter models/blocks by name (case-insensitive substring match)"),
      filterByType: z.enum(["model", "block"]).optional().describe("Only return models or only blocks"),
      includeFieldDetails: z.boolean().optional().describe("Include full field definitions with validators (default: true)"),
    },
    async ({ filterByName, filterByType, includeFieldDetails = true }) => run(
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
              ...(includeFieldDetails ? {
                fields: mFields.map((f) => ({
                  id: f.id,
                  label: f.label,
                  apiKey: f.api_key,
                  type: f.field_type,
                  localized: !!f.localized,
                  validators: JSON.parse(f.validators || "{}"),
                  hint: f.hint,
                })),
              } : {
                fieldCount: mFields.length,
                fieldNames: mFields.map((f) => f.api_key),
              }),
            };
          }),
        };
      })
    )
  );

  // --- Content ---

  server.tool("create_record", `Create a content record. Records start as draft — call publish_record to make them visible in GraphQL.

Field value formats:
- media: asset ID string (from upload_asset)
- media_gallery: array of asset ID strings
- link: record ID string
- links: array of record ID strings
- seo: {"title":"...","description":"...","image":"<asset_id>","twitterCard":"summary_large_image"}
- structured_text: {"value":{"schema":"dast","document":{...}},"blocks":{"<id>":{"_type":"block_api_key",...}}}
- color: {"red":255,"green":0,"blue":0,"alpha":255}
- lat_lon: {"latitude":64.13,"longitude":-21.89}`,
    { modelApiKey: z.string().describe("The model's api_key"), data: z.record(z.string(), z.unknown()).describe("Field values keyed by field api_key") },
    async (args) => run(RecordService.createRecord(args))
  );

  server.tool("update_record", "Update record fields",
    { recordId: z.string(), modelApiKey: z.string(), data: z.record(z.string(), z.unknown()) },
    async ({ recordId, modelApiKey, data }) =>
      run(RecordService.patchRecord(recordId, { modelApiKey, data }))
  );

  server.tool("delete_record", "Delete a record",
    { recordId: z.string(), modelApiKey: z.string() },
    async ({ recordId, modelApiKey }) => run(RecordService.removeRecord(modelApiKey, recordId))
  );

  server.tool("query_records", "List records for a model",
    { modelApiKey: z.string() },
    async ({ modelApiKey }) => run(RecordService.listRecords(modelApiKey))
  );

  server.tool("bulk_create_records", `Create multiple records in one operation (up to 1000). Much faster than calling create_record in a loop.

All records must belong to the same model. Slugs are auto-generated. Returns array of created record IDs.`,
    {
      modelApiKey: z.string().describe("The model's api_key"),
      records: z.array(z.record(z.string(), z.unknown())).describe("Array of record data objects (field values keyed by api_key)"),
    },
    async ({ modelApiKey, records }) => run(RecordService.bulkCreateRecords({ modelApiKey, records }))
  );

  server.tool("publish_record", "Publish a record",
    { recordId: z.string(), modelApiKey: z.string() },
    async ({ recordId, modelApiKey }) => run(PublishService.publishRecord(modelApiKey, recordId))
  );

  server.tool("unpublish_record", "Unpublish a record",
    { recordId: z.string(), modelApiKey: z.string() },
    async ({ recordId, modelApiKey }) => run(PublishService.unpublishRecord(modelApiKey, recordId))
  );

  // --- Versions ---

  server.tool("list_record_versions", "List all version snapshots for a record, newest first. Versions are created on each publish or auto-republish.",
    {
      modelApiKey: z.string().describe("The model's api_key"),
      recordId: z.string().describe("The record ID"),
    },
    async ({ modelApiKey, recordId }) => run(VersionService.listVersions(modelApiKey, recordId))
  );

  server.tool("get_record_version", "Get a specific version snapshot by version ID",
    { versionId: z.string().describe("The version ID") },
    async ({ versionId }) => run(VersionService.getVersion(versionId))
  );

  server.tool("restore_record_version", "Restore a record to a previous version. The current state is versioned first, so restore is always reversible. For has_draft models, the record returns to draft status (needs re-publish). For non-draft models, the record is auto-republished.",
    {
      modelApiKey: z.string().describe("The model's api_key"),
      recordId: z.string().describe("The record ID"),
      versionId: z.string().describe("The version ID to restore"),
    },
    async ({ modelApiKey, recordId, versionId }) => run(VersionService.restoreVersion(modelApiKey, recordId, versionId))
  );

  server.tool("reorder_records", "Reorder records in a sortable/tree model by providing ordered record IDs",
    {
      modelApiKey: z.string(),
      recordIds: z.array(z.string()).describe("Ordered array of record IDs — position = array index"),
    },
    async ({ modelApiKey, recordIds }) => run(RecordService.reorderRecords(modelApiKey, recordIds))
  );

  // --- Schema Lifecycle ---

  server.tool("remove_block_type", "Remove a block type: cleans DAST trees, deletes blocks, drops table",
    { blockApiKey: z.string().describe("API key of the block type to remove") },
    async ({ blockApiKey }) => run(SchemaLifecycle.removeBlockType(blockApiKey))
  );

  server.tool("remove_block_from_whitelist", "Remove a block type from a field's whitelist and clean affected DAST trees",
    { fieldId: z.string(), blockApiKey: z.string() },
    async ({ fieldId, blockApiKey }) => run(SchemaLifecycle.removeBlockFromWhitelist({ fieldId, blockApiKey }))
  );

  server.tool("remove_locale", "Remove a locale and strip it from all localized field values",
    { localeId: z.string() },
    async ({ localeId }) => run(SchemaLifecycle.removeLocale(localeId))
  );

  // --- StructuredText Helper ---

  server.tool("build_structured_text", "Build a valid StructuredText value from prose and blocks. Auto-assigns ULIDs to blocks.",
    {
      paragraphs: z.array(z.string()).optional().describe("Text paragraphs to include"),
      blocks: z.array(z.object({
        type: z.string().describe("Block type api_key"),
        data: z.record(z.string(), z.unknown()).describe("Block field values"),
      })).optional().describe("Blocks to embed between paragraphs"),
    },
    async ({ paragraphs = [], blocks = [] }) => {
      const { ulid } = await import("ulidx");

      const children: unknown[] = [];
      const blockMap: Record<string, unknown> = {};

      // Interleave paragraphs and blocks
      let blockIdx = 0;
      for (const text of paragraphs) {
        children.push({
          type: "paragraph",
          children: [{ type: "span", value: text }],
        });
        // Insert next block after each paragraph if available
        if (blockIdx < blocks.length) {
          const b = blocks[blockIdx];
          const id = ulid();
          children.push({ type: "block", item: id });
          blockMap[id] = { _type: b.type, ...b.data };
          blockIdx++;
        }
      }
      // Append remaining blocks
      while (blockIdx < blocks.length) {
        const b = blocks[blockIdx];
        const id = ulid();
        children.push({ type: "block", item: id });
        blockMap[id] = { _type: b.type, ...b.data };
        blockIdx++;
      }

      const result = {
        value: { schema: "dast", document: { type: "root", children } },
        blocks: blockMap,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // --- Assets ---

  server.tool("upload_asset",
    `Register an asset after uploading the original file to R2 out of band.

Upload flow:
1. Upload the original file to R2 (for local dev this is usually: wrangler r2 object put <bucket>/uploads/<filename> --file=<local-path> --content-type=<mime-type>)
2. Call this tool with the r2Key, filename, mimeType, and image dimensions
3. The asset metadata is registered and can be referenced in media fields by its ID

Example r2Key: "uploads/hero.jpg"`,
    {
      filename: z.string().describe("Original filename (e.g. hero.jpg)"),
      mimeType: z.string().describe("MIME type (e.g. image/jpeg)"),
      r2Key: z.string().describe("R2 object key used in wrangler r2 object put (e.g. uploads/hero.jpg)"),
      size: z.number().optional().describe("File size in bytes"),
      width: z.number().optional().describe("Image width in pixels"),
      height: z.number().optional().describe("Image height in pixels"),
      alt: z.string().optional().describe("Alt text for accessibility"),
      title: z.string().optional().describe("Image title"),
    },
    async (args) => run(AssetService.createAsset(args))
  );

  server.tool("list_assets", "List all assets with their IDs, filenames, and R2 keys",
    {},
    async () => run(AssetService.listAssets())
  );

  server.tool("replace_asset",
    `Replace an asset's file metadata while keeping the same ID and URL. All content references remain stable.

Flow:
1. Upload the new original file to R2
2. Call this tool with the asset ID and new file metadata
3. The asset URL stays the same — no broken links in content`,
    {
      assetId: z.string().describe("ID of the existing asset to replace"),
      filename: z.string().describe("New filename"),
      mimeType: z.string().describe("New MIME type"),
      r2Key: z.string().describe("New R2 object key"),
      size: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
    },
    async ({ assetId, ...rest }) => run(AssetService.replaceAsset(assetId, rest))
  );

  // --- Schema Import/Export ---

  server.tool("export_schema", "Export the full CMS schema (models, fields, locales) as portable JSON. No IDs — references use api_keys. Use import_schema to restore on a fresh CMS.",
    {},
    async () => run(SchemaIO.exportSchema())
  );

  server.tool("import_schema", `Import a CMS schema from JSON. Creates all locales, models, and fields in dependency order. Use on a fresh/empty CMS.

The schema format matches export_schema output:
{ "version": 1, "locales": [...], "models": [{ "name", "apiKey", "fields": [...] }] }`,
    { schema: z.record(z.string(), z.unknown()).describe("The schema JSON object (from export_schema output)") },
    async ({ schema }) => run(SchemaIO.importSchema(schema))
  );

  // --- Search ---

  server.tool("search_content",
    `Search content records. Supports keyword search (FTS5), semantic search (Vectorize), or hybrid (both combined with rank fusion).

Keyword mode: phrases ("exact match"), prefix (word*), boolean (AND/OR).
Semantic mode: finds conceptually related content even when vocabulary differs (requires AI+Vectorize bindings).
Hybrid mode (default when Vectorize available): combines both for best results.`,
    {
      query: z.string().describe("Search query"),
      modelApiKey: z.string().optional().describe("Scope to a specific model"),
      first: z.number().optional().describe("Max results (default 10, max 100)"),
      skip: z.number().optional().describe("Pagination offset"),
      mode: z.enum(["keyword", "semantic", "hybrid"]).optional().describe("Search mode (default: hybrid if Vectorize available, otherwise keyword)"),
    },
    async (args) => run(SearchService.search(args))
  );

  server.tool("reindex_search",
    "Rebuild FTS5 + Vectorize search indexes. Use after deploying search to a CMS with existing content, or to recover from index drift. Scoped to a single model or all content models.",
    {
      modelApiKey: z.string().optional().describe("Reindex a specific model (omit for all content models)"),
    },
    async (args) => run(SearchService.reindexAll(args.modelApiKey))
  );

  // --- Site Settings ---

  server.tool("get_site_settings", "Get global site settings (site name, title suffix, global SEO, favicon, social accounts)", {},
    async () => run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql.unsafe<Record<string, unknown>>("SELECT * FROM site_settings LIMIT 1");
        return rows.length > 0 ? rows[0] : { message: "No site settings configured yet. Use update_site_settings to create them." };
      }).pipe(
        Effect.catchAll(() => Effect.succeed({ message: "site_settings table not found. Run migration 0002 first." }))
      )
    )
  );

  server.tool("update_site_settings", `Update global site settings. These power the _site GraphQL query (globalSeo, faviconMetaTags).

Fields:
- siteName: Site name shown in meta tags
- titleSuffix: Appended to page titles (e.g. " | My Site")
- noIndex: If true, adds noindex meta tag
- faviconId: Asset ID for the favicon
- facebookPageUrl: Facebook page URL
- twitterAccount: Twitter handle (e.g. "@mysite")
- fallbackSeoTitle/Description/ImageId/TwitterCard: Default SEO when records don't have their own`,
    {
      siteName: z.string().optional(),
      titleSuffix: z.string().optional(),
      noIndex: z.boolean().optional(),
      faviconId: z.string().optional(),
      facebookPageUrl: z.string().optional(),
      twitterAccount: z.string().optional(),
      fallbackSeoTitle: z.string().optional(),
      fallbackSeoDescription: z.string().optional(),
      fallbackSeoImageId: z.string().optional(),
      fallbackSeoTwitterCard: z.string().optional(),
    },
    async (args) => run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const sets: string[] = [];
        const params: unknown[] = [];
        const fieldMap: Record<string, string> = {
          siteName: "site_name", titleSuffix: "title_suffix", noIndex: "no_index",
          faviconId: "favicon_id", facebookPageUrl: "facebook_page_url",
          twitterAccount: "twitter_account", fallbackSeoTitle: "fallback_seo_title",
          fallbackSeoDescription: "fallback_seo_description", fallbackSeoImageId: "fallback_seo_image_id",
          fallbackSeoTwitterCard: "fallback_seo_twitter_card",
        };
        for (const [key, value] of Object.entries(args)) {
          const col = fieldMap[key];
          if (col && value !== undefined) {
            sets.push(`"${col}" = ?`);
            params.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
          }
        }
        if (sets.length === 0) return { error: "No fields to update" };
        sets.push(`"updated_at" = datetime('now')`);

        // Upsert: insert default row if none exists, then update
        yield* sql.unsafe(`INSERT OR IGNORE INTO site_settings (id) VALUES ('default')`);
        yield* sql.unsafe(`UPDATE site_settings SET ${sets.join(", ")} WHERE id = 'default'`, params);

        const rows = yield* sql.unsafe<Record<string, unknown>>("SELECT * FROM site_settings WHERE id = 'default'");
        return rows[0];
      })
    )
  );

  // --- Resources ---

  server.resource(
    "agent-cms-guide",
    "agent-cms://guide",
    { description: "Orientation guide for agents: workflow, naming conventions, field formats, and lifecycle" },
    async () => ({
      contents: [{
        uri: "agent-cms://guide",
        mimeType: "text/plain",
        text: `agent-cms — Agent Orientation Guide

Workflow order:
  schema_info → create_model → create_field → create_record → publish_record

Naming conventions:
  - api_key: snake_case (e.g. blog_post, cover_image)
  - GraphQL types: PascalCase (BlogPost, CoverImageRecord)
  - GraphQL fields: camelCase (coverImage, blogPost)
  - GraphQL list queries: allBlogPosts, allCategories
  - GraphQL single queries: blogPost, category
  - Block types get "Record" suffix in GraphQL: code_block → CodeBlockRecord

Field value formats (composite types):
  - media: asset ID string (from upload_asset)
  - media_gallery: array of asset ID strings
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
  1. Upload file to R2: wrangler r2 object put <bucket>/uploads/<filename> --file=<path>
  2. Register with upload_asset tool (pass r2Key, filename, mimeType, dimensions)
  3. Use returned asset ID in media/media_gallery fields

Slug fields:
  Set validator {"slug_source": "title"} to auto-generate from a source field.
  Create the slug field AFTER the source field.

Pluralization:
  category → allCategories, blog_post → allBlogPosts, person → allPeople
  Powered by standard English pluralization rules.`,
      }],
    })
  );

  server.resource(
    "agent-cms-schema",
    "agent-cms://schema",
    { description: "Current CMS schema: models, fields, and locales as JSON" },
    async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
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
          return {
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
                validators: JSON.parse(f.validators || "{}"),
              })),
            })),
          };
        }).pipe(Effect.provide(fullLayer))
      );
      return {
        contents: [{
          uri: "agent-cms://schema",
          mimeType: "application/json",
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );

  // --- Prompts ---

  server.prompt(
    "setup-content-model",
    "Guide an agent through designing and creating content models from a description",
    { description: z.string().describe("What kind of content to model (e.g. 'blog posts with categories and tags')") },
    async ({ description }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Set up content models for: ${description}

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
   Remember: api_key snake_case → GraphQL camelCase fields, PascalCase types.`,
        },
      }],
    })
  );

  server.prompt(
    "generate-graphql-queries",
    "Generate GraphQL queries for a content model with proper naming conventions",
    { modelApiKey: z.string().describe("The model's api_key (e.g. 'blog_post')") },
    async ({ modelApiKey }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Generate GraphQL queries for the "${modelApiKey}" model.

Steps:
1. Call describe_model with apiKey "${modelApiKey}" to get the full field list.
2. Map field names from snake_case (api_key) to camelCase (GraphQL).
3. Generate these queries:
   a. List query: all_<pluralized> with pagination, filtering, and ordering
   b. Single query: <model_api_key> by ID or filter
   c. Meta query: _all_<pluralized>_meta for total count
4. For each field type, use the right GraphQL fragment:
   - media → { url width height alt title }
   - structured_text → { value blocks { ... on <BlockType>Record { id <fields> } } }
   - link → { id <fields of target model> }
   - links → same as link but array
   - seo → { title description image { url } twitterCard }
   - color → { red green blue alpha hex }
   - lat_lon → { latitude longitude }
5. Include both a "full" query with all fields and a "list" query with essential fields only.`,
        },
      }],
    })
  );

  return server;
}
