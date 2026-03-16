import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest } from "./app-helpers.js";

describe("PATCH validation: composite fields + slug uniqueness", () => {
  let handler: (req: Request) => Promise<Response>;
  let modelId: string;

  beforeEach(async () => {
    ({ handler } = createTestApp());
    const res = await jsonRequest(handler, "POST", "/api/models", { name: "Item", apiKey: "item" });
    const model = await res.json();
    modelId = model.id;
  });

  describe("composite field validation on patch", () => {
    it("rejects invalid color on patch", async () => {
      await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
        label: "Color", apiKey: "color", fieldType: "color",
      });
      await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
        label: "Name", apiKey: "name", fieldType: "string",
      });

      const createRes = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "item", data: { name: "thing", color: { red: 100, green: 200, blue: 50 } },
      });
      const record = await createRes.json();

      const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}`, {
        modelApiKey: "item", data: { color: { red: 999, green: 0, blue: 0 } },
      });
      expect(patchRes.status).toBe(400);
      const body = await patchRes.json();
      expect(body.error).toContain("color");
    });

    it("rejects invalid lat_lon on patch", async () => {
      await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
        label: "Location", apiKey: "location", fieldType: "lat_lon",
      });
      await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
        label: "Name", apiKey: "name", fieldType: "string",
      });

      const createRes = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "item", data: { name: "place", location: { latitude: 64.1, longitude: -21.9 } },
      });
      const record = await createRes.json();

      const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}`, {
        modelApiKey: "item", data: { location: { latitude: 200, longitude: 0 } },
      });
      expect(patchRes.status).toBe(400);
    });

    it("accepts valid composite field on patch", async () => {
      await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
        label: "Color", apiKey: "color", fieldType: "color",
      });
      await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
        label: "Name", apiKey: "name", fieldType: "string",
      });

      const createRes = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "item", data: { name: "thing", color: { red: 100, green: 200, blue: 50 } },
      });
      const record = await createRes.json();

      const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}`, {
        modelApiKey: "item", data: { color: { red: 0, green: 255, blue: 128 } },
      });
      expect(patchRes.status).toBe(200);
    });

    it("allows nulling a composite field on patch", async () => {
      await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
        label: "Color", apiKey: "color", fieldType: "color",
      });
      await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
        label: "Name", apiKey: "name", fieldType: "string",
      });

      const createRes = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "item", data: { name: "thing", color: { red: 100, green: 200, blue: 50 } },
      });
      const record = await createRes.json();

      const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}`, {
        modelApiKey: "item", data: { color: null },
      });
      expect(patchRes.status).toBe(200);
    });
  });

  describe("slug uniqueness on patch", () => {
    beforeEach(async () => {
      await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });
      await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
        label: "Slug", apiKey: "slug", fieldType: "slug", validators: { slug_source: "title" },
      });
    });

    it("auto-deduplicates slug on patch when collision exists", async () => {
      const r1 = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "item", data: { title: "Hello", slug: "hello" },
      });
      const rec1 = await r1.json();

      const r2 = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "item", data: { title: "World", slug: "world" },
      });
      const rec2 = await r2.json();

      // Patch rec2's slug to collide with rec1
      const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${rec2.id}`, {
        modelApiKey: "item", data: { slug: "hello" },
      });
      expect(patchRes.status).toBe(200);
      const patched = await patchRes.json();
      expect(patched.slug).toBe("hello-2"); // Deduped
    });

    it("keeps same slug when patching to own existing slug", async () => {
      const r1 = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "item", data: { title: "Hello", slug: "hello" },
      });
      const rec1 = await r1.json();

      // Patch rec1's slug to its own value — should not add suffix
      const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${rec1.id}`, {
        modelApiKey: "item", data: { slug: "hello" },
      });
      expect(patchRes.status).toBe(200);
      const patched = await patchRes.json();
      expect(patched.slug).toBe("hello");
    });

    it("normalizes slug on patch", async () => {
      const r1 = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "item", data: { title: "Hello", slug: "hello" },
      });
      const rec1 = await r1.json();

      const patchRes = await jsonRequest(handler, "PATCH", `/api/records/${rec1.id}`, {
        modelApiKey: "item", data: { slug: "Hello World!" },
      });
      expect(patchRes.status).toBe(200);
      const patched = await patchRes.json();
      expect(patched.slug).toBe("hello-world");
    });
  });
});
