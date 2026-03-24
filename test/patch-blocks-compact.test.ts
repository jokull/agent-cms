import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { runMigrations } from "./migrate.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTestMcpClient, parseToolResult as parse } from "./mcp-helpers.js";
import { createTestApp, jsonRequest } from "./app-helpers.js";

describe("patch_blocks compact MCP response", () => {
  let agent: Client;
  let sqlLayer: any;

  beforeEach(async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-compact-pb-"));
    const dbPath = join(tmpDir, "test.db");
    sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });
    Effect.runSync(runMigrations().pipe(Effect.provide(sqlLayer)));

    ({ client: agent } = await createTestMcpClient(sqlLayer));

    // Block type: venue
    const venue = parse(await agent.callTool({
      name: "create_model",
      arguments: { name: "Venue", apiKey: "venue", isBlock: true },
    }));
    parse(await agent.callTool({
      name: "create_field",
      arguments: { modelId: venue.id, label: "Name", apiKey: "name", fieldType: "string" },
    }));
    parse(await agent.callTool({
      name: "create_field",
      arguments: { modelId: venue.id, label: "Description", apiKey: "description", fieldType: "text" },
    }));

    // Content model: guide
    const guide = parse(await agent.callTool({
      name: "create_model",
      arguments: { name: "Guide", apiKey: "guide", hasDraft: true },
    }));
    parse(await agent.callTool({
      name: "create_field",
      arguments: { modelId: guide.id, label: "Title", apiKey: "title", fieldType: "string" },
    }));
    parse(await agent.callTool({
      name: "create_field",
      arguments: {
        modelId: guide.id, label: "Content", apiKey: "content", fieldType: "structured_text",
        validators: { structured_text_blocks: ["venue"] },
      },
    }));
  });

  async function createGuideWithVenues() {
    return parse(await agent.callTool({
      name: "create_record",
      arguments: {
        modelApiKey: "guide",
        data: {
          title: "Food Guide",
          content: {
            value: {
              schema: "dast",
              document: {
                type: "root",
                children: [
                  { type: "block", item: "v1" },
                  { type: "paragraph", children: [{ type: "span", value: "Interlude" }] },
                  { type: "block", item: "v2" },
                  { type: "block", item: "v3" },
                ],
              },
            },
            blocks: {
              v1: { _type: "venue", name: "Grillid", description: "Fine dining" },
              v2: { _type: "venue", name: "Baejarins Beztu", description: "Hot dogs" },
              v3: { _type: "venue", name: "Dill", description: "Nordic cuisine" },
            },
          },
        },
      },
    }));
  }

  it("returns blocks map with all remaining block data", async () => {
    const record = await createGuideWithVenues();

    const result = parse(await agent.callTool({
      name: "patch_blocks",
      arguments: {
        recordId: record.id,
        modelApiKey: "guide",
        fieldApiKey: "content",
        blocks: { v2: { description: "Famous hot dogs since 1937" } },
      },
    }));

    expect(result.blocks).toBeDefined();
    expect(Object.keys(result.blocks)).toHaveLength(3);
    expect(result.blocks.v1).toBeDefined();
    expect(result.blocks.v2).toBeDefined();
    expect(result.blocks.v3).toBeDefined();
    // Updated block should have new value
    expect(result.blocks.v2.description).toBe("Famous hot dogs since 1937");
    // Untouched blocks should keep their data
    expect(result.blocks.v1.name).toBe("Grillid");
    expect(result.blocks.v3.name).toBe("Dill");
  });

  it("returns deleted array with IDs of removed blocks", async () => {
    const record = await createGuideWithVenues();

    const result = parse(await agent.callTool({
      name: "patch_blocks",
      arguments: {
        recordId: record.id,
        modelApiKey: "guide",
        fieldApiKey: "content",
        blocks: { v2: null, v3: null },
      },
    }));

    expect(result.deleted).toEqual(expect.arrayContaining(["v2", "v3"]));
    expect(result.deleted).toHaveLength(2);
    // Remaining blocks should not include deleted ones
    expect(Object.keys(result.blocks)).toHaveLength(1);
    expect(result.blocks.v1).toBeDefined();
  });

  it("returns blockOrder matching DAST traversal", async () => {
    const record = await createGuideWithVenues();

    const result = parse(await agent.callTool({
      name: "patch_blocks",
      arguments: {
        recordId: record.id,
        modelApiKey: "guide",
        fieldApiKey: "content",
        blocks: { v1: { name: "Updated Grillid" } },
      },
    }));

    // Block order should match DAST document traversal: v1, v2, v3
    expect(result.blockOrder).toEqual(["v1", "v2", "v3"]);
  });

  it("returns recordId and status", async () => {
    const record = await createGuideWithVenues();

    const result = parse(await agent.callTool({
      name: "patch_blocks",
      arguments: {
        recordId: record.id,
        modelApiKey: "guide",
        fieldApiKey: "content",
        blocks: { v1: { name: "Updated Grillid" } },
      },
    }));

    expect(result.recordId).toBe(record.id);
    expect(result.status).toBeDefined();
    // Draft model, so status should be "draft"
    expect(result.status).toBe("draft");
  });

  it("does not include full record fields (title, etc.)", async () => {
    const record = await createGuideWithVenues();

    const result = parse(await agent.callTool({
      name: "patch_blocks",
      arguments: {
        recordId: record.id,
        modelApiKey: "guide",
        fieldApiKey: "content",
        blocks: { v1: { name: "Updated" } },
      },
    }));

    // The compact response should NOT include top-level record fields
    expect(result.title).toBeUndefined();
    expect(result.content).toBeUndefined();
    // But should have the compact keys
    expect(Object.keys(result).sort()).toEqual(["blockOrder", "blocks", "deleted", "field", "fieldApiKey", "recordId", "status"]);
    expect(result.fieldApiKey).toBe("content");
    expect(result.field.blocks.v1.name).toBe("Updated");
  });

  it("reflects pruned blockOrder after deletion", async () => {
    const record = await createGuideWithVenues();

    const result = parse(await agent.callTool({
      name: "patch_blocks",
      arguments: {
        recordId: record.id,
        modelApiKey: "guide",
        fieldApiKey: "content",
        blocks: { v2: null },
      },
    }));

    // v2 should be pruned from DAST, so blockOrder should be [v1, v3]
    expect(result.blockOrder).toEqual(["v1", "v3"]);
    expect(result.deleted).toEqual(["v2"]);
  });
});

