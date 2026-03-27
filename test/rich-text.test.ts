import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { createTestApp, jsonRequest } from "./app-helpers.js";

describe("RichText (modular content) field type", () => {
  let handler: (req: Request) => Promise<Response>;
  let sqlLayer: any;
  let pageModelId: string;

  beforeEach(async () => {
    ({ handler, sqlLayer } = createTestApp());

    // Create block types
    const heroRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Hero Section", apiKey: "hero_section", isBlock: true,
    });
    const hero = await heroRes.json();

    await jsonRequest(handler, "POST", `/api/models/${hero.id}/fields`, {
      label: "Headline", apiKey: "headline", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${hero.id}/fields`, {
      label: "CTA URL", apiKey: "cta_url", fieldType: "string",
    });

    const ctaRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "CTA Block", apiKey: "cta_block", isBlock: true,
    });
    const cta = await ctaRes.json();
    await jsonRequest(handler, "POST", `/api/models/${cta.id}/fields`, {
      label: "Label", apiKey: "label", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${cta.id}/fields`, {
      label: "URL", apiKey: "url", fieldType: "string",
    });

    // Create content model with rich_text field
    const pageRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Page", apiKey: "page",
    });
    const page = await pageRes.json();
    pageModelId = page.id;

    await jsonRequest(handler, "POST", `/api/models/${page.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${page.id}/fields`, {
      label: "Modules", apiKey: "modules", fieldType: "rich_text",
      validators: { rich_text_blocks: ["hero_section", "cta_block"] },
    });
  });

  it("creates a field with rich_text type", async () => {
    const fieldsRes = await handler(new Request(`http://localhost/api/models/${pageModelId}/fields`));
    const fields = await fieldsRes.json();
    const rtField = fields.find((f: any) => f.api_key === "modules");
    expect(rtField).toBeDefined();
    expect(rtField.field_type).toBe("rich_text");
    expect(rtField.validators.rich_text_blocks).toEqual(["hero_section", "cta_block"]);
  });

  it("creates a record with rich_text blocks", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Home Page",
        modules: [
          { block_type: "hero_section", headline: "Welcome", cta_url: "https://example.com" },
          { block_type: "cta_block", label: "Sign Up", url: "https://example.com/signup" },
        ],
      },
    });

    expect(res.status).toBe(201);
    const record = await res.json();
    expect(record.title).toBe("Home Page");

    // Get the record and verify materialization
    const getRes = await handler(new Request(`http://localhost/api/records/${record.id}?modelApiKey=page`));
    const fromDb = await getRes.json();
    expect(fromDb.modules).toBeDefined();
    expect(Array.isArray(fromDb.modules)).toBe(true);
    expect(fromDb.modules).toHaveLength(2);
    expect(fromDb.modules[0]._type).toBe("hero_section");
    expect(fromDb.modules[0].headline).toBe("Welcome");
    expect(fromDb.modules[1]._type).toBe("cta_block");
    expect(fromDb.modules[1].label).toBe("Sign Up");
  });

  it("stores blocks in block tables with provenance", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Test",
        modules: [
          { block_type: "hero_section", headline: "Test Hero" },
        ],
      },
    });
    const record = await res.json();

    const blocks = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe<Record<string, any>>(
          'SELECT * FROM "block_hero_section" WHERE _root_record_id = ?',
          [record.id]
        );
      }).pipe(Effect.provide(sqlLayer))
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]._root_field_api_key).toBe("modules");
    expect(blocks[0]._parent_container_model_api_key).toBe("page");
    expect(blocks[0]._parent_block_id).toBeNull();
    expect(blocks[0]._depth).toBe(0);
    expect(blocks[0].headline).toBe("Test Hero");
  });

  it("validates block_type against whitelist", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Test",
        modules: [
          { block_type: "nonexistent_block", foo: "bar" },
        ],
      },
    });

    expect(res.status).toBe(400);
  });

  it("updates a rich_text field (replaces all blocks)", async () => {
    // Create
    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Update Test",
        modules: [
          { block_type: "hero_section", headline: "Original" },
        ],
      },
    });
    const record = await createRes.json();

    // Update with new blocks
    const updateRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}`, {
      modelApiKey: "page",
      data: {
        modules: [
          { block_type: "cta_block", label: "New CTA", url: "https://example.com" },
          { block_type: "hero_section", headline: "New Hero" },
        ],
      },
    });
    expect(updateRes.status).toBe(200);

    // Verify
    const getRes = await handler(new Request(`http://localhost/api/records/${record.id}?modelApiKey=page`));
    const fromDb = await getRes.json();
    expect(fromDb.modules).toHaveLength(2);
    expect(fromDb.modules[0]._type).toBe("cta_block");
    expect(fromDb.modules[0].label).toBe("New CTA");
    expect(fromDb.modules[1]._type).toBe("hero_section");
    expect(fromDb.modules[1].headline).toBe("New Hero");

    // Old blocks should be gone
    const oldBlocks = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe<Record<string, any>>(
          'SELECT * FROM "block_hero_section" WHERE _root_record_id = ? AND headline = ?',
          [record.id, "Original"]
        );
      }).pipe(Effect.provide(sqlLayer))
    );
    expect(oldBlocks).toHaveLength(0);
  });

  it("clears rich_text field with null", async () => {
    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Clear Test",
        modules: [
          { block_type: "hero_section", headline: "To be cleared" },
        ],
      },
    });
    const record = await createRes.json();

    const updateRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}`, {
      modelApiKey: "page",
      data: { modules: null },
    });
    expect(updateRes.status).toBe(200);

    const getRes = await handler(new Request(`http://localhost/api/records/${record.id}?modelApiKey=page`));
    const fromDb = await getRes.json();
    expect(fromDb.modules).toBeNull();
  });

  it("rejects rich_text_blocks validator on non-rich_text field", async () => {
    const res = await jsonRequest(handler, "POST", `/api/models/${pageModelId}/fields`, {
      label: "Bad Field", apiKey: "bad_field", fieldType: "string",
      validators: { rich_text_blocks: ["hero_section"] },
    });
    expect(res.status).toBe(400);
  });

  it("creates empty rich_text field (empty array)", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Empty Modules",
        modules: [],
      },
    });

    expect(res.status).toBe(201);
    const record = await res.json();

    const getRes = await handler(new Request(`http://localhost/api/records/${record.id}?modelApiKey=page`));
    const fromDb = await getRes.json();
    expect(fromDb.modules).toEqual([]);
  });

  it("preserves block order", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Order Test",
        modules: [
          { block_type: "cta_block", label: "First" },
          { block_type: "hero_section", headline: "Second" },
          { block_type: "cta_block", label: "Third" },
        ],
      },
    });
    expect(res.status).toBe(201);
    const record = await res.json();

    const getRes = await handler(new Request(`http://localhost/api/records/${record.id}?modelApiKey=page`));
    const fromDb = await getRes.json();
    expect(fromDb.modules).toHaveLength(3);
    expect(fromDb.modules[0].label).toBe("First");
    expect(fromDb.modules[1].headline).toBe("Second");
    expect(fromDb.modules[2].label).toBe("Third");
  });
});

