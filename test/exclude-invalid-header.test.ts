import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("excludeInvalid via X-Exclude-Invalid header", () => {
  let handler: (req: Request) => Promise<Response>;
  let modelId: string;

  beforeEach(async () => {
    ({ handler } = createTestApp());
    const res = await jsonRequest(handler, "POST", "/api/models", { name: "Article", apiKey: "article" });
    const model = await res.json();
    modelId = model.id;
    await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string", validators: { required: true },
    });

    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "Valid" },
    });
    const invalid = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "Will be invalid" },
    }).then((res) => res.json());
    await jsonRequest(handler, "PATCH", `/api/records/${invalid.id}`, {
      modelApiKey: "article", data: { title: null },
    });
  });

  it("filters invalid records from list queries when sent as a request header", async () => {
    const result = await gqlQuery(handler, `{ allArticles { title _isValid } }`, undefined, {
      excludeInvalid: true,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data.allArticles).toHaveLength(1);
    expect(result.data.allArticles[0].title).toBe("Valid");
    expect(result.data.allArticles[0]._isValid).toBe(true);
  });

  it("filters invalid records from meta queries when sent as a request header", async () => {
    const result = await gqlQuery(handler, `{ _allArticlesMeta { count } }`, undefined, {
      excludeInvalid: true,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data._allArticlesMeta.count).toBe(1);
  });

  it("lets an explicit GraphQL argument override the header default", async () => {
    const result = await gqlQuery(handler, `{ allArticles(excludeInvalid: false) { title _isValid } }`, undefined, {
      excludeInvalid: true,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data.allArticles).toHaveLength(2);
    expect(result.data.allArticles.some((record: { _isValid: boolean }) => record._isValid === false)).toBe(true);
  });
});
