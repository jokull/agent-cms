import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestApp, jsonRequest } from "./app-helpers.js";

describe("Asset REST API", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(() => {
    ({ handler } = createTestApp());
  });

  describe("POST /api/assets", () => {
    it("creates an asset with metadata", async () => {
      const res = await jsonRequest(handler, "POST", "/api/assets", {
        filename: "hero.jpg",
        mimeType: "image/jpeg",
        size: 50000,
        width: 1920,
        height: 1080,
        alt: "Hero image",
        title: "Homepage Hero",
      });

      expect(res.status).toBe(201);
      const asset = await res.json();
      expect(asset.id).toBeTruthy();
      expect(asset.filename).toBe("hero.jpg");
      expect(asset.mimeType).toBe("image/jpeg");
      expect(asset.size).toBe(50000);
      expect(asset.width).toBe(1920);
      expect(asset.height).toBe(1080);
      expect(asset.alt).toBe("Hero image");
      expect(asset.r2Key).toContain(asset.id);
    });

    it("creates an asset with minimal fields", async () => {
      const res = await jsonRequest(handler, "POST", "/api/assets", {
        filename: "doc.pdf",
        mimeType: "application/pdf",
      });

      expect(res.status).toBe(201);
      const asset = await res.json();
      expect(asset.filename).toBe("doc.pdf");
      expect(asset.size).toBe(0);
    });

    it("rejects missing filename", async () => {
      const res = await jsonRequest(handler, "POST", "/api/assets", {
        mimeType: "image/jpeg",
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing mimeType", async () => {
      const res = await jsonRequest(handler, "POST", "/api/assets", {
        filename: "test.jpg",
      });
      expect(res.status).toBe(400);
    });

    it("imports a remote asset from URL while preserving an explicit asset ID", async () => {
      const put = vi.fn(async () => null);
      const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": "4",
        },
      }));
      ({ handler } = createTestApp({
        r2Bucket: { put } as R2Bucket,
        fetch: fetchMock as typeof fetch,
      }));

      const res = await jsonRequest(handler, "POST", "/api/assets/import-from-url", {
        id: "dato_asset_123",
        url: "https://images.example.com/photo.png",
        filename: "photo.png",
        mimeType: "image/png",
        alt: "Remote photo",
      });

      expect(res.status).toBe(201);
      const asset = await res.json();
      expect(asset.id).toBe("dato_asset_123");
      expect(asset.r2Key).toBe("uploads/dato_asset_123/photo.png");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(put).toHaveBeenCalledWith(
        "uploads/dato_asset_123/photo.png",
        expect.any(Uint8Array),
        { httpMetadata: { contentType: "image/png" } },
      );
    });
  });

  describe("GET /api/assets", () => {
    it("lists all assets", async () => {
      await jsonRequest(handler, "POST", "/api/assets", { filename: "a.jpg", mimeType: "image/jpeg" });
      await jsonRequest(handler, "POST", "/api/assets", { filename: "b.png", mimeType: "image/png" });

      const res = await handler(new Request("http://localhost/api/assets"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.assets).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it("returns empty list initially", async () => {
      const res = await handler(new Request("http://localhost/api/assets"));
      const body = await res.json();
      expect(body).toEqual({ assets: [], total: 0 });
    });

    it("clamps oversized asset search limits and rejects invalid offsets", async () => {
      await jsonRequest(handler, "POST", "/api/assets", { filename: "a.jpg", mimeType: "image/jpeg" });
      await jsonRequest(handler, "POST", "/api/assets", { filename: "b.jpg", mimeType: "image/jpeg" });

      const clamped = await handler(new Request("http://localhost/api/assets?limit=1000"));
      expect(clamped.status).toBe(200);
      const body = await clamped.json();
      expect(body.assets).toHaveLength(2);
      expect(body.total).toBe(2);

      const invalidOffset = await handler(new Request("http://localhost/api/assets?offset=-1"));
      expect(invalidOffset.status).toBe(400);

      const notANumber = await handler(new Request("http://localhost/api/assets?limit=nope"));
      expect(notANumber.status).toBe(400);
    });

    it("matches q case-insensitively against filename", async () => {
      await jsonRequest(handler, "POST", "/api/assets", { filename: "Hero-Banner.jpg", mimeType: "image/jpeg" });
      await jsonRequest(handler, "POST", "/api/assets", { filename: "unrelated.png", mimeType: "image/png" });

      const res = await handler(new Request("http://localhost/api/assets?q=hero-banner"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.assets).toHaveLength(1);
      expect(body.total).toBe(1);
      expect(body.assets[0].filename).toBe("Hero-Banner.jpg");
    });

    it("matches q case-insensitively against alt text", async () => {
      await jsonRequest(handler, "POST", "/api/assets", {
        filename: "a.jpg", mimeType: "image/jpeg", alt: "A Golden Retriever running",
      });
      await jsonRequest(handler, "POST", "/api/assets", { filename: "b.jpg", mimeType: "image/jpeg", alt: "A cat" });

      const res = await handler(new Request("http://localhost/api/assets?q=RETRIEVER"));
      const body = await res.json();
      expect(body.assets).toHaveLength(1);
      expect(body.assets[0].alt).toBe("A Golden Retriever running");
    });

    it("treats % and _ in q as literal characters, not LIKE wildcards", async () => {
      await jsonRequest(handler, "POST", "/api/assets", { filename: "report_2026.jpg", mimeType: "image/jpeg" });
      await jsonRequest(handler, "POST", "/api/assets", { filename: "report-2026.jpg", mimeType: "image/jpeg" });
      await jsonRequest(handler, "POST", "/api/assets", { filename: "reportX2026.jpg", mimeType: "image/jpeg" });
      await jsonRequest(handler, "POST", "/api/assets", { filename: "50-percent-off.jpg", mimeType: "image/jpeg", title: "50% off" });

      // A literal underscore must only match "report_2026.jpg", not the dash/X variants.
      const underscoreRes = await handler(new Request("http://localhost/api/assets?q=report_2026"));
      const underscoreBody = await underscoreRes.json();
      expect(underscoreBody.assets).toHaveLength(1);
      expect(underscoreBody.assets[0].filename).toBe("report_2026.jpg");

      // A literal "50%" must not act as a wildcard that matches everything.
      const percentRes = await handler(new Request(`http://localhost/api/assets?q=${encodeURIComponent("50%")}`));
      const percentBody = await percentRes.json();
      expect(percentBody.assets).toHaveLength(1);
      expect(percentBody.assets[0].title).toBe("50% off");
    });

    it("paginates with an accurate total across pages", async () => {
      for (let i = 0; i < 5; i++) {
        await jsonRequest(handler, "POST", "/api/assets", { filename: `file-${i}.jpg`, mimeType: "image/jpeg" });
      }

      const page1 = await (await handler(new Request("http://localhost/api/assets?limit=2&offset=0"))).json();
      expect(page1.assets).toHaveLength(2);
      expect(page1.total).toBe(5);

      const page2 = await (await handler(new Request("http://localhost/api/assets?limit=2&offset=2"))).json();
      expect(page2.assets).toHaveLength(2);
      expect(page2.total).toBe(5);

      const page3 = await (await handler(new Request("http://localhost/api/assets?limit=2&offset=4"))).json();
      expect(page3.assets).toHaveLength(1);
      expect(page3.total).toBe(5);

      const ids = [...page1.assets, ...page2.assets, ...page3.assets].map((a: { id: string }) => a.id);
      expect(new Set(ids).size).toBe(5);
    });

    it("orders by filename ascending and size descending", async () => {
      await jsonRequest(handler, "POST", "/api/assets", { filename: "charlie.jpg", mimeType: "image/jpeg", size: 100 });
      await jsonRequest(handler, "POST", "/api/assets", { filename: "alpha.jpg", mimeType: "image/jpeg", size: 300 });
      await jsonRequest(handler, "POST", "/api/assets", { filename: "bravo.jpg", mimeType: "image/jpeg", size: 200 });

      const byFilename = await (await handler(new Request("http://localhost/api/assets?orderBy=filename_ASC"))).json();
      expect(byFilename.assets.map((a: { filename: string }) => a.filename)).toEqual([
        "alpha.jpg", "bravo.jpg", "charlie.jpg",
      ]);

      const bySizeDesc = await (await handler(new Request("http://localhost/api/assets?orderBy=size_DESC"))).json();
      expect(bySizeDesc.assets.map((a: { filename: string }) => a.filename)).toEqual([
        "alpha.jpg", "bravo.jpg", "charlie.jpg",
      ]);
    });

    it("rejects an invalid orderBy spec", async () => {
      const res = await handler(new Request("http://localhost/api/assets?orderBy=bogus"));
      expect(res.status).toBe(400);
    });

    it("rejects an orderBy on an unknown field", async () => {
      const res = await handler(new Request("http://localhost/api/assets?orderBy=alt_ASC"));
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/assets/:id/usages", () => {
    let modelId: string;

    beforeEach(async () => {
      const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
      const model = await modelRes.json();
      modelId = model.id;
      await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, { label: "Title", apiKey: "title", fieldType: "string" });
      await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, { label: "Cover", apiKey: "cover", fieldType: "media" });
      await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, { label: "Gallery", apiKey: "gallery", fieldType: "media_gallery" });
      await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, { label: "SEO", apiKey: "seo", fieldType: "seo" });
    });

    it("finds a record referencing the asset via a media field", async () => {
      const asset = await (await jsonRequest(handler, "POST", "/api/assets", { filename: "hero.jpg", mimeType: "image/jpeg" })).json();
      const record = await (await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post",
        data: { title: "My Post", cover: asset.id },
      })).json();

      const res = await handler(new Request(`http://localhost/api/assets/${asset.id}/usages`));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.usages).toEqual([
        { modelApiKey: "post", recordId: record.id, fieldApiKey: "cover" },
      ]);
    });

    it("finds a record referencing the asset via a media_gallery field", async () => {
      const asset = await (await jsonRequest(handler, "POST", "/api/assets", { filename: "g.jpg", mimeType: "image/jpeg" })).json();
      const other = await (await jsonRequest(handler, "POST", "/api/assets", { filename: "other.jpg", mimeType: "image/jpeg" })).json();
      const record = await (await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post",
        data: { title: "Gallery Post", gallery: [other.id, asset.id] },
      })).json();

      const res = await handler(new Request(`http://localhost/api/assets/${asset.id}/usages`));
      const body = await res.json();
      expect(body.usages).toEqual([
        { modelApiKey: "post", recordId: record.id, fieldApiKey: "gallery" },
      ]);
    });

    it("finds a record referencing the asset via seo.image", async () => {
      const asset = await (await jsonRequest(handler, "POST", "/api/assets", { filename: "og.jpg", mimeType: "image/jpeg" })).json();
      const record = await (await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post",
        data: { title: "SEO Post", seo: { title: "T", image: asset.id } },
      })).json();

      const res = await handler(new Request(`http://localhost/api/assets/${asset.id}/usages`));
      const body = await res.json();
      expect(body.usages).toEqual([
        { modelApiKey: "post", recordId: record.id, fieldApiKey: "seo" },
      ]);
    });

    it("returns an empty list for an unreferenced asset", async () => {
      const asset = await (await jsonRequest(handler, "POST", "/api/assets", { filename: "unused.jpg", mimeType: "image/jpeg" })).json();
      await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "No refs" } });

      const res = await handler(new Request(`http://localhost/api/assets/${asset.id}/usages`));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.usages).toEqual([]);
    });

    it("returns 404 for an unknown asset", async () => {
      const res = await handler(new Request("http://localhost/api/assets/nonexistent/usages"));
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/assets/:id", () => {
    it("returns a single asset", async () => {
      const createRes = await jsonRequest(handler, "POST", "/api/assets", {
        filename: "hero.jpg", mimeType: "image/jpeg", width: 800, height: 600,
      });
      const created = await createRes.json();

      const res = await handler(new Request(`http://localhost/api/assets/${created.id}`));
      expect(res.status).toBe(200);
      const asset = await res.json();
      expect(asset.filename).toBe("hero.jpg");
    });

    it("returns 404 for unknown asset", async () => {
      const res = await handler(new Request("http://localhost/api/assets/nonexistent"));
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/assets/:id", () => {
    it("deletes an asset", async () => {
      const createRes = await jsonRequest(handler, "POST", "/api/assets", {
        filename: "doomed.jpg", mimeType: "image/jpeg",
      });
      const created = await createRes.json();

      const deleteRes = await handler(new Request(`http://localhost/api/assets/${created.id}`, { method: "DELETE" }));
      expect(deleteRes.status).toBe(200);

      const getRes = await handler(new Request(`http://localhost/api/assets/${created.id}`));
      expect(getRes.status).toBe(404);
    });

    it("returns 404 for unknown asset", async () => {
      const res = await handler(new Request("http://localhost/api/assets/nonexistent", { method: "DELETE" }));
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/assets/:id — reference guard", () => {
    async function setupReferencedAsset() {
      const asset = await (await jsonRequest(handler, "POST", "/api/assets", {
        filename: "used.jpg", mimeType: "image/jpeg",
      })).json();

      const model = await (await jsonRequest(handler, "POST", "/api/models", { name: "Gallery", apiKey: "gallery" })).json();
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, { label: "Image", apiKey: "image", fieldType: "media" });
      const record = await (await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "gallery",
        data: { image: asset.id },
      })).json();

      return { assetId: asset.id, recordId: record.id };
    }

    it("blocks deletion with 409 + references when the asset is in use", async () => {
      const { assetId, recordId } = await setupReferencedAsset();

      const res = await handler(new Request(`http://localhost/api/assets/${assetId}`, { method: "DELETE" }));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(Array.isArray(body.references)).toBe(true);
      expect(body.references).toContain(`gallery.image (${recordId})`);

      // Still present.
      const getRes = await handler(new Request(`http://localhost/api/assets/${assetId}`));
      expect(getRes.status).toBe(200);
    });

    it("deletes a referenced asset when force=true is passed", async () => {
      const { assetId } = await setupReferencedAsset();

      const res = await handler(new Request(`http://localhost/api/assets/${assetId}?force=true`, { method: "DELETE" }));
      expect(res.status).toBe(200);

      const getRes = await handler(new Request(`http://localhost/api/assets/${assetId}`));
      expect(getRes.status).toBe(404);
    });

    it("deletes an unreferenced asset without force", async () => {
      const asset = await (await jsonRequest(handler, "POST", "/api/assets", {
        filename: "free.jpg", mimeType: "image/jpeg",
      })).json();

      const res = await handler(new Request(`http://localhost/api/assets/${asset.id}`, { method: "DELETE" }));
      expect(res.status).toBe(200);
    });
  });
});
