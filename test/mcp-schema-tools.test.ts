import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
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

describe("MCP schema management tools", () => {
  let agent: Client;
  let sqlLayer: any;

  beforeEach(async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-mcp-schema-"));
    const dbPath = join(tmpDir, "test.db");
    sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });
    Effect.runSync(runMigrations("./drizzle").pipe(Effect.provide(sqlLayer)));

    const mcpServer = createMcpServer(sqlLayer);
    agent = new Client({ name: "test", version: "1.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(st);
    await agent.connect(ct);
  });

  describe("update_model", () => {
    it("updates model name", async () => {
      const model = parse(await agent.callTool({
        name: "create_model",
        arguments: { name: "Post", apiKey: "post" },
      }));

      const updated = parse(await agent.callTool({
        name: "update_model",
        arguments: { modelId: model.id, name: "BlogPost" },
      }));

      expect(updated.name).toBe("BlogPost");
    });
  });

  describe("update_field", () => {
    it("updates field label and hint", async () => {
      const model = parse(await agent.callTool({
        name: "create_model",
        arguments: { name: "Post", apiKey: "post" },
      }));

      const field = parse(await agent.callTool({
        name: "create_field",
        arguments: { modelId: model.id, label: "Title", apiKey: "title", fieldType: "string" },
      }));

      const updated = parse(await agent.callTool({
        name: "update_field",
        arguments: { fieldId: field.id, label: "Post Title", hint: "The main heading" },
      }));

      expect(updated.label).toBe("Post Title");
      expect(updated.hint).toBe("The main heading");
    });
  });

  describe("schema_info", () => {
    beforeEach(async () => {
      const model = parse(await agent.callTool({
        name: "create_model",
        arguments: { name: "Post", apiKey: "post" },
      }));
      parse(await agent.callTool({
        name: "create_field",
        arguments: { modelId: model.id, label: "Title", apiKey: "title", fieldType: "string" },
      }));
      parse(await agent.callTool({
        name: "create_field",
        arguments: { modelId: model.id, label: "Body", apiKey: "body", fieldType: "text" },
      }));

      const block = parse(await agent.callTool({
        name: "create_model",
        arguments: { name: "Hero", apiKey: "hero", isBlock: true },
      }));
      parse(await agent.callTool({
        name: "create_field",
        arguments: { modelId: block.id, label: "Headline", apiKey: "headline", fieldType: "string" },
      }));
    });

    it("returns full schema with field details", async () => {
      const info = parse(await agent.callTool({
        name: "schema_info",
        arguments: {},
      }));

      expect(info.models).toHaveLength(2);
      const post = info.models.find((m: any) => m.apiKey === "post");
      expect(post).toBeDefined();
      expect(post.isBlock).toBe(false);
      expect(post.fields).toHaveLength(2);
      expect(post.fields[0].apiKey).toBe("title");
      expect(post.fields[0].type).toBe("string");

      const hero = info.models.find((m: any) => m.apiKey === "hero");
      expect(hero).toBeDefined();
      expect(hero.isBlock).toBe(true);
      expect(hero.fields).toHaveLength(1);
    });

    it("filters by type", async () => {
      const blocksOnly = parse(await agent.callTool({
        name: "schema_info",
        arguments: { filterByType: "block" },
      }));

      expect(blocksOnly.models).toHaveLength(1);
      expect(blocksOnly.models[0].apiKey).toBe("hero");
    });

    it("filters by name", async () => {
      const filtered = parse(await agent.callTool({
        name: "schema_info",
        arguments: { filterByName: "post" },
      }));

      expect(filtered.models).toHaveLength(1);
      expect(filtered.models[0].apiKey).toBe("post");
    });

    it("returns compact info without field details", async () => {
      const compact = parse(await agent.callTool({
        name: "schema_info",
        arguments: { includeFieldDetails: false },
      }));

      const post = compact.models.find((m: any) => m.apiKey === "post");
      expect(post.fields).toBeUndefined();
      expect(post.fieldCount).toBe(2);
      expect(post.fieldNames).toEqual(["title", "body"]);
    });
  });
});
