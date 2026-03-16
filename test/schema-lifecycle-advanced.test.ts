import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { SqlClient } from "@effect/sql";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { runMigrations } from "./migrate.js";
import { ulid } from "ulidx";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function parse(res: any): any {
  if (res.isError) throw new Error(`Tool error: ${res.content[0]?.text}`);
  return JSON.parse(res.content[0]?.text ?? "null");
}

describe("Schema Lifecycle — Advanced Operations", () => {
  let agent: Client;
  let sqlLayer: any;

  beforeEach(async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-lifecycle-"));
    const dbPath = join(tmpDir, "test.db");
    sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });
    Effect.runSync(runMigrations("./drizzle").pipe(Effect.provide(sqlLayer)));

    const mcpServer = createMcpServer(sqlLayer);
    agent = new Client({ name: "test", version: "1.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(st);
    await agent.connect(ct);
  });

  describe("P4.5: Block whitelist removal", () => {
    it("removes a block from whitelist, cleans DAST, keeps block type", async () => {
      // Create two block types
      const hero = parse(await agent.callTool({ name: "create_model", arguments: { name: "Hero", apiKey: "hero", isBlock: true } }));
      parse(await agent.callTool({ name: "create_field", arguments: { modelId: hero.id, label: "H", apiKey: "headline", fieldType: "string" } }));
      const cta = parse(await agent.callTool({ name: "create_model", arguments: { name: "CTA", apiKey: "cta", isBlock: true } }));
      parse(await agent.callTool({ name: "create_field", arguments: { modelId: cta.id, label: "T", apiKey: "text", fieldType: "string" } }));

      // Content model allowing both
      const page = parse(await agent.callTool({ name: "create_model", arguments: { name: "Page", apiKey: "page" } }));
      const stField = parse(await agent.callTool({
        name: "create_field",
        arguments: { modelId: page.id, label: "Content", apiKey: "content", fieldType: "structured_text", validators: { structured_text_blocks: ["hero", "cta"] } },
      }));

      // Create record with both block types
      const heroId = "01HWLR_HERO_1";
      const ctaId = "01HWLR_CTA_1";
      parse(await agent.callTool({
        name: "create_record",
        arguments: {
          modelApiKey: "page",
          data: {
            content: {
              value: { schema: "dast", document: { type: "root", children: [
                { type: "block", item: heroId },
                { type: "paragraph", children: [{ type: "span", value: "middle" }] },
                { type: "block", item: ctaId },
              ] } },
              blocks: {
                [heroId]: { _type: "hero", headline: "Welcome" },
                [ctaId]: { _type: "cta", text: "Click me" },
              },
            },
          },
        },
      }));

      // Remove "hero" from whitelist (keep the type itself)
      const result = parse(await agent.callTool({
        name: "remove_block_from_whitelist",
        arguments: { fieldId: stField.id, blockApiKey: "hero" },
      }));
      expect(result.removed).toBe("hero");

      // DAST should have hero block removed, paragraph + cta preserved
      const records = parse(await agent.callTool({ name: "query_records", arguments: { modelApiKey: "page" } }));
      const content = typeof records[0].content === "string" ? JSON.parse(records[0].content) : records[0].content;
      expect(content.document.children).toHaveLength(2);
      expect(content.document.children[0].type).toBe("paragraph");
      expect(content.document.children[1].type).toBe("block"); // CTA still there
      expect(content.document.children[1].item).toBe(ctaId);

      // Whitelist should only have "cta" now
      const pageDetail = parse(await agent.callTool({ name: "describe_model", arguments: { apiKey: "page" } }));
      expect(pageDetail.fields[0].validators.structured_text_blocks).toEqual(["cta"]);

      // Hero block type still exists as a model
      const models = parse(await agent.callTool({ name: "list_models", arguments: {} }));
      expect(models.find((m: any) => m.apiKey === "hero")).toBeDefined();
    });
  });

  describe("P4.6: Locale removal", () => {
    it("removes a locale and strips it from all localized field values", async () => {
      // Create locales via SQL (no locale MCP tools yet)
      const enId = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const id = ulid();
          yield* sql.unsafe("INSERT INTO locales (id, code, position) VALUES (?, ?, ?)", [id, "en", 0]);
          return id;
        }).pipe(Effect.provide(sqlLayer))
      );
      const isId = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const id = ulid();
          yield* sql.unsafe("INSERT INTO locales (id, code, position, fallback_locale_id) VALUES (?, ?, ?, ?)", [id, "is", 1, enId]);
          return id;
        }).pipe(Effect.provide(sqlLayer))
      );

      // Create model with localized field
      const article = parse(await agent.callTool({ name: "create_model", arguments: { name: "Article", apiKey: "article" } }));
      parse(await agent.callTool({
        name: "create_field",
        arguments: { modelId: article.id, label: "Title", apiKey: "title", fieldType: "string", localized: true },
      }));

      // Create record with both locales
      parse(await agent.callTool({
        name: "create_record",
        arguments: { modelApiKey: "article", data: { title: { en: "Hello", is: "Halló" } } },
      }));

      // Remove Icelandic locale
      const result = parse(await agent.callTool({
        name: "remove_locale",
        arguments: { localeId: isId },
      }));
      expect(result.deleted).toBe("is");
      expect(result.updatedRecords).toBe(1);

      // Verify the Icelandic value was stripped
      const records = parse(await agent.callTool({ name: "query_records", arguments: { modelApiKey: "article" } }));
      const title = typeof records[0].title === "string" ? JSON.parse(records[0].title) : records[0].title;
      expect(title).toEqual({ en: "Hello" });
      expect(title.is).toBeUndefined();
    });
  });

  describe("P5.4: StructuredText helper tool", () => {
    it("builds a valid DAST document from prose and blocks", async () => {
      const result = parse(await agent.callTool({
        name: "build_structured_text",
        arguments: {
          paragraphs: ["Welcome to our site.", "We build great things."],
          blocks: [
            { type: "hero_section", data: { headline: "Hello World" } },
          ],
        },
      }));

      expect(result.value.schema).toBe("dast");
      expect(result.value.document.type).toBe("root");

      // Should interleave: paragraph, block, paragraph
      const children = result.value.document.children;
      expect(children).toHaveLength(3);
      expect(children[0].type).toBe("paragraph");
      expect(children[0].children[0].value).toBe("Welcome to our site.");
      expect(children[1].type).toBe("block");
      expect(children[2].type).toBe("paragraph");

      // Block should have auto-generated ULID
      const blockId = children[1].item;
      expect(blockId).toBeTruthy();
      expect(result.blocks[blockId]).toBeDefined();
      expect(result.blocks[blockId]._type).toBe("hero_section");
      expect(result.blocks[blockId].headline).toBe("Hello World");
    });

    it("builds blocks-only content", async () => {
      const result = parse(await agent.callTool({
        name: "build_structured_text",
        arguments: {
          blocks: [
            { type: "hero", data: { headline: "A" } },
            { type: "cta", data: { text: "B" } },
          ],
        },
      }));

      expect(result.value.document.children).toHaveLength(2);
      expect(result.value.document.children[0].type).toBe("block");
      expect(result.value.document.children[1].type).toBe("block");
      expect(Object.keys(result.blocks)).toHaveLength(2);
    });

    it("builds prose-only content", async () => {
      const result = parse(await agent.callTool({
        name: "build_structured_text",
        arguments: {
          paragraphs: ["Hello", "World"],
        },
      }));

      expect(result.value.document.children).toHaveLength(2);
      expect(result.blocks).toEqual({});
    });
  });
});
