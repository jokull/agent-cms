import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("_isValid computed field + publish gate", () => {
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
    await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
      label: "Body", apiKey: "body", fieldType: "text",
    });
  });

  it("_isValid: true when all required fields have values", async () => {
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "Hello", body: "World" },
    });
    const result = await gqlQuery(handler, `{ allArticles { _isValid title } }`);
    expect(result.data.allArticles[0]._isValid).toBe(true);
  });

  it("_isValid: false when required field is null (via patch)", async () => {
    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "Hello", body: "World" },
    });
    const record = await createRes.json();

    // Patch title to null
    await jsonRequest(handler, "PATCH", `/api/records/${record.id}`, {
      modelApiKey: "article", data: { title: null },
    });

    const result = await gqlQuery(handler, `{ allArticles { _isValid title } }`);
    expect(result.data.allArticles[0]._isValid).toBe(false);
  });

  it("patchRecord allows setting required field to null (HTTP 200)", async () => {
    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "Hello" },
    });
    const record = await createRes.json();

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}`, {
      modelApiKey: "article", data: { title: null },
    });
    expect(patchRes.status).toBe(200);
  });

  it("publishRecord rejects invalid record (missing required field)", async () => {
    // Create valid, then patch to null
    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "Hello", body: "Some body" },
    });
    const record = await createRes.json();

    await jsonRequest(handler, "PATCH", `/api/records/${record.id}`, {
      modelApiKey: "article", data: { title: null },
    });

    const pubRes = await handler(
      new Request(`http://localhost/api/records/${record.id}/publish?modelApiKey=article`, { method: "POST" })
    );
    expect(pubRes.status).toBe(400);
    const body = await pubRes.json();
    expect(body.error).toContain("title");
  });

  it("publishRecord succeeds for valid record", async () => {
    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "Valid", body: "Content" },
    });
    const record = await createRes.json();

    const pubRes = await handler(
      new Request(`http://localhost/api/records/${record.id}/publish?modelApiKey=article`, { method: "POST" })
    );
    expect(pubRes.status).toBe(200);
    const published = await pubRes.json();
    expect(published._status).toBe("published");
  });

  it("excludeInvalid: true filters invalid records from list queries", async () => {
    // Create two valid records
    const r1 = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "Valid", body: "Content" },
    });
    const rec1 = await r1.json();
    const r2 = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "WillBeNull", body: "No title" },
    });
    const rec2 = await r2.json();

    // Patch second to null title
    await jsonRequest(handler, "PATCH", `/api/records/${rec2.id}`, {
      modelApiKey: "article", data: { title: null },
    });

    const allResult = await gqlQuery(handler, `{ allArticles { _isValid title } }`);
    expect(allResult.data.allArticles).toHaveLength(2);

    const filteredResult = await gqlQuery(handler, `{ allArticles(excludeInvalid: true) { _isValid title } }`);
    expect(filteredResult.data.allArticles).toHaveLength(1);
    expect(filteredResult.data.allArticles[0].title).toBe("Valid");
  });

  it("excludeInvalid on _allXxxMeta returns correct count", async () => {
    const r1 = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "Valid" },
    });
    const r2 = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "WillBeNull" },
    });
    const rec2 = await r2.json();

    await jsonRequest(handler, "PATCH", `/api/records/${rec2.id}`, {
      modelApiKey: "article", data: { title: null },
    });

    const allMeta = await gqlQuery(handler, `{ _allArticlesMeta { count } }`);
    expect(allMeta.data._allArticlesMeta.count).toBe(2);

    const filteredMeta = await gqlQuery(handler, `{ _allArticlesMeta(excludeInvalid: true) { count } }`);
    expect(filteredMeta.data._allArticlesMeta.count).toBe(1);
  });

  it("_isValid reflects schema changes (updateField adding required: true)", async () => {
    // Create record with body=null (body is not required yet)
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "Hello", body: null },
    });

    // Initially valid (only title is required)
    const result1 = await gqlQuery(handler, `{ allArticles { _isValid } }`);
    expect(result1.data.allArticles[0]._isValid).toBe(true);

    // Get body field ID
    const fieldsRes = await handler(new Request(`http://localhost/api/models/${modelId}/fields`));
    const fields = await fieldsRes.json();
    const bodyField = fields.find((f: { api_key: string }) => f.api_key === "body");

    // Update body to be required
    const updateRes = await jsonRequest(handler, "PATCH", `/api/models/${modelId}/fields/${bodyField.id}`, {
      validators: { required: true },
    });
    expect(updateRes.status).toBe(200);
    const updatedField = await updateRes.json();
    expect(updatedField.validators.required).toBe(true);

    // Now the record should be invalid (body is null but required)
    const result2 = await gqlQuery(handler, `{ allArticles { _isValid } }`);
    expect(result2.data.allArticles[0]._isValid).toBe(false);
  });

  it("_isValid with localized required fields", async () => {
    // Create a new app with locales
    const app = createTestApp();
    const h = app.handler;

    // Set up locales
    await jsonRequest(h, "POST", "/api/locales", { code: "en" });
    await jsonRequest(h, "POST", "/api/locales", { code: "is" });

    // Create model with localized required field
    const modelRes = await jsonRequest(h, "POST", "/api/models", { name: "Page", apiKey: "page" });
    const pageModel = await modelRes.json();
    await jsonRequest(h, "POST", `/api/models/${pageModel.id}/fields`, {
      label: "Heading", apiKey: "heading", fieldType: "string", localized: true, validators: { required: true },
    });

    // Create record with default locale value
    await jsonRequest(h, "POST", "/api/records", {
      modelApiKey: "page", data: { heading: { en: "Hello" } },
    });

    const result = await gqlQuery(h, `{ allPages { _isValid } }`);
    expect(result.data.allPages[0]._isValid).toBe(true);

    // Create record without default locale value
    await jsonRequest(h, "POST", "/api/records", {
      modelApiKey: "page", data: { heading: { is: "Halló" } },
    });

    const result2 = await gqlQuery(h, `{ allPages { _isValid } }`);
    // One valid (has en), one invalid (missing en)
    const validCount = result2.data.allPages.filter((r: { _isValid: boolean }) => r._isValid).length;
    const invalidCount = result2.data.allPages.filter((r: { _isValid: boolean }) => !r._isValid).length;
    expect(validCount).toBe(1);
    expect(invalidCount).toBe(1);
  });

  it("_isValid and publish gate respect enum validators", async () => {
    await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
      label: "Status", apiKey: "status", fieldType: "string", validators: { enum: ["draft", "review"] },
    });

    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "Hello", status: "published" },
    });
    const record = await createRes.json();

    const result = await gqlQuery(handler, `{ allArticles { _isValid status } }`);
    expect(result.data.allArticles[0]._isValid).toBe(false);

    const pubRes = await handler(
      new Request(`http://localhost/api/records/${record.id}/publish?modelApiKey=article`, { method: "POST" })
    );
    expect(pubRes.status).toBe(400);
    const body = await pubRes.json();
    expect(body.error).toContain("status");
  });

  it("_isValid respects length and format validators", async () => {
    await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
      label: "Email", apiKey: "email", fieldType: "string", validators: { format: "email" },
    });
    await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
      label: "Excerpt", apiKey: "excerpt", fieldType: "text", validators: { length: { min: 10, max: 20 } },
    });

    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: { title: "Hello", email: "not-an-email", excerpt: "short" },
    });

    const result = await gqlQuery(handler, `{ allArticles { _isValid email excerpt } }`);
    expect(result.data.allArticles[0]._isValid).toBe(false);
  });

  it("_isValid respects number_range and date_range validators", async () => {
    await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
      label: "Rating", apiKey: "rating", fieldType: "integer", validators: { number_range: { min: 1, max: 5 } },
    });
    await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
      label: "Publish On", apiKey: "publish_on", fieldType: "date_time", validators: { date_range: { min: "2100-01-01T00:00:00.000Z" } },
    });

    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: { title: "Hello", rating: 7, publish_on: "2026-01-01T00:00:00.000Z" },
    });

    const result = await gqlQuery(handler, `{ allArticles { _isValid rating publishOn } }`);
    expect(result.data.allArticles[0]._isValid).toBe(false);
  });
});
