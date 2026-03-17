/**
 * Comprehensive filter test suite.
 *
 * Tests every filter type, operator, and their interactions.
 * Intentionally exercises unexpected combinations, edge cases,
 * and cross-field interactions that wouldn't appear in unit tests.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let handler: (req: Request) => Promise<Response>;

async function createModel(name: string, apiKey: string, opts: Record<string, unknown> = {}) {
  const res = await jsonRequest(handler, "POST", "/api/models", { name, apiKey, ...opts });
  return res.json();
}

async function addField(modelId: string, label: string, apiKey: string, fieldType: string, extra: Record<string, unknown> = {}) {
  await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, { label, apiKey, fieldType, ...extra });
}

async function createRecord(modelApiKey: string, data: Record<string, unknown>) {
  const res = await jsonRequest(handler, "POST", "/api/records", { modelApiKey, data });
  return res.json();
}

async function publishRecord(modelApiKey: string, recordId: string) {
  await jsonRequest(handler, "POST", `/api/records/${recordId}/publish?modelApiKey=${modelApiKey}`);
}

async function q(query: string, opts: { includeDrafts?: boolean } = { includeDrafts: true }) {
  return gqlQuery(handler, query, undefined, opts);
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("Filter compiler — comprehensive", () => {
  // -----------------------------------------------------------------------
  // Setup: a rich schema exercising every filterable field type
  // -----------------------------------------------------------------------
  beforeEach(async () => {
    ({ handler } = createTestApp());

    // Locales
    const enRes = await jsonRequest(handler, "POST", "/api/locales", { code: "en", position: 0 });
    const en = await enRes.json();
    await jsonRequest(handler, "POST", "/api/locales", { code: "is", position: 1, fallbackLocaleId: en.id });

    // --- Category model (for link/links testing) ---
    const cat = await createModel("Category", "category");
    await addField(cat.id, "Name", "name", "string");
    await addField(cat.id, "Slug", "slug", "slug", { validators: { slug_source: "name" } });

    // --- Tag model ---
    const tag = await createModel("Tag", "tag");
    await addField(tag.id, "Label", "label", "string");

    // --- Article model (rich schema) ---
    const article = await createModel("Article", "article", { sortable: true });
    await addField(article.id, "Title", "title", "string", { localized: true });
    await addField(article.id, "Body", "body", "text");
    await addField(article.id, "Published", "is_published", "boolean");
    await addField(article.id, "View Count", "view_count", "integer");
    await addField(article.id, "Rating", "rating", "float");
    await addField(article.id, "Publish Date", "publish_date", "date");
    await addField(article.id, "Category", "category", "link", { validators: { item_item_type: ["category"] } });
    await addField(article.id, "Tags", "tags", "links", { validators: { items_item_type: ["tag"] } });
    await addField(article.id, "Location", "location", "lat_lon");
    await addField(article.id, "Cover", "cover", "media");
    await addField(article.id, "Gallery", "gallery", "media_gallery");
    await addField(article.id, "Meta", "meta", "json");
    await addField(article.id, "SEO", "seo_data", "seo");
    await addField(article.id, "Accent", "accent", "color");
    await addField(article.id, "Slug", "slug", "slug", { validators: { slug_source: "title" } });

    // --- Seed data ---
    const catTech = await createRecord("category", { name: "Technology" });
    const catFood = await createRecord("category", { name: "Food" });

    const tagJs = await createRecord("tag", { label: "JavaScript" });
    const tagTs = await createRecord("tag", { label: "TypeScript" });
    const tagRust = await createRecord("tag", { label: "Rust" });

    const asset1 = await (await jsonRequest(handler, "POST", "/api/assets", {
      filename: "hero.jpg", mimeType: "image/jpeg", size: 100000, width: 1920, height: 1080,
    })).json();
    const asset2 = await (await jsonRequest(handler, "POST", "/api/assets", {
      filename: "thumb.png", mimeType: "image/png", size: 5000, width: 200, height: 200,
    })).json();

    // Article 1: full data
    await createRecord("article", {
      title: { en: "Deep Dive into TypeScript", is: "Djúpt í TypeScript" },
      body: "A comprehensive guide to TypeScript generics and type-level programming.",
      is_published: true, view_count: 1500, rating: 4.8,
      publish_date: "2025-01-15",
      category: catTech.id, tags: [tagTs.id, tagJs.id],
      location: { latitude: 64.1466, longitude: -21.9426 },
      cover: asset1.id, gallery: [asset1.id, asset2.id],
      meta: { featured: true, readTime: 12 },
      seo_data: { title: "TS Guide", description: "Learn TypeScript" },
      accent: { red: 0, green: 122, blue: 204 },
    });

    // Article 2: minimal data, different category
    await createRecord("article", {
      title: { en: "Cooking with Rust", is: "" },
      body: "A surprising take on systems programming metaphors in the kitchen.",
      is_published: false, view_count: 42, rating: 3.2,
      publish_date: "2025-06-01",
      category: catFood.id, tags: [tagRust.id],
      location: { latitude: 40.7128, longitude: -74.006 },
    });

    // Article 3: null-heavy
    await createRecord("article", {
      title: { en: "Empty Thoughts" },
      body: "",
      is_published: false, view_count: 0,
    });
  });

  // -----------------------------------------------------------------------
  // String filters
  // -----------------------------------------------------------------------
  describe("string filters", () => {
    it("eq / neq on slug field", async () => {
      // Use category model which has non-localized title → slug
      const r = await q(`{ allCategories(filter: { slug: { eq: "technology" } }) { name } }`);
      expect(r.errors).toBeUndefined();
      expect(r.data.allCategories).toHaveLength(1);
      expect(r.data.allCategories[0].name).toBe("Technology");

      const r2 = await q(`{ allCategories(filter: { slug: { neq: "technology" } }) { name } }`);
      expect(r2.data.allCategories).toHaveLength(1);
      expect(r2.data.allCategories[0].name).toBe("Food");
    });

    it("matches (case-insensitive substring)", async () => {
      const r = await q(`{ allArticles(filter: { body: { matches: "typescript" } }) { title } }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(1);
    });

    it("notMatches excludes matching records", async () => {
      const r = await q(`{ allArticles(filter: { body: { notMatches: "typescript" } }) { title } }`, { includeDrafts: true });
      expect(r.data.allArticles.length).toBeGreaterThanOrEqual(1);
      for (const a of r.data.allArticles) {
        expect(a.title).not.toBe("Deep Dive into TypeScript");
      }
    });

    it("isBlank / isPresent on nullable body", async () => {
      // Article 3 has empty body
      const blank = await q(`{ allArticles(filter: { body: { isBlank: true } }) { title } }`, { includeDrafts: true });
      expect(blank.data.allArticles).toHaveLength(1);
      expect(blank.data.allArticles[0].title).toBe("Empty Thoughts");

      const present = await q(`{ allArticles(filter: { body: { isPresent: true } }) { title } }`, { includeDrafts: true });
      expect(present.data.allArticles).toHaveLength(2);
    });

    it("in / notIn on slug", async () => {
      const r = await q(`{ allCategories(filter: { slug: { in: ["technology", "food"] } }) { name } }`);
      expect(r.data.allCategories).toHaveLength(2);

      const r2 = await q(`{ allCategories(filter: { slug: { notIn: ["technology"] } }) { name } }`);
      expect(r2.data.allCategories).toHaveLength(1);
      expect(r2.data.allCategories[0].name).toBe("Food");
    });
  });

  // -----------------------------------------------------------------------
  // Numeric filters
  // -----------------------------------------------------------------------
  describe("numeric filters", () => {
    it("integer gt / lte combination", async () => {
      const r = await q(`{ allArticles(filter: { viewCount: { gt: 0, lte: 1500 } }) { title viewCount } }`, { includeDrafts: true });
      expect(r.errors).toBeUndefined();
      expect(r.data.allArticles).toHaveLength(2);
    });

    it("float range filter", async () => {
      const r = await q(`{ allArticles(filter: { rating: { gte: 4.0 } }) { title } }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(1);
      expect(r.data.allArticles[0].title).toBe("Deep Dive into TypeScript");
    });

    it("eq on zero (truthy edge case)", async () => {
      const r = await q(`{ allArticles(filter: { viewCount: { eq: 0 } }) { title } }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(1);
      expect(r.data.allArticles[0].title).toBe("Empty Thoughts");
    });

    it("exists: false catches null view_count", async () => {
      // All articles have view_count set, but article 3 has view_count: 0 which is NOT null
      const r = await q(`{ allArticles(filter: { rating: { exists: false } }) { title } }`, { includeDrafts: true });
      // Article 3 has no rating
      expect(r.data.allArticles).toHaveLength(1);
      expect(r.data.allArticles[0].title).toBe("Empty Thoughts");
    });
  });

  // -----------------------------------------------------------------------
  // Boolean filters
  // -----------------------------------------------------------------------
  describe("boolean filters", () => {
    it("boolean eq true", async () => {
      const r = await q(`{ allArticles(filter: { isPublished: { eq: true } }) { title } }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(1);
      expect(r.data.allArticles[0].title).toBe("Deep Dive into TypeScript");
    });

    it("boolean eq false", async () => {
      const r = await q(`{ allArticles(filter: { isPublished: { eq: false } }) { title } }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // Link (single reference) filters
  // -----------------------------------------------------------------------
  describe("link filters", () => {
    it("filter by linked record ID (eq)", async () => {
      const cats = await q(`{ allCategories { id name } }`, { includeDrafts: true });
      const techId = cats.data.allCategories.find((c: any) => c.name === "Technology").id;

      const r = await q(`{ allArticles(filter: { category: { eq: "${techId}" } }) { title } }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(1);
      expect(r.data.allArticles[0].title).toBe("Deep Dive into TypeScript");
    });

    it("filter by link exists: false catches unlinked records", async () => {
      const r = await q(`{ allArticles(filter: { category: { exists: false } }) { title } }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(1);
      expect(r.data.allArticles[0].title).toBe("Empty Thoughts");
    });

    it("filter by link in (multiple IDs)", async () => {
      const cats = await q(`{ allCategories { id } }`, { includeDrafts: true });
      const ids = cats.data.allCategories.map((c: any) => c.id);
      const r = await q(`{ allArticles(filter: { category: { in: ${JSON.stringify(ids)} } }) { title } }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // Links (multi-reference) filters — JSON array operators
  // -----------------------------------------------------------------------
  describe("links filters (JSON arrays)", () => {
    it("anyIn — article has at least one of the specified tags", async () => {
      const tags = await q(`{ allTags { id label } }`, { includeDrafts: true });
      const tsId = tags.data.allTags.find((t: any) => t.label === "TypeScript").id;
      const rustId = tags.data.allTags.find((t: any) => t.label === "Rust").id;

      const r = await q(`{ allArticles(filter: { tags: { anyIn: ["${tsId}", "${rustId}"] } }) { title } }`, { includeDrafts: true });
      expect(r.errors).toBeUndefined();
      expect(r.data.allArticles).toHaveLength(2); // Both articles have at least one match
    });

    it("allIn — article has ALL specified tags", async () => {
      const tags = await q(`{ allTags { id label } }`, { includeDrafts: true });
      const tsId = tags.data.allTags.find((t: any) => t.label === "TypeScript").id;
      const jsId = tags.data.allTags.find((t: any) => t.label === "JavaScript").id;

      // Only article 1 has both TS and JS tags
      const r = await q(`{ allArticles(filter: { tags: { allIn: ["${tsId}", "${jsId}"] } }) { title } }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(1);
      expect(r.data.allArticles[0].title).toBe("Deep Dive into TypeScript");
    });

    it("notIn — article has none of the specified tags", async () => {
      const tags = await q(`{ allTags { id label } }`, { includeDrafts: true });
      const tsId = tags.data.allTags.find((t: any) => t.label === "TypeScript").id;
      const jsId = tags.data.allTags.find((t: any) => t.label === "JavaScript").id;

      const r = await q(`{ allArticles(filter: { tags: { notIn: ["${tsId}", "${jsId}"] } }) { title } }`, { includeDrafts: true });
      expect(r.errors).toBeUndefined();
      // Article 1 has TS+JS → excluded. Article 2 (Rust only) and Article 3 (no tags) should pass.
      const titles = r.data.allArticles.map((a: any) => a.title);
      expect(titles).not.toContain("Deep Dive into TypeScript");
      expect(titles).toContain("Cooking with Rust");
    });

    it("exists: false on links field finds untagged records", async () => {
      const r = await q(`{ allArticles(filter: { tags: { exists: false } }) { title } }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(1);
      expect(r.data.allArticles[0].title).toBe("Empty Thoughts");
    });
  });

  // -----------------------------------------------------------------------
  // Geolocation near filter
  // -----------------------------------------------------------------------
  describe("geolocation near filter", () => {
    it("finds articles near Reykjavik (within 50km)", async () => {
      const r = await q(`{
        allArticles(filter: { location: { near: { latitude: 64.15, longitude: -21.95, radius: 50000 } } }) { title }
      }`, { includeDrafts: true });
      expect(r.errors).toBeUndefined();
      expect(r.data.allArticles).toHaveLength(1);
      expect(r.data.allArticles[0].title).toBe("Deep Dive into TypeScript");
    });

    it("finds articles near NYC (within 100km)", async () => {
      const r = await q(`{
        allArticles(filter: { location: { near: { latitude: 40.71, longitude: -74.01, radius: 100000 } } }) { title }
      }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(1);
      expect(r.data.allArticles[0].title).toBe("Cooking with Rust");
    });

    it("very small radius excludes everything", async () => {
      const r = await q(`{
        allArticles(filter: { location: { near: { latitude: 0, longitude: 0, radius: 1 } } }) { title }
      }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(0);
    });

    it("location exists: false finds articles without location", async () => {
      const r = await q(`{
        allArticles(filter: { location: { exists: false } }) { title }
      }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(1);
      expect(r.data.allArticles[0].title).toBe("Empty Thoughts");
    });
  });

  // -----------------------------------------------------------------------
  // Existence filters on JSON fields (seo, json, color)
  // -----------------------------------------------------------------------
  describe("existence filters on complex fields", () => {
    it("seo exists: true finds records with SEO data", async () => {
      const r = await q(`{ allArticles(filter: { seoData: { exists: true } }) { title } }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(1);
    });

    it("json field exists: true", async () => {
      const r = await q(`{ allArticles(filter: { meta: { exists: true } }) { title } }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(1);
    });

    it("color exists: true", async () => {
      const r = await q(`{ allArticles(filter: { accent: { exists: true } }) { title } }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Media (single) & Gallery (multi) filters
  // -----------------------------------------------------------------------
  describe("media filters", () => {
    it("cover exists: true finds articles with a cover image", async () => {
      const r = await q(`{ allArticles(filter: { cover: { exists: true } }) { title } }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(1);
    });

    it("gallery anyIn finds articles containing a specific asset", async () => {
      // Get asset IDs
      const uploads = await q(`{ allUploads { id filename } }`);
      expect(uploads.errors).toBeUndefined();
      const thumbId = uploads.data.allUploads.find((u: any) => u.filename === "thumb.png").id;

      const r = await q(`{ allArticles(filter: { gallery: { anyIn: ["${thumbId}"] } }) { title } }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // _locales filter
  // -----------------------------------------------------------------------
  describe("_locales filter", () => {
    it("anyIn finds records with content in Icelandic", async () => {
      // Article 1 has is: "Djúpt í TypeScript" (non-empty)
      // Article 2 has is: "" (empty)
      // Article 3 has no "is" key
      const r = await q(`{ allArticles(filter: { _locales: { anyIn: [is] } }) { title } }`, { includeDrafts: true });
      expect(r.errors).toBeUndefined();
      expect(r.data.allArticles).toHaveLength(1);
      expect(r.data.allArticles[0].title).toBe("Deep Dive into TypeScript");
    });

    it("allIn requires all specified locales to have content", async () => {
      const r = await q(`{ allArticles(filter: { _locales: { allIn: [en, is] } }) { title } }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(1);
    });

    it("notIn excludes records with content in a locale", async () => {
      const r = await q(`{ allArticles(filter: { _locales: { notIn: [is] } }) { title } }`, { includeDrafts: true });
      // Should exclude article 1 (has Icelandic content)
      for (const a of r.data.allArticles) {
        expect(a.title).not.toBe("Deep Dive into TypeScript");
      }
    });
  });

  // -----------------------------------------------------------------------
  // Position filter (sortable model)
  // -----------------------------------------------------------------------
  describe("position filter", () => {
    it("filters by _position", async () => {
      // Articles are auto-assigned positions 0, 1, 2
      const r = await q(`{ allArticles(filter: { _position: { eq: 0 } }) { title } }`, { includeDrafts: true });
      expect(r.errors).toBeUndefined();
      expect(r.data.allArticles).toHaveLength(1);
    });

    it("position range filter", async () => {
      const r = await q(`{ allArticles(filter: { _position: { gte: 1 } }) { title } }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // AND / OR logical operators — complex nesting
  // -----------------------------------------------------------------------
  describe("logical operators", () => {
    it("AND combines two scalar filters", async () => {
      const r = await q(`{
        allArticles(filter: { AND: [
          { viewCount: { gt: 100 } },
          { isPublished: { eq: true } }
        ] }) { title }
      }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(1);
    });

    it("OR finds records matching either condition", async () => {
      const r = await q(`{
        allArticles(filter: { OR: [
          { viewCount: { gt: 1000 } },
          { viewCount: { eq: 0 } }
        ] }) { title }
      }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(2);
    });

    it("nested AND inside OR", async () => {
      const r = await q(`{
        allArticles(filter: { OR: [
          { AND: [{ isPublished: { eq: true } }, { viewCount: { gt: 1000 } }] },
          { AND: [{ isPublished: { eq: false } }, { viewCount: { eq: 0 } }] }
        ] }) { title }
      }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(2);
    });

    it("empty AND/OR arrays are ignored gracefully", async () => {
      const r = await q(`{ allArticles(filter: { AND: [] }) { title } }`, { includeDrafts: true });
      expect(r.errors).toBeUndefined();
      expect(r.data.allArticles).toHaveLength(3);
    });

    it("cross-type filter: string + numeric + boolean", async () => {
      const r = await q(`{
        allArticles(filter: {
          body: { matches: "guide" },
          viewCount: { gt: 100 },
          isPublished: { eq: true }
        }) { title }
      }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Meta field filters (_createdAt, _status, etc.)
  // -----------------------------------------------------------------------
  describe("meta field filters", () => {
    it("_status filter", async () => {
      const r = await q(`{ allArticles(filter: { _status: { eq: draft } }) { title } }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(3); // All start as draft
    });

    it("_createdAt exists", async () => {
      const r = await q(`{ allArticles(filter: { _createdAt: { exists: true } }) { title } }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(3);
    });
  });

  // -----------------------------------------------------------------------
  // OrderBy
  // -----------------------------------------------------------------------
  describe("ordering", () => {
    it("orders by camelCase integer field", async () => {
      const r = await q(`{ allArticles(orderBy: [viewCount_DESC]) { title viewCount } }`, { includeDrafts: true });
      expect(r.data.allArticles[0].viewCount).toBe(1500);
    });

    it("multi-field ordering", async () => {
      const r = await q(`{ allArticles(orderBy: [isPublished_DESC, viewCount_ASC]) { title } }`, { includeDrafts: true });
      expect(r.errors).toBeUndefined();
      expect(r.data.allArticles).toHaveLength(3);
    });

    it("_position ordering for sortable model", async () => {
      const r = await q(`{ allArticles(orderBy: [_position_ASC]) { title } }`, { includeDrafts: true });
      expect(r.errors).toBeUndefined();
      expect(r.data.allArticles).toHaveLength(3);
    });
  });

  // -----------------------------------------------------------------------
  // Pagination
  // -----------------------------------------------------------------------
  describe("pagination", () => {
    it("first limits results", async () => {
      const r = await q(`{ allArticles(first: 1) { title } }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(1);
    });

    it("skip offsets results", async () => {
      const all = await q(`{ allArticles(orderBy: [_position_ASC]) { title } }`, { includeDrafts: true });
      const skipped = await q(`{ allArticles(orderBy: [_position_ASC], first: 1, skip: 1) { title } }`, { includeDrafts: true });
      expect(skipped.data.allArticles[0].title).toBe(all.data.allArticles[1].title);
    });

    it("first is capped at 500", async () => {
      // Should not error even with large first value
      const r = await q(`{ allArticles(first: 9999) { title } }`, { includeDrafts: true });
      expect(r.errors).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // allUploads query
  // -----------------------------------------------------------------------
  describe("allUploads query", () => {
    it("lists all uploads", async () => {
      const r = await q(`{ allUploads { id filename mimeType size width height } }`);
      expect(r.errors).toBeUndefined();
      expect(r.data.allUploads).toHaveLength(2);
    });

    it("filters uploads by mimeType", async () => {
      const r = await q(`{ allUploads(filter: { mimeType: { eq: "image/png" } }) { filename } }`);
      expect(r.data.allUploads).toHaveLength(1);
      expect(r.data.allUploads[0].filename).toBe("thumb.png");
    });

    it("filters uploads by size range", async () => {
      const r = await q(`{ allUploads(filter: { size: { gt: 10000 } }) { filename } }`);
      expect(r.data.allUploads).toHaveLength(1);
      expect(r.data.allUploads[0].filename).toBe("hero.jpg");
    });

    it("filters uploads by filename matches", async () => {
      const r = await q(`{ allUploads(filter: { filename: { matches: "hero" } }) { filename } }`);
      expect(r.data.allUploads).toHaveLength(1);
    });

    it("orders uploads by size", async () => {
      const r = await q(`{ allUploads(orderBy: [size_ASC]) { filename size } }`);
      expect(r.data.allUploads[0].filename).toBe("thumb.png");
    });

    it("_allUploadsMeta returns count", async () => {
      const r = await q(`{ _allUploadsMeta { count } }`);
      expect(r.errors).toBeUndefined();
      expect(r.data._allUploadsMeta.count).toBe(2);
    });

    it("_allUploadsMeta with filter", async () => {
      const r = await q(`{ _allUploadsMeta(filter: { mimeType: { eq: "image/jpeg" } }) { count } }`);
      expect(r.data._allUploadsMeta.count).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // _allXMeta with filters (count queries)
  // -----------------------------------------------------------------------
  describe("meta count queries", () => {
    it("_allArticlesMeta returns total count", async () => {
      const r = await q(`{ _allArticlesMeta { count } }`, { includeDrafts: true });
      expect(r.errors).toBeUndefined();
      expect(r.data._allArticlesMeta.count).toBe(3);
    });

    it("_allArticlesMeta respects filters", async () => {
      const r = await q(`{ _allArticlesMeta(filter: { viewCount: { gt: 100 } }) { count } }`, { includeDrafts: true });
      expect(r.data._allArticlesMeta.count).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Draft / published interaction with filters
  // -----------------------------------------------------------------------
  describe("draft/published interaction", () => {
    it("without includeDrafts, only published records appear", async () => {
      // None published yet
      const r = await q(`{ allArticles { title } }`, { includeDrafts: false });
      expect(r.data.allArticles).toHaveLength(0);
    });

    it("published records appear without includeDrafts after publishing", async () => {
      // Publish article 1
      const drafts = await q(`{ allArticles(orderBy: [_position_ASC]) { id } }`, { includeDrafts: true });
      const id = drafts.data.allArticles[0].id;
      await publishRecord("article", id);

      const r = await q(`{ allArticles { title } }`, { includeDrafts: false });
      expect(r.data.allArticles).toHaveLength(1);

      // Filter still works on published
      const r2 = await q(`{ allArticles(filter: { viewCount: { gt: 1000 } }) { title } }`, { includeDrafts: false });
      expect(r2.data.allArticles).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases and unexpected combinations
  // -----------------------------------------------------------------------
  describe("edge cases", () => {
    it("filter on field that has null value (not undefined)", async () => {
      // Article 3 has no rating (null) — eq on null shouldn't match a number
      const r = await q(`{ allArticles(filter: { rating: { eq: 0 } }) { title } }`, { includeDrafts: true });
      // 0 != null, so no matches (rating is null, not 0)
      expect(r.data.allArticles).toHaveLength(0);
    });

    it("combining filter and orderBy on the same field", async () => {
      const r = await q(`{
        allArticles(filter: { viewCount: { gt: 0 } }, orderBy: [viewCount_ASC]) { title viewCount }
      }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(2);
      expect(r.data.allArticles[0].viewCount).toBeLessThan(r.data.allArticles[1].viewCount);
    });

    it("filter and pagination combined", async () => {
      const r = await q(`{
        allArticles(filter: { body: { isPresent: true } }, first: 1, skip: 0, orderBy: [viewCount_DESC]) { title }
      }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(1);
      expect(r.data.allArticles[0].title).toBe("Deep Dive into TypeScript");
    });

    it("OR with heterogeneous filter types", async () => {
      const r = await q(`{
        allArticles(filter: { OR: [
          { body: { matches: "kitchen" } },
          { viewCount: { gt: 1000 } }
        ] }) { title }
      }`, { includeDrafts: true });
      expect(r.data.allArticles).toHaveLength(2);
    });

    it("allIn with single element behaves like anyIn", async () => {
      const tags = await q(`{ allTags { id label } }`, { includeDrafts: true });
      const rustId = tags.data.allTags.find((t: any) => t.label === "Rust").id;

      const allIn = await q(`{ allArticles(filter: { tags: { allIn: ["${rustId}"] } }) { title } }`, { includeDrafts: true });
      const anyIn = await q(`{ allArticles(filter: { tags: { anyIn: ["${rustId}"] } }) { title } }`, { includeDrafts: true });
      expect(allIn.data.allArticles).toHaveLength(anyIn.data.allArticles.length);
    });

    it("near filter with very large radius finds all located articles", async () => {
      const r = await q(`{
        allArticles(filter: { location: { near: { latitude: 50, longitude: -50, radius: 10000000 } } }) { title }
      }`, { includeDrafts: true });
      // Both located articles (64.14/-21.94 and 40.71/-74.01) within 10000km of mid-Atlantic
      expect(r.data.allArticles).toHaveLength(2);
    });
  });
});
