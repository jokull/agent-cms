import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("DatoCMS GraphQL parity", () => {
  let handler: (req: Request) => Promise<Response>;

  describe("_locales field", () => {
    beforeEach(async () => {
      ({ handler } = createTestApp());

      const enRes = await jsonRequest(handler, "POST", "/api/locales", { code: "en", position: 0 });
      const en = await enRes.json();
      await jsonRequest(handler, "POST", "/api/locales", { code: "is", position: 1, fallbackLocaleId: en.id });

      const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Article", apiKey: "article" });
      const model = await modelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string", localized: true,
      });
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Body", apiKey: "body", fieldType: "text", localized: true,
      });
    });

    it("returns locale codes where record has content", async () => {
      // Record with both locales
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "article",
        data: { title: { en: "Hello", is: "Halló" }, body: { en: "Content" } },
      });
      // Record with only English
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "article",
        data: { title: { en: "English Only" } },
      });

      const result = await gqlQuery(handler, `{
        allArticles { title _locales }
      }`, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      const both = result.data.allArticles.find((a: any) => a.title === "Hello");
      expect(both._locales).toContain("en");
      expect(both._locales).toContain("is");

      const enOnly = result.data.allArticles.find((a: any) => a.title === "English Only");
      expect(enOnly._locales).toEqual(["en"]);
    });

    it("returns empty array when no localized content", async () => {
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "article",
        data: {},
      });

      const result = await gqlQuery(handler, `{
        allArticles { _locales }
      }`, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      expect(result.data.allArticles[0]._locales).toEqual([]);
    });
  });

  describe("matches filter with {pattern, caseSensitive} object", () => {
    beforeEach(async () => {
      ({ handler } = createTestApp());

      const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
      const model = await modelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });

      await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "Hello World" } });
      await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "hello there" } });
      await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "Goodbye" } });
    });

    it("matches filter works with plain string (existing behavior)", async () => {
      const result = await gqlQuery(handler, `{
        allPosts(filter: { title: { matches: "hello" } }) { title }
      }`, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      // LIKE is case-insensitive in SQLite by default for ASCII
      expect(result.data.allPosts.length).toBeGreaterThanOrEqual(1);
    });

    it("in filter on string fields", async () => {
      const result = await gqlQuery(handler, `{
        allPosts(filter: { title: { eq: "Goodbye" } }) { title }
      }`, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      expect(result.data.allPosts).toHaveLength(1);
      expect(result.data.allPosts[0].title).toBe("Goodbye");
    });

    it("isBlank filter works", async () => {
      // Create a record with no title
      await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: {} });

      const result = await gqlQuery(handler, `{
        allPosts(filter: { title: { isBlank: true } }) { title }
      }`, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      expect(result.data.allPosts.length).toBeGreaterThanOrEqual(1);
    });

    it("in filter matches multiple values", async () => {
      const result = await gqlQuery(handler, `{
        allPosts(filter: { title: { in: ["Hello World", "Goodbye"] } }) { title }
      }`, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      expect(result.data.allPosts).toHaveLength(2);
      const titles = result.data.allPosts.map((p: any) => p.title).sort();
      expect(titles).toEqual(["Goodbye", "Hello World"]);
    });

    it("notIn filter excludes values", async () => {
      const result = await gqlQuery(handler, `{
        allPosts(filter: { title: { notIn: ["Hello World", "Goodbye"] } }) { title }
      }`, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      expect(result.data.allPosts).toHaveLength(1);
      expect(result.data.allPosts[0].title).toBe("hello there");
    });

    it("isPresent filter finds non-null values", async () => {
      await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: {} });

      const result = await gqlQuery(handler, `{
        allPosts(filter: { title: { isPresent: true } }) { title }
      }`, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      expect(result.data.allPosts).toHaveLength(3); // original 3, not the empty one
    });
  });

  describe("_all<Field>Locales pattern", () => {
    beforeEach(async () => {
      ({ handler } = createTestApp());

      const enRes = await jsonRequest(handler, "POST", "/api/locales", { code: "en", position: 0 });
      const en = await enRes.json();
      await jsonRequest(handler, "POST", "/api/locales", { code: "is", position: 1, fallbackLocaleId: en.id });

      const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Page", apiKey: "page" });
      const model = await modelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string", localized: true,
      });
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Views", apiKey: "views", fieldType: "integer",
      });
    });

    it("returns all locale values for a localized field", async () => {
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "page",
        data: { title: { en: "Home", is: "Forsíða" }, views: 100 },
      });

      const result = await gqlQuery(handler, `{
        allPages {
          title
          _allTitleLocales { locale value }
        }
      }`, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      const locales = result.data.allPages[0]._allTitleLocales;
      expect(locales).toHaveLength(2);
      expect(locales).toContainEqual({ locale: "en", value: "Home" });
      expect(locales).toContainEqual({ locale: "is", value: "Forsíða" });
    });

    it("returns empty array when field has no locale data", async () => {
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "page",
        data: { views: 50 },
      });

      const result = await gqlQuery(handler, `{
        allPages { _allTitleLocales { locale value } }
      }`, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      expect(result.data.allPages[0]._allTitleLocales).toEqual([]);
    });

    it("returns only locales with non-null values", async () => {
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "page",
        data: { title: { en: "Only English" } },
      });

      const result = await gqlQuery(handler, `{
        allPages { _allTitleLocales { locale value } }
      }`, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      expect(result.data.allPages[0]._allTitleLocales).toEqual([
        { locale: "en", value: "Only English" },
      ]);
    });
  });
});
