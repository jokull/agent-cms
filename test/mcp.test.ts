import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { runMigrations } from "./migrate.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTestMcpClient, parseToolResult } from "./mcp-helpers.js";

const getResult = parseToolResult;

async function createTestMcp() {
  const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-mcp-"));
  const dbPath = join(tmpDir, "test.db");
  const sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });

  Effect.runSync(runMigrations().pipe(Effect.provide(sqlLayer)));

  return createTestMcpClient(sqlLayer);
}

describe("MCP Server", () => {
  let client: Client;

  beforeEach(async () => {
    ({ client } = await createTestMcp());
  });

  describe("Discovery", () => {
    it("list_models returns empty initially", async () => {
      const res = await client.callTool({ name: "list_models", arguments: {} });
      const models = parseToolResult(res);
      expect(models).toEqual([]);
    });

    it("list_models returns models with fields", async () => {
      // Create a model via MCP
      await client.callTool({
        name: "create_model",
        arguments: { name: "Article", apiKey: "article" },
      });
      await client.callTool({
        name: "create_field",
        arguments: {
          modelId: parseToolResult(await client.callTool({ name: "describe_model", arguments: { apiKey: "article" } })).id,
          label: "Title", apiKey: "title", fieldType: "string",
        },
      });

      const res = await client.callTool({ name: "list_models", arguments: {} });
      const models = parseToolResult(res);
      expect(models).toHaveLength(1);
      expect(models[0].apiKey).toBe("article");
      expect(models[0].fields).toHaveLength(1);
      expect(models[0].fields[0].apiKey).toBe("title");
    });

    it("describe_model returns detailed field info", async () => {
      await client.callTool({
        name: "create_model",
        arguments: { name: "Post", apiKey: "post" },
      });

      const res = await client.callTool({
        name: "describe_model",
        arguments: { apiKey: "post" },
      });
      const model = parseToolResult(res);
      expect(model.apiKey).toBe("post");
      expect(model.isBlock).toBe(false);
      expect(model.fields).toEqual([]);
    });
  });

  describe("Schema management", () => {
    it("creates a model and field end-to-end", async () => {
      const modelRes = await client.callTool({
        name: "create_model",
        arguments: { name: "Blog Post", apiKey: "blog_post" },
      });
      const model = parseToolResult(modelRes);
      expect(model.apiKey).toBe("blog_post");

      const fieldRes = await client.callTool({
        name: "create_field",
        arguments: {
          modelId: model.id,
          label: "Title",
          apiKey: "title",
          fieldType: "string",
          validators: { required: true },
        },
      });
      const field = parseToolResult(fieldRes);
      expect(field.apiKey).toBe("title");
      expect(field.fieldType).toBe("string");
    });

    it("creates a block type", async () => {
      const res = await client.callTool({
        name: "create_model",
        arguments: { name: "Hero Section", apiKey: "hero_section", isBlock: true },
      });
      const model = getResult(res);
      expect(model.isBlock).toBe(true);
    });

    it("deletes a model", async () => {
      const createRes = await client.callTool({
        name: "create_model",
        arguments: { name: "Temp", apiKey: "temp" },
      });
      const model = getResult(createRes);

      const deleteRes = await client.callTool({
        name: "delete_model",
        arguments: { modelId: model.id },
      });
      expect(getResult(deleteRes).deleted).toBe(true);
    });
  });

  describe("Content management", () => {
    let modelId: string;

    beforeEach(async () => {
      const modelRes = await client.callTool({
        name: "create_model",
        arguments: { name: "Post", apiKey: "post" },
      });
      modelId = getResult(modelRes).id;

      await client.callTool({
        name: "create_field",
        arguments: { modelId, label: "Title", apiKey: "title", fieldType: "string" },
      });
      await client.callTool({
        name: "create_field",
        arguments: { modelId, label: "Body", apiKey: "body", fieldType: "text" },
      });
    });

    it("creates and queries records", async () => {
      await client.callTool({
        name: "create_record",
        arguments: { modelApiKey: "post", data: { title: "Hello World", body: "My first post" } },
      });
      await client.callTool({
        name: "create_record",
        arguments: { modelApiKey: "post", data: { title: "Second Post" } },
      });

      const res = await client.callTool({
        name: "query_records",
        arguments: { modelApiKey: "post" },
      });
      const records = getResult(res);
      expect(records).toHaveLength(2);
    });

    it("updates a record", async () => {
      const createRes = await client.callTool({
        name: "create_record",
        arguments: { modelApiKey: "post", data: { title: "Original" } },
      });
      const record = getResult(createRes);

      const updateRes = await client.callTool({
        name: "update_record",
        arguments: { recordId: record.id, modelApiKey: "post", data: { title: "Updated" } },
      });
      const updated = getResult(updateRes);
      expect(updated.title).toBe("Updated");
    });

    it("publishes and unpublishes", async () => {
      const createRes = await client.callTool({
        name: "create_record",
        arguments: { modelApiKey: "post", data: { title: "Draft" } },
      });
      const record = getResult(createRes);
      expect(record._status).toBe("draft");

      const pubRes = await client.callTool({
        name: "publish_record",
        arguments: { recordId: record.id, modelApiKey: "post" },
      });
      expect(getResult(pubRes)._status).toBe("published");

      const unpubRes = await client.callTool({
        name: "unpublish_record",
        arguments: { recordId: record.id, modelApiKey: "post" },
      });
      expect(getResult(unpubRes)._status).toBe("draft");
    });

    it("deletes a record", async () => {
      const createRes = await client.callTool({
        name: "create_record",
        arguments: { modelApiKey: "post", data: { title: "Doomed" } },
      });
      const record = getResult(createRes);

      const deleteRes = await client.callTool({
        name: "delete_record",
        arguments: { recordId: record.id, modelApiKey: "post" },
      });
      expect(getResult(deleteRes).deleted).toBe(true);

      const queryRes = await client.callTool({
        name: "query_records",
        arguments: { modelApiKey: "post" },
      });
      expect(getResult(queryRes)).toHaveLength(0);
    });
  });

  describe("Error handling", () => {
    it("returns error for nonexistent model", async () => {
      const res = await client.callTool({
        name: "describe_model",
        arguments: { apiKey: "nonexistent" },
      });
      const result = getResult(res);
      expect(result.error).toContain("not found");
    });

    it("returns error for duplicate model", async () => {
      await client.callTool({
        name: "create_model",
        arguments: { name: "Post", apiKey: "post" },
      });
      const res = await client.callTool({
        name: "create_model",
        arguments: { name: "Post 2", apiKey: "post" },
      });
      expect(res.isError).toBe(true);
    });
  });
});
