import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { runMigrations } from "./migrate.js";
import { createTestApp, gqlQuery, jsonRequest } from "./app-helpers.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function parse(res: any): any {
  if (res.isError) throw new Error(`Tool error: ${res.content[0]?.text}`);
  return JSON.parse(res.content[0]?.text ?? "null");
}

function createMcpTestApp() {
  const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-lifecycle-"));
  const dbPath = join(tmpDir, "test.db");
  const sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });
  Effect.runSync(runMigrations("./drizzle").pipe(Effect.provide(sqlLayer)));
  return { sqlLayer };
}

async function createMcpAgent(sqlLayer: any) {
  const mcpServer = createMcpServer(sqlLayer);
  const agent = new Client({ name: "test", version: "1.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(st);
  await agent.connect(ct);
  return agent;
}

// ─── P1: Published snapshots not cleaned on block removal ───

describe("P1: Published snapshots cleaned on block removal", () => {
  let agent: Client;
  let sqlLayer: any;

  beforeEach(async () => {
    ({ sqlLayer } = createMcpTestApp());
    agent = await createMcpAgent(sqlLayer);
  });

  it("remove_block_type cleans published snapshots", async () => {
    // Setup: block type + content model + record with block
    const hero = parse(await agent.callTool({
      name: "create_model", arguments: { name: "Hero", apiKey: "hero", isBlock: true },
    }));
    parse(await agent.callTool({
      name: "create_field",
      arguments: { modelId: hero.id, label: "Headline", apiKey: "headline", fieldType: "string" },
    }));

    const page = parse(await agent.callTool({
      name: "create_model", arguments: { name: "Page", apiKey: "page" },
    }));
    parse(await agent.callTool({
      name: "create_field",
      arguments: { modelId: page.id, label: "Title", apiKey: "title", fieldType: "string" },
    }));
    parse(await agent.callTool({
      name: "create_field",
      arguments: {
        modelId: page.id, label: "Body", apiKey: "body", fieldType: "structured_text",
        validators: { structured_text_blocks: ["hero"] },
      },
    }));

    const blockId = "01HERO_SNAP_TEST_001";
    const record = parse(await agent.callTool({
      name: "create_record",
      arguments: {
        modelApiKey: "page",
        data: {
          title: "Home",
          body: {
            value: {
              schema: "dast",
              document: {
                type: "root",
                children: [
                  { type: "paragraph", children: [{ type: "span", value: "Before" }] },
                  { type: "block", item: blockId },
                  { type: "paragraph", children: [{ type: "span", value: "After" }] },
                ],
              },
            },
            blocks: { [blockId]: { _type: "hero", headline: "Welcome" } },
          },
        },
      },
    }));

    // Publish the record
    parse(await agent.callTool({
      name: "publish_record",
      arguments: { modelApiKey: "page", recordId: record.id },
    }));

    // Verify published snapshot has the block
    const beforeRemoval = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql.unsafe<{ _published_snapshot: string }>(
          'SELECT _published_snapshot FROM "content_page" WHERE id = ?', [record.id]
        );
        return JSON.parse(rows[0]._published_snapshot);
      }).pipe(Effect.provide(sqlLayer))
    );
    expect(beforeRemoval.body.document.children).toHaveLength(3);
    expect(beforeRemoval.body.document.children[1].type).toBe("block");

    // Remove the block type
    parse(await agent.callTool({
      name: "remove_block_type", arguments: { blockApiKey: "hero" },
    }));

    // Published snapshot should be cleaned too
    const afterRemoval = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql.unsafe<{ _published_snapshot: string }>(
          'SELECT _published_snapshot FROM "content_page" WHERE id = ?', [record.id]
        );
        return JSON.parse(rows[0]._published_snapshot);
      }).pipe(Effect.provide(sqlLayer))
    );
    expect(afterRemoval.body.document.children).toHaveLength(2);
    expect(afterRemoval.body.document.children.every((c: any) => c.type === "paragraph")).toBe(true);
  });

  it("remove_block_from_whitelist cleans published snapshots", async () => {
    // Setup: two block types, one gets removed from whitelist
    const callout = parse(await agent.callTool({
      name: "create_model", arguments: { name: "Callout", apiKey: "callout", isBlock: true },
    }));
    parse(await agent.callTool({
      name: "create_field",
      arguments: { modelId: callout.id, label: "Msg", apiKey: "msg", fieldType: "text" },
    }));

    const code = parse(await agent.callTool({
      name: "create_model", arguments: { name: "Code", apiKey: "code_block", isBlock: true },
    }));
    parse(await agent.callTool({
      name: "create_field",
      arguments: { modelId: code.id, label: "Code", apiKey: "code", fieldType: "text" },
    }));

    const page = parse(await agent.callTool({
      name: "create_model", arguments: { name: "Page", apiKey: "page" },
    }));
    parse(await agent.callTool({
      name: "create_field",
      arguments: { modelId: page.id, label: "Title", apiKey: "title", fieldType: "string" },
    }));
    const bodyField = parse(await agent.callTool({
      name: "create_field",
      arguments: {
        modelId: page.id, label: "Body", apiKey: "body", fieldType: "structured_text",
        validators: { structured_text_blocks: ["callout", "code_block"] },
      },
    }));

    const calloutId = "01CALLOUT_WL_TEST_01";
    const codeId = "01CODE_WL_TEST_0001";
    const record = parse(await agent.callTool({
      name: "create_record",
      arguments: {
        modelApiKey: "page",
        data: {
          title: "Test",
          body: {
            value: {
              schema: "dast",
              document: {
                type: "root",
                children: [
                  { type: "block", item: calloutId },
                  { type: "paragraph", children: [{ type: "span", value: "Middle" }] },
                  { type: "block", item: codeId },
                ],
              },
            },
            blocks: {
              [calloutId]: { _type: "callout", msg: "Warning!" },
              [codeId]: { _type: "code_block", code: "console.log('hi')" },
            },
          },
        },
      },
    }));

    // Publish
    parse(await agent.callTool({
      name: "publish_record",
      arguments: { modelApiKey: "page", recordId: record.id },
    }));

    // Remove callout from whitelist (keep code_block)
    parse(await agent.callTool({
      name: "remove_block_from_whitelist",
      arguments: { fieldId: bodyField.id, blockApiKey: "callout" },
    }));

    // Published snapshot should have callout block removed
    const snapshot = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql.unsafe<{ _published_snapshot: string }>(
          'SELECT _published_snapshot FROM "content_page" WHERE id = ?', [record.id]
        );
        return JSON.parse(rows[0]._published_snapshot);
      }).pipe(Effect.provide(sqlLayer))
    );
    // Should have paragraph + code_block, callout removed
    expect(snapshot.body.document.children).toHaveLength(2);
    const types = snapshot.body.document.children.map((c: any) => c.type);
    expect(types).toContain("paragraph");
    expect(types).toContain("block");
    // Remaining block should be the code block
    const remainingBlock = snapshot.body.document.children.find((c: any) => c.type === "block");
    expect(remainingBlock.item).toBe(codeId);
  });
});

