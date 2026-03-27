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
      const assets = await res.json();
      expect(assets).toHaveLength(2);
    });

    it("returns empty list initially", async () => {
      const res = await handler(new Request("http://localhost/api/assets"));
      const assets = await res.json();
      expect(assets).toEqual([]);
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
});
