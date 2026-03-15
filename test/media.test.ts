import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("Media fields", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    ({ handler } = createTestApp());

    const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
    const model = await modelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, { label: "Title", apiKey: "title", fieldType: "string" });
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, { label: "Cover", apiKey: "cover", fieldType: "media" });
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, { label: "Gallery", apiKey: "gallery", fieldType: "media_gallery" });
  });

  it("resolves media field to asset object in GraphQL", async () => {
    // Create asset
    const assetRes = await jsonRequest(handler, "POST", "/api/assets", {
      filename: "hero.jpg", mimeType: "image/jpeg", size: 50000, width: 1920, height: 1080, alt: "Hero image",
    });
    const asset = await assetRes.json();

    // Create record with media field
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: { title: "My Post", cover: asset.id },
    });

    const result = await gqlQuery(handler, `{
      allPosts {
        title
        cover { id filename mimeType width height alt url }
      }
    }`);

    expect(result.errors).toBeUndefined();
    const post = result.data.allPosts[0];
    expect(post.cover.filename).toBe("hero.jpg");
    expect(post.cover.mimeType).toBe("image/jpeg");
    expect(post.cover.width).toBe(1920);
    expect(post.cover.height).toBe(1080);
    expect(post.cover.alt).toBe("Hero image");
    expect(post.cover.url).toContain(asset.id);
  });

  it("returns null for unset media field", async () => {
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: { title: "No cover" },
    });

    const result = await gqlQuery(handler, `{ allPosts { title cover { id } } }`);
    expect(result.data.allPosts[0].cover).toBeNull();
  });

  it("resolves media_gallery to array of asset objects", async () => {
    const a1 = await (await jsonRequest(handler, "POST", "/api/assets", { filename: "a.jpg", mimeType: "image/jpeg", size: 1000 })).json();
    const a2 = await (await jsonRequest(handler, "POST", "/api/assets", { filename: "b.jpg", mimeType: "image/jpeg", size: 2000 })).json();
    const a3 = await (await jsonRequest(handler, "POST", "/api/assets", { filename: "c.jpg", mimeType: "image/jpeg", size: 3000 })).json();

    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: { title: "Gallery Post", gallery: [a1.id, a2.id, a3.id] },
    });

    const result = await gqlQuery(handler, `{
      allPosts {
        title
        gallery { id filename size }
      }
    }`);

    expect(result.errors).toBeUndefined();
    const post = result.data.allPosts[0];
    expect(post.gallery).toHaveLength(3);
    expect(post.gallery[0].filename).toBe("a.jpg");
    expect(post.gallery[1].filename).toBe("b.jpg");
    expect(post.gallery[2].filename).toBe("c.jpg");
  });

  it("returns empty array for unset media_gallery", async () => {
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: { title: "No gallery" },
    });

    const result = await gqlQuery(handler, `{ allPosts { gallery { id } } }`);
    expect(result.data.allPosts[0].gallery).toEqual([]);
  });
});