// ─── P2: Published snapshots retain deleted field data ───

describe("P2: Published snapshots cleaned on field deletion", () => {
  let handler: any;
  let sqlLayer: any;

  beforeEach(() => {
    ({ handler, sqlLayer } = createTestApp());
  });

  it("deleteField strips the field from published snapshots", async () => {
    // Create model with two fields
    const modelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Article", apiKey: "article",
    });
    const model = await modelRes.json();

    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    const iconRes = await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Icon", apiKey: "icon", fieldType: "string",
    });
    const iconField = await iconRes.json();

    // Create and publish a record
    const recordRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "Hello", icon: "star" },
    });
    const record = await recordRes.json();
    await jsonRequest(handler, "POST", `/api/records/${record.id}/publish?modelApiKey=article`);

    // Verify snapshot has icon
    const beforeSnapshot = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql.unsafe<{ _published_snapshot: string }>(
          'SELECT _published_snapshot FROM "content_article" WHERE id = ?', [record.id]
        );
        return JSON.parse(rows[0]._published_snapshot);
      }).pipe(Effect.provide(sqlLayer))
    );
    expect(beforeSnapshot.icon).toBe("star");

    // Delete the icon field
    await jsonRequest(handler, "DELETE", `/api/models/${model.id}/fields/${iconField.id}`);

    // Published snapshot should have icon removed
    const afterSnapshot = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql.unsafe<{ _published_snapshot: string }>(
          'SELECT _published_snapshot FROM "content_article" WHERE id = ?', [record.id]
        );
        return JSON.parse(rows[0]._published_snapshot);
      }).pipe(Effect.provide(sqlLayer))
    );
    expect(afterSnapshot).not.toHaveProperty("icon");
    expect(afterSnapshot.title).toBe("Hello");
  });

  it("deleteField strips field from multiple published records", async () => {
    const modelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Item", apiKey: "item",
    });
    const model = await modelRes.json();

    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Name", apiKey: "name", fieldType: "string",
    });
    const colorRes = await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Color", apiKey: "color", fieldType: "string",
    });
    const colorField = await colorRes.json();

    // Create and publish 3 records
    for (const name of ["Red", "Green", "Blue"]) {
      const res = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "item", data: { name, color: name.toLowerCase() },
      });
      const rec = await res.json();
      await jsonRequest(handler, "POST", `/api/records/${rec.id}/publish?modelApiKey=item`);
    }

    // Delete color field
    await jsonRequest(handler, "DELETE", `/api/models/${model.id}/fields/${colorField.id}`);

    // All snapshots should be cleaned
    const snapshots = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe<{ _published_snapshot: string }>(
          'SELECT _published_snapshot FROM "content_item" WHERE _published_snapshot IS NOT NULL'
        );
      }).pipe(Effect.provide(sqlLayer))
    );
    expect(snapshots).toHaveLength(3);
    for (const row of snapshots) {
      const snap = JSON.parse(row._published_snapshot);
      expect(snap).not.toHaveProperty("color");
      expect(snap).toHaveProperty("name");
    }
  });
});