describe("RichText GraphQL", () => {
  let handler: (req: Request) => Promise<Response>;
  let sqlLayer: any;

  beforeEach(async () => {
    ({ handler, sqlLayer } = createTestApp());

    // Create block type
    const heroRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Hero Section", apiKey: "hero_section", isBlock: true,
    });
    const hero = await heroRes.json();
    await jsonRequest(handler, "POST", `/api/models/${hero.id}/fields`, {
      label: "Headline", apiKey: "headline", fieldType: "string",
    });

    const ctaRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "CTA Block", apiKey: "cta_block", isBlock: true,
    });
    const cta = await ctaRes.json();
    await jsonRequest(handler, "POST", `/api/models/${cta.id}/fields`, {
      label: "Label", apiKey: "label", fieldType: "string",
    });

    // Create content model
    const pageRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Page", apiKey: "page",
    });
    const page = await pageRes.json();
    await jsonRequest(handler, "POST", `/api/models/${page.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${page.id}/fields`, {
      label: "Modules", apiKey: "modules", fieldType: "rich_text",
      validators: { rich_text_blocks: ["hero_section", "cta_block"] },
    });

    // Create a record
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "page",
      data: {
        title: "Home",
        modules: [
          { block_type: "hero_section", headline: "Welcome" },
          { block_type: "cta_block", label: "Get Started" },
        ],
      },
    });
  });

  it("returns rich_text blocks via GraphQL with union types", async () => {
    const query = `{
      allPages {
        title
        modules {
          ... on HeroSectionRecord {
            id
            _modelApiKey
            headline
          }
          ... on CtaBlockRecord {
            id
            _modelApiKey
            label
          }
        }
      }
    }`;

    const gqlRes = await handler(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Include-Drafts": "true",
        },
        body: JSON.stringify({ query }),
      })
    );

    expect(gqlRes.status).toBe(200);
    const body = await gqlRes.json();
    expect(body.errors).toBeUndefined();
    const pages = body.data.allPages;
    expect(pages).toHaveLength(1);
    expect(pages[0].title).toBe("Home");
    expect(pages[0].modules).toHaveLength(2);
    expect(pages[0].modules[0]._modelApiKey).toBe("hero_section");
    expect(pages[0].modules[0].headline).toBe("Welcome");
    expect(pages[0].modules[1]._modelApiKey).toBe("cta_block");
    expect(pages[0].modules[1].label).toBe("Get Started");
  });
});
