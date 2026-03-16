import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { runMigrations } from "./migrate.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function parse(res: any): any {
  if (res.isError) throw new Error(`Tool error: ${res.content[0]?.text}`);
  return JSON.parse(res.content[0]?.text ?? "null");
}

describe("P4.4: Block type removal", () => {
  let agent: Client;
  let sqlLayer: any;

  beforeEach(async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-block-rm-"));
    const dbPath = join(tmpDir, "test.db");
    sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });
    Effect.runSync(runMigrations().pipe(Effect.provide(sqlLayer)));

    const mcpServer = createMcpServer(sqlLayer);
    agent = new Client({ name: "test", version: "1.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(st);
    await agent.connect(ct);
  });

  it("removes a block type, cleans DAST trees, and drops table", async () => {
    // Create block type
    const hero = parse(await agent.callTool({
      name: "create_model", arguments: { name: "Hero", apiKey: "hero", isBlock: true },
    }));
    parse(await agent.callTool({
      name: "create_field", arguments: { modelId: hero.id, label: "Headline", apiKey: "headline", fieldType: "string" },
    }));

    // Create content model with ST field allowing hero blocks
    const page = parse(await agent.callTool({
      name: "create_model", arguments: { name: "Page", apiKey: "page" },
    }));
    parse(await agent.callTool({
      name: "create_field", arguments: { modelId: page.id, label: "Title", apiKey: "title", fieldType: "string" },
    }));
    parse(await agent.callTool({
      name: "create_field", arguments: {
        modelId: page.id, label: "Content", apiKey: "content", fieldType: "structured_text",
        validators: { structured_text_blocks: ["hero"] },
      },
    }));

    // Create record with a hero block
    const heroBlockId = "01HBLK_RM_HERO_1";
    parse(await agent.callTool({
      name: "create_record",
      arguments: {
        modelApiKey: "page",
        data: {
          title: "Home",
          content: {
            value: {
              schema: "dast",
              document: {
                type: "root",
                children: [
                  { type: "paragraph", children: [{ type: "span", value: "Before" }] },
                  { type: "block", item: heroBlockId },
                  { type: "paragraph", children: [{ type: "span", value: "After" }] },
                ],
              },
            },
            blocks: { [heroBlockId]: { _type: "hero", headline: "Welcome" } },
          },
        },
      },
    }));

    // Verify block exists
    const blocksBefore = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe<{ id: string }>('SELECT id FROM "block_hero"');
      }).pipe(Effect.provide(sqlLayer))
    );
    expect(blocksBefore).toHaveLength(1);

    // Remove the block type
    const result = parse(await agent.callTool({
      name: "remove_block_type", arguments: { blockApiKey: "hero" },
    }));
    expect(result.deleted).toBe(true);
    expect(result.affectedFields).toBe(1);

    // Block table should be gone
    const tables = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='block_hero'"
        );
      }).pipe(Effect.provide(sqlLayer))
    );
    expect(tables).toHaveLength(0);

    // Model should be gone
    const models = parse(await agent.callTool({ name: "list_models", arguments: {} }));
    expect(models.find((m: any) => m.apiKey === "hero")).toBeUndefined();
    expect(models.find((m: any) => m.apiKey === "page")).toBeDefined();

    // DAST should be cleaned — block node removed, paragraphs preserved
    const records = parse(await agent.callTool({ name: "query_records", arguments: { modelApiKey: "page" } }));
    expect(records).toHaveLength(1);
    const content = typeof records[0].content === "string" ? JSON.parse(records[0].content) : records[0].content;
    // Should have 2 children (both paragraphs), not 3 (block node removed)
    expect(content.document.children).toHaveLength(2);
    expect(content.document.children[0].type).toBe("paragraph");
    expect(content.document.children[1].type).toBe("paragraph");

    // Whitelist should be updated
    const pageDetail = parse(await agent.callTool({ name: "describe_model", arguments: { apiKey: "page" } }));
    const stField = pageDetail.fields.find((f: any) => f.apiKey === "content");
    expect(stField.validators.structured_text_blocks).toEqual([]);
  });
});
