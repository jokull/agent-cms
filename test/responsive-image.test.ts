import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("P2.4: Responsive image + _site query", () => {
  let handler: (req: Request) => Promise<Response>;
  let sqlLayer: ReturnType<typeof createTestApp>["sqlLayer"];

  beforeEach(async () => {
    ({ handler, sqlLayer } = createTestApp());

    // Set up locales
    await jsonRequest(handler, "POST", "/api/locales", { code: "en", position: 0 });
    await jsonRequest(handler, "POST", "/api/locales", { code: "is", position: 1 });

    // Model with media field
    const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
    const model = await modelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, { label: "Title", apiKey: "title", fieldType: "string" });
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, { label: "Cover", apiKey: "cover", fieldType: "media" });
  });

  describe("responsiveImage", () => {
    it("returns srcSet and dimensions for image assets", async () => {
      const assetRes = await jsonRequest(handler, "POST", "/api/assets", {
        filename: "hero.jpg", mimeType: "image/jpeg", size: 50000, width: 1920, height: 1080, alt: "Hero image",
      });
      const asset = await assetRes.json();

      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post", data: { title: "Test", cover: asset.id },
      });

      const result = await gqlQuery(handler, `{
        allPosts {
          cover {
            url
            responsiveImage {
              src
              srcSet
              width
              height
              alt
              sizes
            }
          }
        }
      }`);

      expect(result.errors).toBeUndefined();
      const img = result.data.allPosts[0].cover.responsiveImage;
      expect(img.width).toBe(1920);
      expect(img.height).toBe(1080);
      expect(img.alt).toBe("Hero image");
      expect(img.srcSet).toContain("320w");
      expect(img.srcSet).toContain("960w");
      expect(img.srcSet).toContain("1920w");
      expect(img.sizes).toContain("1920px");
    });

    it("returns null responsiveImage for assets without dimensions", async () => {
      const assetRes = await jsonRequest(handler, "POST", "/api/assets", {
        filename: "doc.pdf", mimeType: "application/pdf", size: 1000,
      });
      const asset = await assetRes.json();

      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post", data: { title: "Doc", cover: asset.id },
      });

      const result = await gqlQuery(handler, `{
        allPosts { cover { responsiveImage { src } } }
      }`);

      expect(result.data.allPosts[0].cover.responsiveImage).toBeNull();
    });

    it("uses per-field focal point for responsiveImage gravity", async () => {
      const assetRes = await jsonRequest(handler, "POST", "/api/assets", {
        filename: "hero.jpg", mimeType: "image/jpeg", size: 50000, width: 1920, height: 1080, alt: "Hero image",
      });
      const asset = await assetRes.json();

      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post",
        data: {
          title: "Focal Post",
          cover: {
            upload_id: asset.id,
            focal_point: { x: 0.5, y: 0.2 },
          },
        },
      });

      const result = await gqlQuery(handler, `{
        allPosts {
          cover {
            responsiveImage(transforms: { width: 600, height: 400, fit: "cover" }) {
              src
            }
          }
        }
      }`);

      expect(result.errors).toBeUndefined();
      expect(result.data.allPosts[0].cover.responsiveImage.src).toContain("gravity=0.5x0.2");
    });
  });

  describe("_site query", () => {
    it("returns available locales", async () => {
      const result = await gqlQuery(handler, `{ _site { locales } }`);
      expect(result.errors).toBeUndefined();
      expect(result.data._site.locales).toEqual(["en", "is"]);
    });

    it("returns empty locales when none configured", async () => {
      // Create a fresh app with no locales
      const { handler: freshHandler } = createTestApp();
      const result = await gqlQuery(freshHandler, `{ _site { locales } }`);
      expect(result.data._site.locales).toEqual([]);
    });

    it("reads globalSeo from the site_settings table", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe("INSERT OR IGNORE INTO site_settings (id) VALUES ('default')");
          yield* sql.unsafe(
            `UPDATE site_settings
             SET site_name = ?, title_suffix = ?, fallback_seo_title = ?, fallback_seo_description = ?, updated_at = datetime('now')
             WHERE id = 'default'`,
            [
              JSON.stringify({ en: "Agent CMS" }),
              JSON.stringify({ en: "Blog" }),
              JSON.stringify({ en: "Fallback title" }),
              JSON.stringify({ en: "Fallback description" }),
            ]
          );
        }).pipe(Effect.provide(sqlLayer))
      );

      const result = await gqlQuery(handler, `{
        _site {
          globalSeo(locale: en) {
            siteName
            titleSuffix
            fallbackSeo {
              title
              description
            }
          }
        }
      }`);

      expect(result.errors).toBeUndefined();
      expect(result.data._site.globalSeo).toEqual({
        siteName: "Agent CMS",
        titleSuffix: "Blog",
        fallbackSeo: {
          title: "Fallback title",
          description: "Fallback description",
        },
      });
    });
  });
});