describe("HTTP PATCH /api/records/:id/blocks still returns full record", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    ({ handler } = createTestApp());

    const venueRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Venue", apiKey: "venue", isBlock: true,
    });
    const venue = await venueRes.json();
    await jsonRequest(handler, "POST", `/api/models/${venue.id}/fields`, {
      label: "Name", apiKey: "name", fieldType: "string",
    });

    const guideRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Guide", apiKey: "guide", hasDraft: false,
    });
    const guide = await guideRes.json();
    await jsonRequest(handler, "POST", `/api/models/${guide.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${guide.id}/fields`, {
      label: "Content", apiKey: "content", fieldType: "structured_text",
      validators: { structured_text_blocks: ["venue"] },
    });
  });

  it("returns the full materialized record via HTTP", async () => {
    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "guide",
      data: {
        title: "Food Guide",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                { type: "block", item: "v1" },
              ],
            },
          },
          blocks: {
            v1: { _type: "venue", name: "Grillid" },
          },
        },
      },
    });
    const record = await createRes.json();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}/blocks`, {
      modelApiKey: "guide",
      fieldApiKey: "content",
      blocks: { v1: { name: "Updated Grillid" } },
    });
    expect(patchRes.status).toBe(200);

    const result = await patchRes.json();
    // HTTP response should include the full record with title, content, etc.
    expect(result.title).toBe("Food Guide");
    expect(result.content).toBeDefined();
    expect(result.id).toBe(record.id);
  });
});
