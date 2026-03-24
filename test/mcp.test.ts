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
    it("schema_info returns empty models initially", async () => {
      const res = await client.callTool({ name: "schema_info", arguments: {} });
      const result = parseToolResult(res);
      expect(result.models).toEqual([]);
    });

    it("schema_info returns models with fields", async () => {
      // Create a model via MCP
      await client.callTool({
        name: "create_model",
        arguments: { name: "Article", apiKey: "article" },
      });
      await client.callTool({
        name: "create_field",
        arguments: {
          modelId: parseToolResult(await client.callTool({ name: "schema_info", arguments: { filterByName: "article" } })).models[0].id,
          label: "Title", apiKey: "title", fieldType: "string",
        },
      });

      const res = await client.callTool({ name: "schema_info", arguments: {} });
      const result = parseToolResult(res);
      expect(result.models).toHaveLength(1);
      expect(result.models[0].apiKey).toBe("article");
      expect(result.models[0].fields).toHaveLength(1);
      expect(result.models[0].fields[0].apiKey).toBe("title");
    });

    it("schema_info with filterByName returns detailed field info", async () => {
      await client.callTool({
        name: "create_model",
        arguments: { name: "Post", apiKey: "post" },
      });

      const res = await client.callTool({
        name: "schema_info",
        arguments: { filterByName: "post" },
      });
      const result = parseToolResult(res);
      const model = result.models[0];
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
      await client.callTool({
        name: "create_field",
        arguments: { modelId, label: "Featured", apiKey: "featured", fieldType: "boolean" },
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

    it("gets a single record by id", async () => {
      const createRes = await client.callTool({
        name: "create_record",
        arguments: { modelApiKey: "post", data: { title: "Lookup" } },
      });
      const record = getResult(createRes);

      const getRes = await client.callTool({
        name: "get_record",
        arguments: { recordId: record.id, modelApiKey: "post" },
      });
      const fetched = getResult(getRes);
      expect(fetched.id).toBe(record.id);
      expect(fetched.title).toBe("Lookup");
    });

    it("returns booleans as booleans in MCP record responses", async () => {
      const createRes = await client.callTool({
        name: "create_record",
        arguments: { modelApiKey: "post", data: { title: "Featured", featured: true } },
      });
      const created = getResult(createRes);
      expect(created.featured).toBe(true);

      const publishRes = await client.callTool({
        name: "set_publish_status",
        arguments: { action: "publish", recordIds: [created.id], modelApiKey: "post" },
      });
      const published = getResult(publishRes);
      expect(published.featured).toBe(true);
    });

    it("publishes and unpublishes", async () => {
      const createRes = await client.callTool({
        name: "create_record",
        arguments: { modelApiKey: "post", data: { title: "Draft" } },
      });
      const record = getResult(createRes);
      expect(record._status).toBe("draft");

      const pubRes = await client.callTool({
        name: "set_publish_status",
        arguments: { action: "publish", recordIds: [record.id], modelApiKey: "post" },
      });
      expect(getResult(pubRes)._status).toBe("published");

      const unpubRes = await client.callTool({
        name: "set_publish_status",
        arguments: { action: "unpublish", recordIds: [record.id], modelApiKey: "post" },
      });
      expect(getResult(unpubRes)._status).toBe("draft");
    });

    it("bulk publishes records", async () => {
      const createOne = getResult(await client.callTool({
        name: "create_record",
        arguments: { modelApiKey: "post", data: { title: "Draft A" } },
      }));
      const createTwo = getResult(await client.callTool({
        name: "create_record",
        arguments: { modelApiKey: "post", data: { title: "Draft B" } },
      }));

      const bulkPubRes = await client.callTool({
        name: "set_publish_status",
        arguments: { action: "publish", modelApiKey: "post", recordIds: [createOne.id, createTwo.id] },
      });
      const published = getResult(bulkPubRes);
      expect(published).toHaveLength(2);
      expect(published.every((record: { _status: string }) => record._status === "published")).toBe(true);
    });

    it("bulk unpublishes records", async () => {
      const createOne = getResult(await client.callTool({
        name: "create_record",
        arguments: { modelApiKey: "post", data: { title: "Published A" } },
      }));
      const createTwo = getResult(await client.callTool({
        name: "create_record",
        arguments: { modelApiKey: "post", data: { title: "Published B" } },
      }));
      await client.callTool({
        name: "set_publish_status",
        arguments: { action: "publish", modelApiKey: "post", recordIds: [createOne.id, createTwo.id] },
      });

      const bulkUnpubRes = await client.callTool({
        name: "set_publish_status",
        arguments: { action: "unpublish", modelApiKey: "post", recordIds: [createOne.id, createTwo.id] },
      });
      const unpublished = getResult(bulkUnpubRes);
      expect(unpublished).toHaveLength(2);
      expect(unpublished.every((record: { _status: string }) => record._status === "draft")).toBe(true);
    });

    it("lists record versions", async () => {
      const created = getResult(await client.callTool({
        name: "create_record",
        arguments: { modelApiKey: "post", data: { title: "Diffable", body: "Version one" } },
      }));
      await client.callTool({
        name: "set_publish_status",
        arguments: { action: "publish", recordIds: [created.id], modelApiKey: "post" },
      });
      await client.callTool({
        name: "update_record",
        arguments: { recordId: created.id, modelApiKey: "post", data: { body: "Version two" } },
      });
      await client.callTool({
        name: "set_publish_status",
        arguments: { action: "publish", recordIds: [created.id], modelApiKey: "post" },
      });

      const versions = getResult(await client.callTool({
        name: "record_versions",
        arguments: { action: "list", recordId: created.id, modelApiKey: "post" },
      })) as Array<{ id: string }>;
      expect(versions.length).toBeGreaterThan(0);
    });

    it("schedules publish and clears schedules", async () => {
      const createRes = await client.callTool({
        name: "create_record",
        arguments: { modelApiKey: "post", data: { title: "Scheduled draft" } },
      });
      const record = getResult(createRes);

      const scheduleRes = await client.callTool({
        name: "schedule",
        arguments: { action: "publish", recordId: record.id, modelApiKey: "post", at: "2026-04-01T09:00:00.000Z" },
      });
      expect(getResult(scheduleRes)._scheduled_publish_at).toBe("2026-04-01T09:00:00.000Z");

      const clearRes = await client.callTool({
        name: "schedule",
        arguments: { action: "clear", recordId: record.id, modelApiKey: "post" },
      });
      expect(getResult(clearRes)._scheduled_publish_at).toBeNull();
      expect(getResult(clearRes)._scheduled_unpublish_at).toBeNull();
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

  describe("Search", () => {
    it("returns titles in search results", async () => {
      const modelRes = await client.callTool({
        name: "create_model",
        arguments: { name: "Post", apiKey: "post" },
      });
      const model = getResult(modelRes);
      await client.callTool({
        name: "create_field",
        arguments: { modelId: model.id, label: "Title", apiKey: "title", fieldType: "string" },
      });
      await client.callTool({
        name: "create_field",
        arguments: { modelId: model.id, label: "Body", apiKey: "body", fieldType: "text" },
      });
      await client.callTool({
        name: "create_record",
        arguments: { modelApiKey: "post", data: { title: "Delegation and Trust in Automated Systems", body: "governance matters" } },
      });

      const searchRes = await client.callTool({
        name: "search_content",
        arguments: { query: "governance", mode: "keyword" },
      });
      const search = getResult(searchRes);
      expect(search.results[0].title).toBe("Delegation and Trust in Automated Systems");
    });
  });

  describe("Error handling", () => {
    it("returns empty models for nonexistent filterByName", async () => {
      const res = await client.callTool({
        name: "schema_info",
        arguments: { filterByName: "nonexistent" },
      });
      const result = parseToolResult(res);
      expect(result.models).toEqual([]);
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
