import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("_seoMetaTags auto-generation", () => {
  let handler: (req: Request) => Promise<Response>;

  describe("with explicit seo field", () => {
    beforeEach(async () => {
      ({ handler } = createTestApp());

      const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Page", apiKey: "page" });
      const model = await modelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "SEO", apiKey: "seo", fieldType: "seo",
      });
    });

    it("generates meta tags from seo field", async () => {
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "page",
        data: {
          title: "About Us",
          seo: {
            title: "About Our Company | Example",
            description: "Learn about our mission and team.",
            twitterCard: "summary_large_image",
          },
        },
      });

      const result = await gqlQuery(handler, `{
        allPages { _seoMetaTags { tag attributes content } }
      }`, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      const tags = result.data.allPages[0]._seoMetaTags;

      // Check title tag
      const titleTag = tags.find((t: any) => t.tag === "title");
      expect(titleTag).toBeDefined();
      expect(titleTag.content).toBe("About Our Company | Example");

      // Check og:title
      const ogTitle = tags.find((t: any) => t.attributes?.property === "og:title");
      expect(ogTitle).toBeDefined();
      expect(ogTitle.attributes.content).toBe("About Our Company | Example");

      // Check description
      const desc = tags.find((t: any) => t.attributes?.name === "description");
      expect(desc).toBeDefined();
      expect(desc.attributes.content).toBe("Learn about our mission and team.");

      // Check twitter:card
      const twitterCard = tags.find((t: any) => t.attributes?.name === "twitter:card");
      expect(twitterCard.attributes.content).toBe("summary_large_image");

      // Check og:type
      const ogType = tags.find((t: any) => t.attributes?.property === "og:type");
      expect(ogType.attributes.content).toBe("article");
    });

    it("generates meta tags with image from seo field", async () => {
      // Create an asset
      const assetRes = await jsonRequest(handler, "POST", "/api/assets", {
        filename: "og.jpg", mimeType: "image/jpeg", size: 50000, width: 1200, height: 630,
      });
      const asset = await assetRes.json();

      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "page",
        data: {
          title: "Blog",
          seo: { title: "Blog", description: "Latest posts", image: asset.id },
        },
      });

      const result = await gqlQuery(handler, `{
        allPages { _seoMetaTags { tag attributes content } }
      }`, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      const tags = result.data.allPages[0]._seoMetaTags;

      const ogImage = tags.find((t: any) => t.attributes?.property === "og:image");
      expect(ogImage).toBeDefined();
      expect(ogImage.attributes.content).toContain(asset.id);
    });
  });

  describe("heuristic fallback (no seo field)", () => {
    beforeEach(async () => {
      ({ handler } = createTestApp());

      const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
      const model = await modelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Excerpt", apiKey: "excerpt", fieldType: "text",
      });
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Cover", apiKey: "cover", fieldType: "media",
      });
    });

    it("falls back to first string/text/media fields", async () => {
      const assetRes = await jsonRequest(handler, "POST", "/api/assets", {
        filename: "cover.jpg", mimeType: "image/jpeg", size: 30000, width: 800, height: 600,
      });
      const asset = await assetRes.json();

      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post",
        data: { title: "My Post", excerpt: "A great post about stuff.", cover: asset.id },
      });

      const result = await gqlQuery(handler, `{
        allPosts { _seoMetaTags { tag attributes content } }
      }`, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      const tags = result.data.allPosts[0]._seoMetaTags;

      // Title from first string field
      const titleTag = tags.find((t: any) => t.tag === "title");
      expect(titleTag.content).toBe("My Post");

      // Description from first text field
      const desc = tags.find((t: any) => t.attributes?.name === "description");
      expect(desc.attributes.content).toBe("A great post about stuff.");

      // Image from first media field
      const ogImage = tags.find((t: any) => t.attributes?.property === "og:image");
      expect(ogImage).toBeDefined();
      expect(ogImage.attributes.content).toContain(asset.id);

      // Default twitter:card is "summary"
      const twitterCard = tags.find((t: any) => t.attributes?.name === "twitter:card");
      expect(twitterCard.attributes.content).toBe("summary");
    });

    it("generates minimal tags when record has no data", async () => {
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post", data: {},
      });

      const result = await gqlQuery(handler, `{
        allPosts { _seoMetaTags { tag attributes content } }
      }`, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      const tags = result.data.allPosts[0]._seoMetaTags;

      // Should still have og:type and twitter:card
      const ogType = tags.find((t: any) => t.attributes?.property === "og:type");
      expect(ogType).toBeDefined();
      const twitterCard = tags.find((t: any) => t.attributes?.name === "twitter:card");
      expect(twitterCard).toBeDefined();
    });
  });
});