// ─── P4: Slug field with deleted source field ───

describe("P4: Slug field warns/errors when source field deleted", () => {
  let handler: any;

  beforeEach(() => {
    ({ handler } = createTestApp());
  });

  it("deleteField blocks deletion when slug field depends on it", async () => {
    const modelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Article", apiKey: "article",
    });
    const model = await modelRes.json();

    const titleRes = await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    const titleField = await titleRes.json();

    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Slug", apiKey: "slug", fieldType: "slug",
      validators: { slug_source: "title" },
    });

    // Try to delete the title field — should fail because slug depends on it
    const deleteRes = await jsonRequest(handler, "DELETE", `/api/models/${model.id}/fields/${titleField.id}`);
    expect(deleteRes.status).toBe(409);
    const body = await deleteRes.json();
    expect(body.error).toContain("slug");
  });
});

// ─── P5: Model deletion with existing records ───

describe("P5: Model deletion warns about existing records", () => {
  let handler: any;
  let sqlLayer: any;

  beforeEach(() => {
    ({ handler, sqlLayer } = createTestApp());
  });

  it("deleteModel returns record count in response", async () => {
    const modelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Note", apiKey: "note",
    });
    const model = await modelRes.json();

    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Text", apiKey: "text", fieldType: "string",
    });

    // Create 3 records
    for (let i = 0; i < 3; i++) {
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "note", data: { text: `Note ${i}` },
      });
    }

    // Delete model — should succeed but include destroyed record count
    const deleteRes = await jsonRequest(handler, "DELETE", `/api/models/${model.id}`);
    expect(deleteRes.status).toBe(200);
    const body = await deleteRes.json();
    expect(body.deleted).toBe(true);
    expect(body.recordsDestroyed).toBe(3);
  });

  it("deleteModel returns 0 records destroyed when empty", async () => {
    const modelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Empty", apiKey: "empty",
    });
    const model = await modelRes.json();

    const deleteRes = await jsonRequest(handler, "DELETE", `/api/models/${model.id}`);
    const body = await deleteRes.json();
    expect(body.deleted).toBe(true);
    expect(body.recordsDestroyed).toBe(0);
  });
});

