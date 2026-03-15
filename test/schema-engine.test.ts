import { describe, it, expect } from "vitest";
import { getTableName, getTableColumns } from "drizzle-orm";
import { generateSchema, type ModelRow, type FieldRow } from "../src/schema-engine/index.js";

function makeModel(overrides: Partial<ModelRow> & { apiKey: string }): ModelRow {
  return {
    id: overrides.id ?? `model_${overrides.apiKey}`,
    name: overrides.name ?? overrides.apiKey,
    apiKey: overrides.apiKey,
    isBlock: overrides.isBlock ?? false,
    singleton: overrides.singleton ?? false,
    sortable: overrides.sortable ?? false,
    tree: overrides.tree ?? false,
    hasDraft: overrides.hasDraft ?? true,
  };
}

function makeField(
  overrides: Partial<FieldRow> & { modelId: string; apiKey: string; fieldType: string }
): FieldRow {
  return {
    id: overrides.id ?? `field_${overrides.apiKey}`,
    modelId: overrides.modelId,
    label: overrides.label ?? overrides.apiKey,
    apiKey: overrides.apiKey,
    fieldType: overrides.fieldType,
    position: overrides.position ?? 0,
    localized: overrides.localized ?? false,
    validators: overrides.validators ?? {},
  };
}

describe("Schema Engine", () => {
  describe("generateSchema", () => {
    it("generates a content table for a simple model", () => {
      const models = [makeModel({ apiKey: "article" })];
      const fields = [
        makeField({ modelId: "model_article", apiKey: "title", fieldType: "string", position: 0 }),
        makeField({ modelId: "model_article", apiKey: "body", fieldType: "text", position: 1 }),
      ];

      const schema = generateSchema(models, fields);

      expect(schema.tables.has("article")).toBe(true);
      const table = schema.tables.get("article")!;
      expect(getTableName(table)).toBe("content_article");

      const columns = getTableColumns(table);
      // System columns
      expect(columns).toHaveProperty("id");
      expect(columns).toHaveProperty("_status");
      expect(columns).toHaveProperty("_publishedAt");
      expect(columns).toHaveProperty("_firstPublishedAt");
      expect(columns).toHaveProperty("_publishedSnapshot");
      expect(columns).toHaveProperty("_createdAt");
      expect(columns).toHaveProperty("_updatedAt");
      // Field columns
      expect(columns).toHaveProperty("title");
      expect(columns).toHaveProperty("body");
    });

    it("generates a block table for a block model", () => {
      const models = [makeModel({ apiKey: "hero_section", isBlock: true })];
      const fields = [
        makeField({ modelId: "model_hero_section", apiKey: "headline", fieldType: "string" }),
        makeField({ modelId: "model_hero_section", apiKey: "subheadline", fieldType: "text" }),
      ];

      const schema = generateSchema(models, fields);

      expect(schema.tables.has("hero_section")).toBe(true);
      const table = schema.tables.get("hero_section")!;
      expect(getTableName(table)).toBe("block_hero_section");

      const columns = getTableColumns(table);
      // Block ownership columns
      expect(columns).toHaveProperty("id");
      expect(columns).toHaveProperty("_rootRecordId");
      expect(columns).toHaveProperty("_rootFieldApiKey");
      // Field columns
      expect(columns).toHaveProperty("headline");
      expect(columns).toHaveProperty("subheadline");
      // Should NOT have content table system columns
      expect(columns).not.toHaveProperty("_status");
      expect(columns).not.toHaveProperty("_publishedSnapshot");
    });

    it("maps all v1 field types to columns", () => {
      const model = makeModel({ apiKey: "kitchen_sink" });
      const fieldTypes = [
        "string",
        "text",
        "boolean",
        "integer",
        "slug",
        "media",
        "media_gallery",
        "link",
        "links",
        "structured_text",
      ] as const;

      const fields = fieldTypes.map((ft, i) =>
        makeField({
          modelId: model.id,
          apiKey: `field_${ft}`,
          fieldType: ft,
          position: i,
        })
      );

      const schema = generateSchema([model], fields);
      const table = schema.tables.get("kitchen_sink")!;
      const columns = getTableColumns(table);

      for (const ft of fieldTypes) {
        expect(columns).toHaveProperty(`field_${ft}`);
      }
    });

    it("handles models with no fields", () => {
      const models = [makeModel({ apiKey: "empty" })];
      const schema = generateSchema(models, []);

      const table = schema.tables.get("empty")!;
      const columns = getTableColumns(table);
      // Should still have system columns
      expect(columns).toHaveProperty("id");
      expect(columns).toHaveProperty("_status");
    });

    it("correctly assigns fields to their respective models", () => {
      const models = [
        makeModel({ apiKey: "post" }),
        makeModel({ apiKey: "author" }),
      ];
      const fields = [
        makeField({ modelId: "model_post", apiKey: "title", fieldType: "string" }),
        makeField({ modelId: "model_post", apiKey: "body", fieldType: "text" }),
        makeField({ modelId: "model_author", apiKey: "name", fieldType: "string" }),
      ];

      const schema = generateSchema(models, fields);

      const postCols = getTableColumns(schema.tables.get("post")!);
      const authorCols = getTableColumns(schema.tables.get("author")!);

      expect(postCols).toHaveProperty("title");
      expect(postCols).toHaveProperty("body");
      expect(postCols).not.toHaveProperty("name");

      expect(authorCols).toHaveProperty("name");
      expect(authorCols).not.toHaveProperty("title");
    });

    it("preserves model and field metadata in the result", () => {
      const models = [makeModel({ apiKey: "post", singleton: true })];
      const fields = [
        makeField({
          modelId: "model_post",
          apiKey: "title",
          fieldType: "string",
          validators: { required: true },
        }),
      ];

      const schema = generateSchema(models, fields);

      expect(schema.models.get("post")!.singleton).toBe(true);
      expect(schema.fields.get("post")![0].validators).toEqual({ required: true });
    });

    it("sorts fields by position", () => {
      const models = [makeModel({ apiKey: "post" })];
      const fields = [
        makeField({ modelId: "model_post", apiKey: "body", fieldType: "text", position: 2 }),
        makeField({ modelId: "model_post", apiKey: "title", fieldType: "string", position: 0 }),
        makeField({ modelId: "model_post", apiKey: "slug", fieldType: "slug", position: 1 }),
      ];

      const schema = generateSchema(models, fields);
      const fieldKeys = schema.fields.get("post")!.map((f) => f.apiKey);
      expect(fieldKeys).toEqual(["title", "slug", "body"]);
    });
  });
});
