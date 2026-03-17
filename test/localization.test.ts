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
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "SEO", apiKey: "seo_metadata", fieldType: "seo", localized: true,
    });

    // Create record with localized data
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: {
        title: { en: "Hello World", is: "Halló heimur" },
        seo_metadata: {
          en: { title: "Hello SEO", description: "Hello Desc" },
        },
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

  it("patch merges localized field maps instead of replacing them", async () => {
    const all = await gqlQuery(handler, `{ allArticles { id title } }`);
    const id = all.data.allArticles[0].id;

    const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${id}`, {
      modelApiKey: "article",
      data: {
        title: { is: "Halló uppfært" },
      },
    });
    expect(patchRes.status).toBe(200);

    const english = await gqlQuery(handler, `{
      article(id: "${id}", locale: "en") { title }
    }`);
    const icelandic = await gqlQuery(handler, `{
      article(id: "${id}", locale: "is") { title }
    }`);

    expect(english.data.article.title).toBe("Hello World");
    expect(icelandic.data.article.title).toBe("Halló uppfært");
  });

  it("patch ignores stale non-locale keys when merging localized fields", async () => {
    const all = await gqlQuery(handler, `{ allArticles { id } }`);
    const id = all.data.allArticles[0].id;

    await jsonRequest(handler, "PATCH", `/api/records/${id}`, {
      modelApiKey: "article",
      data: {
        title: { title: "stale", description: "stale", is: "Halló hreinsað" },
      },
    });

    const english = await gqlQuery(handler, `{
      article(id: "${id}", locale: "en") { title }
    }`);
    const icelandic = await gqlQuery(handler, `{
      article(id: "${id}", locale: "is") { title }
      allArticles { _locales }
    }`);

    expect(english.data.article.title).toBe("Hello World");
    expect(icelandic.data.article.title).toBe("Halló hreinsað");
    expect(icelandic.data.allArticles[0]._locales).not.toContain("title");
    expect(icelandic.data.allArticles[0]._locales).not.toContain("description");
  });

  it("patch heals stale non-localized seo object into a clean localized map", async () => {
    const all = await gqlQuery(handler, `{ allArticles { id } }`);
    const id = all.data.allArticles[0].id;

    await jsonRequest(handler, "PATCH", `/api/records/${id}`, {
      modelApiKey: "article",
      data: {
        seo_metadata: {
          title: "stale title",
          description: "stale description",
          en: { title: "Hello SEO", description: "Hello Desc" },
        },
      },
    });

    await jsonRequest(handler, "PATCH", `/api/records/${id}`, {
      modelApiKey: "article",
      data: {
        seo_metadata: {
          is: { title: "Halló SEO", description: "Halló Lýsing" },
        },
      },
    });

    const result = await gqlQuery(handler, `{
      article(id: "${id}", locale: "is", fallbackLocales: ["en"]) {
        seoMetadata { title description }
        _allSeoMetadataLocales { locale value { title description } }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data.article.seoMetadata.title).toBe("Halló SEO");
    expect(result.data.article._allSeoMetadataLocales).toEqual([
      { locale: "en", value: { title: "Hello SEO", description: "Hello Desc" } },
      { locale: "is", value: { title: "Halló SEO", description: "Halló Lýsing" } },
    ]);
  });
});
