/**
 * Smoke test against the REAL CMS, not the hand-written fixture: build a
 * schema through agent-cms's own REST API (in-memory SQLite app), export it
 * via GET /api/schema, and run the generator over it. Guards the emitter
 * against the actual SchemaExport/validator shapes the CMS produces.
 *
 * Lives outside tsconfig's include (vitest-only): it imports the CMS source
 * tree, which compiles under the root tsconfig, not this package's.
 */
import { describe, expect, it } from "vitest";
import { createTestApp, jsonRequest } from "../../../test/app-helpers.js";
import { generate } from "../src/generate.ts";
import { parseSchemaExport } from "../src/schema-types.ts";

describe("generate over a real /api/schema export", () => {
  it("understands the CMS's actual validator and export shapes", async () => {
    const { handler } = createTestApp();

    const createModel = async (body: Record<string, unknown>) => {
      const res = await jsonRequest(handler, "POST", "/api/models", body);
      expect(res.status).toBe(201);
      const json = await res.json();
      return json.id as string;
    };
    const addField = async (modelId: string, body: Record<string, unknown>) => {
      const res = await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, body);
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    };

    const heroId = await createModel({ name: "Hero section", apiKey: "hero_section", isBlock: true });
    await addField(heroId, { label: "Heading", apiKey: "heading", fieldType: "string", validators: { required: {} } });

    const authorId = await createModel({ name: "Author", apiKey: "author" });
    await addField(authorId, { label: "Name", apiKey: "name", fieldType: "string", validators: { required: {} } });

    const postId = await createModel({ name: "Post", apiKey: "post" });
    await addField(postId, { label: "Title", apiKey: "title", fieldType: "string", validators: { required: {} } });
    await addField(postId, {
      label: "Tier",
      apiKey: "tier",
      fieldType: "string",
      validators: { enum: ["free", "member"] }, // the CMS wants a bare array (field-service.ts:133)
    });
    await addField(postId, {
      label: "Content",
      apiKey: "content",
      fieldType: "structured_text",
      validators: { structured_text_blocks: ["hero_section"] },
    });
    await addField(postId, {
      label: "Authors",
      apiKey: "authors",
      fieldType: "links",
      validators: { items_item_type: ["author"] },
    });

    const exportRes = await jsonRequest(handler, "GET", "/api/schema");
    expect(exportRes.status).toBe(200);
    const schema = parseSchemaExport(await exportRes.json());

    const files = generate(schema);
    const contract = files["contract.ts"];

    // The emitter must recover all of this from the REAL export encoding:
    expect(contract).toContain("export interface HeroSectionBlock");
    expect(contract).toContain('_type: "hero_section"');
    expect(contract).toContain("Record<string, HeroSectionBlock>"); // whitelist honored
    expect(contract).toContain("title: wire.string,"); // required survived export round-trip
    expect(contract).toContain('wire.literal("free")'); // enum values recovered
    expect(contract).toContain("record ids → author"); // links target recovered
    expect(contract).toContain("const post = {"); // record models get a fragment
    expect(contract).toContain("const author = {");
    expect(contract).toContain("return { author, post, assets };");
    expect(contract).not.toContain("const heroSection = {"); // block models get no procedures
  });
});
