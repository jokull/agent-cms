import { describe, it, expect, beforeEach, vi } from "vitest";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { SqlClient } from "@effect/sql";
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

describe("Webhooks", () => {
  let agent: Client;
  let sqlLayer: any;

  beforeEach(async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-webhooks-"));
    const dbPath = join(tmpDir, "test.db");
    sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });
    Effect.runSync(runMigrations().pipe(Effect.provide(sqlLayer)));

    const mcpServer = createMcpServer(sqlLayer);
    agent = new Client({ name: "test", version: "1.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(st);
    await agent.connect(ct);
  });

  describe("Webhook CRUD via MCP", () => {
    it("creates a webhook", async () => {
      const result = parse(await agent.callTool({
        name: "create_webhook",
        arguments: {
          url: "https://example.com/hook",
          events: ["record.create", "record.publish"],
          name: "Deploy trigger",
        },
      }));
      expect(result.id).toBeTruthy();
      expect(result.url).toBe("https://example.com/hook");
      expect(result.events).toEqual(["record.create", "record.publish"]);
      expect(result.name).toBe("Deploy trigger");
      expect(result.active).toBe(true);
    });

    it("lists webhooks", async () => {
      await agent.callTool({
        name: "create_webhook",
        arguments: { url: "https://a.com/hook", events: ["record.create"] },
      });
      await agent.callTool({
        name: "create_webhook",
        arguments: { url: "https://b.com/hook", events: ["record.publish"] },
      });

      const result = parse(await agent.callTool({ name: "list_webhooks", arguments: {} }));
      expect(result).toHaveLength(2);
    });

    it("deletes a webhook", async () => {
      const created = parse(await agent.callTool({
        name: "create_webhook",
        arguments: { url: "https://x.com/hook", events: ["record.create"] },
      }));

      const deleteResult = parse(await agent.callTool({
        name: "delete_webhook",
        arguments: { webhookId: created.id },
      }));
      expect(deleteResult.deleted).toBe(true);

      const listed = parse(await agent.callTool({ name: "list_webhooks", arguments: {} }));
      expect(listed).toHaveLength(0);
    });

    it("rejects invalid event types", async () => {
      const res = await agent.callTool({
        name: "create_webhook",
        arguments: { url: "https://x.com/hook", events: ["invalid.event"] },
      });
      expect(res.isError).toBe(true);
    });
  });

  describe("Webhook firing integration", () => {
    it("record mutations trigger webhook fire attempts", async () => {
      // Mock global fetch to track calls
      const fetchCalls: { url: string; body: any }[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: any, init: any) => {
        fetchCalls.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
        return new Response("ok");
      }) as any;

      try {
        // Register webhook for all record events
        await agent.callTool({
          name: "create_webhook",
          arguments: {
            url: "https://hooks.example.com/rebuild",
            events: ["record.create", "record.update", "record.publish"],
          },
        });

        // Create model + field
        const model = parse(await agent.callTool({
          name: "create_model",
          arguments: { name: "Post", apiKey: "post" },
        }));
        parse(await agent.callTool({
          name: "create_field",
          arguments: { modelId: model.id, label: "Title", apiKey: "title", fieldType: "string" },
        }));

        // Create record — should fire webhook
        const record = parse(await agent.callTool({
          name: "create_record",
          arguments: { modelApiKey: "post", data: { title: "Hello" } },
        }));

        // Allow async fetch to settle
        await new Promise((r) => setTimeout(r, 50));

        expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
        const createCall = fetchCalls.find((c) => c.body.event === "record.create");
        expect(createCall).toBeDefined();
        expect(createCall!.url).toBe("https://hooks.example.com/rebuild");
        expect(createCall!.body.modelApiKey).toBe("post");

        // Publish — should fire webhook
        fetchCalls.length = 0;
        parse(await agent.callTool({
          name: "publish_record",
          arguments: { recordId: record.id, modelApiKey: "post" },
        }));
        await new Promise((r) => setTimeout(r, 50));

        const pubCall = fetchCalls.find((c) => c.body.event === "record.publish");
        expect(pubCall).toBeDefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
