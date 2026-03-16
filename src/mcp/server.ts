/**
 * MCP (Model Context Protocol) server for agent-cms.
 * 3-layer architecture: Discovery → Schema → Content
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Effect, Layer } from "effect";
import { SqlClient } from "@effect/sql";
import { z } from "zod";
import * as ModelService from "../services/model-service.js";
import * as FieldService from "../services/field-service.js";
import * as RecordService from "../services/record-service.js";
import * as PublishService from "../services/publish-service.js";
import * as AssetService from "../services/asset-service.js";
import * as WebhookService from "../services/webhook-service.js";
import * as SchemaLifecycle from "../services/schema-lifecycle.js";
import * as SchemaIO from "../services/schema-io.js";
import * as SearchService from "../search/search-service.js";
import { isCmsError } from "../errors.js";
import type { ModelRow, FieldRow, LocaleRow } from "../db/row-types.js";

export function createMcpServer(sqlLayer: Layer.Layer<SqlClient.SqlClient>) {
  const server = new McpServer({
    name: "agent-cms",
    version: "0.1.0",
  });

  function run<A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>): Promise<{
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
        Effect.provide(sqlLayer)
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
    },
    async (args) => run(ModelService.createModel(args))
  );

  server.tool("update_model", "Update model properties (name, apiKey, singleton, sortable)",
    {
      modelId: z.string(),
      name: z.string().optional(),
      apiKey: z.string().optional(),
      singleton: z.boolean().optional(),
      sortable: z.boolean().optional(),
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
      const blockMap: Record<string, any> = {};

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
    `Register an asset after uploading the file to R2 via wrangler CLI.

Upload flow:
1. Tell the user to run: wrangler r2 object put <bucket>/uploads/<filename> --file=<local-path> --content-type=<mime-type>
2. Call this tool with the r2Key, filename, mimeType, and image dimensions
3. The asset is registered and can be referenced in media fields by its ID

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
    `Replace an asset's file while keeping the same ID and URL. All content references remain stable.

Flow:
1. Upload new file to R2: wrangler r2 object put <bucket>/uploads/<new-filename> --file=<path>
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

  // --- Webhooks ---

  server.tool("create_webhook", "Register a webhook URL for CMS events",
    {
      url: z.string().describe("URL to POST to"),
      events: z.array(z.string()).describe("Events: record.create, record.update, record.delete, record.publish, record.unpublish, model.create, model.delete"),
      name: z.string().optional().describe("Optional descriptive name"),
    },
    async (args) => run(WebhookService.createWebhook(args))
  );

  server.tool("list_webhooks", "List all registered webhooks", {},
    async () => run(WebhookService.listWebhooks())
  );

  server.tool("delete_webhook", "Delete a webhook",
    { webhookId: z.string() },
    async ({ webhookId }) => run(WebhookService.deleteWebhook(webhookId))
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

  return server;
}
