import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { SqlClient } from "@effect/sql";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { runMigrations } from "./migrate.js";
import { generateId } from "../src/id.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTestMcpClient, parseToolResult as parse } from "./mcp-helpers.js";

describe("Schema Lifecycle — Advanced Operations", () => {
  let agent: Client;
  let sqlLayer: any;

  beforeEach(async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-lifecycle-"));
    const dbPath = join(tmpDir, "test.db");
    sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });
    Effect.runSync(runMigrations().pipe(Effect.provide(sqlLayer)));

    ({ client: agent } = await createTestMcpClient(sqlLayer));
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
        name: "remove_block",
        arguments: { blockApiKey: "hero", fieldId: stField.id },
      }));
      expect(result.removed).toBe("hero");

      // DAST should have hero block removed, paragraph + cta preserved
      const records = parse(await agent.callTool({ name: "query_records", arguments: { modelApiKey: "page" } }));
      const content = typeof records[0].content === "string" ? JSON.parse(records[0].content) : records[0].content;
      expect(content.value.document.children).toHaveLength(2);
      expect(content.value.document.children[0].type).toBe("paragraph");
      expect(content.value.document.children[1].type).toBe("block"); // CTA still there
      expect(content.value.document.children[1].item).toBe(ctaId);

      // Whitelist should only have "cta" now
      const pageDetail = parse(await agent.callTool({ name: "schema_info", arguments: { filterByName: "page" } })).models[0];
      expect(pageDetail.fields[0].validators.structured_text_blocks).toEqual(["cta"]);

      // Hero block type still exists as a model
      const schemaResult = parse(await agent.callTool({ name: "schema_info", arguments: {} }));
      expect(schemaResult.models.find((m: any) => m.apiKey === "hero")).toBeDefined();
    });
  });

  describe("P4.6: Locale removal", () => {
    it("removes a locale and strips it from all localized field values", async () => {
      // Create locales via SQL (no locale MCP tools yet)
      const enId = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const id = generateId();
          yield* sql.unsafe("INSERT INTO locales (id, code, position) VALUES (?, ?, ?)", [id, "en", 0]);
          return id;
        }).pipe(Effect.provide(sqlLayer))
      );
      const isId = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const id = generateId();
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

  describe("P5.4: Inline structured_text shorthand in create_record", () => {
    it("creates a record with typed nodes shorthand via MCP", async () => {
      const hero = parse(await agent.callTool({
        name: "create_model",
        arguments: { name: "Hero Section", apiKey: "hero_section", isBlock: true },
      }));
      parse(await agent.callTool({
        name: "create_field",
        arguments: { modelId: hero.id, label: "Headline", apiKey: "headline", fieldType: "string" },
      }));

      const page = parse(await agent.callTool({
        name: "create_model",
        arguments: { name: "Page", apiKey: "page" },
      }));
      parse(await agent.callTool({
        name: "create_field",
        arguments: {
          modelId: page.id,
          label: "Content",
          apiKey: "content",
          fieldType: "structured_text",
          validators: { structured_text_blocks: ["hero_section"] },
        },
      }));

      // Create record with inline { nodes, blocks } shorthand
      parse(await agent.callTool({
        name: "create_record",
        arguments: {
          modelApiKey: "page",
          data: {
            content: {
              nodes: [
                { type: "paragraph", text: "Intro with **bold** copy." },
                { type: "block", ref: "hero-1" },
                { type: "paragraph", text: "Closing line." },
              ],
              blocks: [
                { id: "hero-1", type: "hero_section", data: { headline: "Hello from MCP" } },
              ],
            },
          },
        },
      }));

      const records = parse(await agent.callTool({ name: "query_records", arguments: { modelApiKey: "page" } }));
      const content = typeof records[0].content === "string" ? JSON.parse(records[0].content) : records[0].content;

      expect(content.value.schema).toBe("dast");
      expect(content.value.document.children).toHaveLength(3);
      expect(content.value.document.children[0].type).toBe("paragraph");
      expect(content.value.document.children[1]).toEqual({ type: "block", item: "hero-1" });
      expect(content.value.document.children[2].type).toBe("paragraph");

      const blocks = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql.unsafe<Record<string, any>>(
            'SELECT * FROM "block_hero_section" WHERE _root_record_id = ?',
            [records[0].id],
          );
        }).pipe(Effect.provide(sqlLayer))
      );

      expect(blocks).toHaveLength(1);
      expect(blocks[0].id).toBe("hero-1");
      expect(blocks[0].headline).toBe("Hello from MCP");
      expect(blocks[0]._root_field_api_key).toBe("content");
    });

    it("creates a record with markdown shorthand via MCP", async () => {
      const page = parse(await agent.callTool({
        name: "create_model",
        arguments: { name: "Page", apiKey: "page" },
      }));
      parse(await agent.callTool({
        name: "create_field",
        arguments: {
          modelId: page.id,
          label: "Content",
          apiKey: "content",
          fieldType: "structured_text",
        },
      }));

      // Create record with markdown string shorthand
      parse(await agent.callTool({
        name: "create_record",
        arguments: {
          modelApiKey: "page",
          data: {
            content: "# Hello\n\nThis is **bold** text.",
          },
        },
      }));

      const records = parse(await agent.callTool({ name: "query_records", arguments: { modelApiKey: "page" } }));
      const content = typeof records[0].content === "string" ? JSON.parse(records[0].content) : records[0].content;

      expect(content.value.schema).toBe("dast");
      expect(content.value.document.children).toHaveLength(2);
      expect(content.value.document.children[0].type).toBe("heading");
      expect(content.value.document.children[1].type).toBe("paragraph");
    });
  });
});
