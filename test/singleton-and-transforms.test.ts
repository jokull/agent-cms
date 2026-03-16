import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("Singleton models", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    ({ handler } = createTestApp());

    const modelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Homepage", apiKey: "homepage", singleton: true,
    });
    const model = await modelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Hero Title", apiKey: "hero_title", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Hero Subtitle", apiKey: "hero_subtitle", fieldType: "text",
    });
  });

  it("queries singleton model without id or filter arguments", async () => {
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "homepage",
      data: { hero_title: "Welcome", hero_subtitle: "To our site" },
    });

    // DatoCMS-style singleton query: just `homepage { ... }` — no id, no filter
    const result = await gqlQuery(handler, `{
      homepage { hero_title hero_subtitle _modelApiKey }
    }`, { includeDrafts: true });

    expect(result.errors).toBeUndefined();
    expect(result.data.homepage).not.toBeNull();
    expect(result.data.homepage.hero_title).toBe("Welcome");
    expect(result.data.homepage.hero_subtitle).toBe("To our site");
    expect(result.data.homepage._modelApiKey).toBe("homepage");
  });

  it("returns null when singleton has no record", async () => {
    const result = await gqlQuery(handler, `{
      homepage { hero_title }
    }`, { includeDrafts: true });

    expect(result.errors).toBeUndefined();
    expect(result.data.homepage).toBeNull();
  });

  it("singleton still supports id argument for explicit lookup", async () => {
    const record = await (await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "homepage",
      data: { hero_title: "Hello" },
    })).json();

    const result = await gqlQuery(handler, `{
      homepage(id: "${record.id}") { hero_title }
    }`, { includeDrafts: true });

    expect(result.errors).toBeUndefined();
    expect(result.data.homepage.hero_title).toBe("Hello");
  });
});

describe("responsiveImage with transforms", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    ({ handler } = createTestApp());

    const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
    const model = await modelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Cover", apiKey: "cover", fieldType: "media",
    });

    const assetRes = await jsonRequest(handler, "POST", "/api/assets", {
      filename: "hero.jpg", mimeType: "image/jpeg", size: 100000,
      width: 2400, height: 1600, alt: "Hero",
    });
    const asset = await assetRes.json();

    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: { title: "My Post", cover: asset.id },
    });
  });

  it("returns default responsiveImage without params", async () => {
    const result = await gqlQuery(handler, `{
      allPosts {
        cover {
          responsiveImage { src srcSet webpSrcSet width height aspectRatio }
        }
      }
    }`, { includeDrafts: true });

    expect(result.errors).toBeUndefined();
    const img = result.data.allPosts[0].cover.responsiveImage;
    expect(img.width).toBe(2400);
    expect(img.height).toBe(1600);
    expect(img.aspectRatio).toBeCloseTo(1.5);
    expect(img.srcSet).toContain("320w");
    expect(img.srcSet).toContain("2400w");
    expect(img.webpSrcSet).toContain("format=webp");
  });

  it("accepts transforms argument with width and height", async () => {
    const result = await gqlQuery(handler, `{
      allPosts {
        cover {
          responsiveImage(transforms: { width: 600, height: 400, fit: "cover" }) {
            src width height aspectRatio srcSet
          }
        }
      }
    }`, { includeDrafts: true });

    expect(result.errors).toBeUndefined();
    const img = result.data.allPosts[0].cover.responsiveImage;
    expect(img.width).toBe(600);
    expect(img.height).toBe(400);
    expect(img.aspectRatio).toBeCloseTo(1.5);
    expect(img.src).toContain("w=600");
    expect(img.src).toContain("fit=cover");
    // srcSet breakpoints should be capped at 600
    expect(img.srcSet).toContain("320w");
    expect(img.srcSet).toContain("600w");
    expect(img.srcSet).not.toContain("960w");
  });

  it("accepts cfImagesParams as alias", async () => {
    const result = await gqlQuery(handler, `{
      allPosts {
        cover {
          responsiveImage(cfImagesParams: { width: 800, quality: 80 }) {
            src width
          }
        }
      }
    }`, { includeDrafts: true });

    expect(result.errors).toBeUndefined();
    const img = result.data.allPosts[0].cover.responsiveImage;
    expect(img.width).toBe(800);
    expect(img.src).toContain("q=80");
  });

  it("exposes blurhash on Asset type", async () => {
    // Create asset with blurhash
    const assetRes = await jsonRequest(handler, "POST", "/api/assets", {
      filename: "blur.jpg", mimeType: "image/jpeg", size: 5000,
      width: 100, height: 100, blurhash: "UeKUpHxu",
    });
    const asset = await assetRes.json();

    const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Card", apiKey: "card" });
    const model = await modelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Image", apiKey: "image", fieldType: "media",
    });
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "card", data: { image: asset.id },
    });

    const result = await gqlQuery(handler, `{
      allCards { image { blurhash } }
    }`, { includeDrafts: true });

    expect(result.errors).toBeUndefined();
    expect(result.data.allCards[0].image.blurhash).toBe("UeKUpHxu");
  });
});
