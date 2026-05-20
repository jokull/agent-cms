import { describe, expect, it } from "vitest";
import { generateSchemaConstantsModule } from "../scripts/dato-import/core/schema-codegen.mjs";

describe("Dato schema constants codegen", () => {
  it("generates model and field API key constants", () => {
    const source = generateSchemaConstantsModule({
      models: [
        {
          apiKey: "article",
          fields: [
            { apiKey: "title" },
            { apiKey: "body" },
          ],
        },
        {
          api_key: "callout",
          fields: [
            { api_key: "message" },
          ],
        },
      ],
    });

    expect(source).toContain('export const MODEL_API_KEYS = {');
    expect(source).toContain('"article": "article"');
    expect(source).toContain('"callout": "callout"');
    expect(source).toContain('export const FIELD_API_KEYS = {');
    expect(source).toContain('"body": "body"');
    expect(source).toContain("export type ModelApiKey");
  });

  it("rejects duplicate model keys", () => {
    expect(() =>
      generateSchemaConstantsModule({
        models: [
          { apiKey: "article", fields: [] },
          { apiKey: "article", fields: [] },
        ],
      })
    ).toThrow('Duplicate model apiKey "article"');
  });

  it("rejects duplicate field keys within a model", () => {
    expect(() =>
      generateSchemaConstantsModule({
        models: [
          {
            apiKey: "article",
            fields: [
              { apiKey: "title" },
              { apiKey: "title" },
            ],
          },
        ],
      })
    ).toThrow('Duplicate field for model "article" apiKey "title"');
  });
});
