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
import * as SchemaLifecycle from "../services/schema-lifecycle.js";
import type { CmsError } from "../errors.js";

export function createMcpServer(sqlLayer: Layer.Layer<SqlClient.SqlClient>) {
  const server = new McpServer({
    name: "agent-cms",
    version: "0.1.0",
  });

  function run<A>(effect: Effect.Effect<A, CmsError | any, SqlClient.SqlClient>): Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }> {
    return Effect.runPromise(
      effect.pipe(
        Effect.map((result) => ({
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        })),
        Effect.catchAll((error) => {
          const message = error && typeof error === "object" && "message" in error
            ? String(error.message)
            : String(error);
          return Effect.succeed({
            content: [{ type: "text" as const, text: `Error: ${message}` }],
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
        const models = yield* sql.unsafe<Record<string, any>>("SELECT * FROM models ORDER BY is_block, created_at");
        const fields = yield* sql.unsafe<Record<string, any>>("SELECT * FROM fields ORDER BY model_id, position");
        const fieldsByModel = new Map<string, any[]>();
        for (const f of fields) {
          const list = fieldsByModel.get(f.model_id) ?? [];
          list.push({ apiKey: f.api_key, label: f.label, type: f.field_type, localized: !!f.localized });
          fieldsByModel.set(f.model_id, list);
        }
        return models.map((m: any) => ({
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
        const models = yield* sql.unsafe<Record<string, any>>("SELECT * FROM models WHERE api_key = ?", [apiKey]);
        if (models.length === 0) return { error: `Model '${apiKey}' not found` };
        const model = models[0];
        const fields = yield* sql.unsafe<Record<string, any>>("SELECT * FROM fields WHERE model_id = ? ORDER BY position", [model.id]);
        return {
          id: model.id, name: model.name, apiKey: model.api_key,
          isBlock: !!model.is_block, singleton: !!model.singleton, hasDraft: !!model.has_draft,
          fields: fields.map((f: any) => ({
            id: f.id, apiKey: f.api_key, label: f.label, type: f.field_type,
            localized: !!f.localized, validators: JSON.parse(f.validators || "{}"), hint: f.hint,
          })),
        };
      })
    )
  );

  // --- Schema ---

  server.tool("create_model", "Create a content model or block type",
    {
      name: z.string(), apiKey: z.string(),
      isBlock: z.boolean().optional(), singleton: z.boolean().optional(),
    },
    async (args) => run(ModelService.createModel(args))
  );

  server.tool("create_field", "Add a field to a model",
    {
      modelId: z.string(), label: z.string(), apiKey: z.string(),
      fieldType: z.string().describe("string|text|boolean|integer|slug|media|media_gallery|link|links|structured_text"),
      localized: z.boolean().optional(),
      validators: z.record(z.string(), z.unknown()).optional(),
    },
    async ({ modelId, ...rest }) => run(FieldService.createField(modelId, rest))
  );

  server.tool("delete_model", "Delete a model (fails if referenced)",
    { modelId: z.string() },
    async ({ modelId }) => run(ModelService.deleteModel(modelId))
  );

  server.tool("delete_field", "Delete a field and drop column",
    { fieldId: z.string() },
    async ({ fieldId }) => run(FieldService.deleteField(fieldId))
  );

  // --- Content ---

  server.tool("create_record", "Create a content record",
    { modelApiKey: z.string(), data: z.record(z.string(), z.unknown()) },
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

  server.tool("publish_record", "Publish a record",
    { recordId: z.string(), modelApiKey: z.string() },
    async ({ recordId, modelApiKey }) => run(PublishService.publishRecord(modelApiKey, recordId))
  );

  server.tool("unpublish_record", "Unpublish a record",
    { recordId: z.string(), modelApiKey: z.string() },
    async ({ recordId, modelApiKey }) => run(PublishService.unpublishRecord(modelApiKey, recordId))
  );

  // --- Schema Lifecycle ---

  server.tool("remove_block_type", "Remove a block type: cleans DAST trees, deletes blocks, drops table",
    { blockApiKey: z.string().describe("API key of the block type to remove") },
    async ({ blockApiKey }) => run(SchemaLifecycle.removeBlockType(blockApiKey))
  );

  // --- Assets ---

  server.tool("upload_asset", "Register an asset (metadata only — actual file upload is separate)",
    {
      filename: z.string(), mimeType: z.string(),
      size: z.number().optional(), width: z.number().optional(), height: z.number().optional(),
      alt: z.string().optional(), title: z.string().optional(),
    },
    async (args) => run(AssetService.createAsset(args))
  );

  server.tool("list_assets", "List all assets",
    {},
    async () => run(AssetService.listAssets())
  );

  return server;
}