// ─── Additional lifecycle edge cases ───

describe("Lifecycle edge cases", () => {
  let handler: any;
  let sqlLayer: any;

  beforeEach(() => {
    ({ handler, sqlLayer } = createTestApp());
  });

  it("model rename updates structured_text block whitelists", async () => {
    // Create a block type
    const blockRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Quote", apiKey: "quote", isBlock: true,
    });
    const block = await blockRes.json();
    await jsonRequest(handler, "POST", `/api/models/${block.id}/fields`, {
      label: "Text", apiKey: "text", fieldType: "text",
    });

    // Create content model with ST field referencing the block
    const pageRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Page", apiKey: "page",
    });
    const page = await pageRes.json();
    const stRes = await jsonRequest(handler, "POST", `/api/models/${page.id}/fields`, {
      label: "Body", apiKey: "body", fieldType: "structured_text",
      validators: { structured_text_blocks: ["quote"] },
    });
    const stField = await stRes.json();

    // Rename the block type
    await jsonRequest(handler, "PATCH", `/api/models/${block.id}`, {
      apiKey: "pullquote",
    });

    // ST field whitelist should be updated
    const fieldsRes = await jsonRequest(handler, "GET", `/api/models/${page.id}/fields`);
    const fields = await fieldsRes.json();
    const bodyField = fields.find((f: any) => f.api_key === "body");
    const validators = typeof bodyField.validators === "string"
      ? JSON.parse(bodyField.validators) : bodyField.validators;
    expect(validators.structured_text_blocks).toEqual(["pullquote"]);
  });

  it("deleteField on structured_text field does not leave orphaned block rows", async () => {
    // Create block type
    const blockRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Note", apiKey: "note_block", isBlock: true,
    });
    const block = await blockRes.json();
    await jsonRequest(handler, "POST", `/api/models/${block.id}/fields`, {
      label: "Text", apiKey: "text", fieldType: "text",
    });

    // Create page with ST field
    const pageRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Page", apiKey: "page",
    });
    const page = await pageRes.json();
    await jsonRequest(handler, "POST", `/api/models/${page.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    const stRes = await jsonRequest(handler, "POST", `/api/models/${page.id}/fields`, {
      label: "Body", apiKey: "body", fieldType: "structured_text",
      validators: { structured_text_blocks: ["note_block"] },
    });
    const stField = await stRes.json();

    // Create record with block
    const noteId = "01NOTE_ORPHAN_TEST1";
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Test",
        body: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                { type: "paragraph", children: [{ type: "span", value: "Intro" }] },
                { type: "block", item: noteId },
              ],
            },
          },
          blocks: { [noteId]: { _type: "note_block", text: "A note" } },
        },
      },
    });

    // Verify block row exists
    const blocksBefore = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe<{ id: string }>('SELECT id FROM "block_note_block"');
      }).pipe(Effect.provide(sqlLayer))
    );
    expect(blocksBefore).toHaveLength(1);

    // Delete the ST field
    await jsonRequest(handler, "DELETE", `/api/models/${page.id}/fields/${stField.id}`);

    // Block rows for this field should be cleaned up
    const blocksAfter = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe<{ id: string }>(
          'SELECT id FROM "block_note_block" WHERE _root_field_api_key = ?', ["body"]
        );
      }).pipe(Effect.provide(sqlLayer))
    );
    expect(blocksAfter).toHaveLength(0);
  });
});
