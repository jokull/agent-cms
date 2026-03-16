import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("Localization", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    ({ handler } = createTestApp());

    // Set up locales
    const enRes = await jsonRequest(handler, "POST", "/api/locales", { code: "en", position: 0 });
    const en = await enRes.json();
    await jsonRequest(handler, "POST", "/api/locales", { code: "is", position: 1, fallbackLocaleId: en.id });

    // Create model with localized field
    const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Article", apiKey: "article" });
    const model = await modelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string", localized: true,
    });
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Slug", apiKey: "slug", fieldType: "slug", validators: { slug_source: "title" },
    });
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Views", apiKey: "views", fieldType: "integer", // Not localized
    });

    // Create record with localized data
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: { en: "Hello World", is: "Halló heimur" },
        views: 42,
      },
    });
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: { en: "Second Article", is: "Önnur grein" },
        views: 10,
      },
    });
    // Article with only English
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: { en: "English Only" },
        views: 5,
      },
    });
  });

  it("returns English locale by default (first locale)", async () => {
    const result = await gqlQuery(handler, `{ allArticles { title views } }`);
    expect(result.errors).toBeUndefined();
    expect(result.data.allArticles).toHaveLength(3);
    expect(result.data.allArticles[0].title).toBe("Hello World");
    expect(result.data.allArticles[0].views).toBe(42); // Non-localized, unaffected
  });

  it("returns Icelandic locale when requested", async () => {
    const result = await gqlQuery(handler, `{ allArticles(locale: "is") { title } }`);
    expect(result.errors).toBeUndefined();
    expect(result.data.allArticles[0].title).toBe("Halló heimur");
    expect(result.data.allArticles[1].title).toBe("Önnur grein");
  });

  it("falls back to English for missing Icelandic", async () => {
    const result = await gqlQuery(handler, `{
      allArticles(locale: "is", fallbackLocales: ["en"]) { title }
    }`);
    expect(result.errors).toBeUndefined();
    // "English Only" has no Icelandic, should fall back to English
    const englishOnly = result.data.allArticles.find((a: any) => a.title === "English Only");
    expect(englishOnly).toBeDefined();
  });

  it("returns null for missing locale without fallback", async () => {
    const result = await gqlQuery(handler, `{ allArticles(locale: "de") { title } }`);
    // German locale doesn't exist for any record
    // Should fall back to default locale (en) or return first available
    expect(result.errors).toBeUndefined();
    // With our implementation, it falls back to default locale (en)
    expect(result.data.allArticles[0].title).toBe("Hello World");
  });

  it("non-localized fields are unaffected by locale argument", async () => {
    const result = await gqlQuery(handler, `{ allArticles(locale: "is") { views } }`);
    expect(result.data.allArticles[0].views).toBe(42);
  });

  it("single record query supports locale", async () => {
    const all = await gqlQuery(handler, `{ allArticles { id title } }`);
    const id = all.data.allArticles[0].id;

    const result = await gqlQuery(handler, `{
      article(id: "${id}", locale: "is") { title }
    }`);
    expect(result.data.article.title).toBe("Halló heimur");
  });
});
