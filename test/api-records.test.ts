import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest } from "./app-helpers.js";

describe("Records REST API", () => {
  let handler: (req: Request) => Promise<Response>;
  let modelId: string;

  beforeEach(async () => {
    ({ handler } = createTestApp());
    const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
    const model = await modelRes.json();
    modelId = model.id;

    await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, { label: "Title", apiKey: "title", fieldType: "string" });
    await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, { label: "Body", apiKey: "body", fieldType: "text" });
    await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, { label: "Views", apiKey: "views", fieldType: "integer" });
    await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, { label: "Published", apiKey: "published", fieldType: "boolean" });
  });

  describe("POST /api/records", () => {
    it("creates a record with field values", async () => {
      const res = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post",
        data: { title: "Hello World", body: "My first post", views: 42, published: true },
      });
      expect(res.status).toBe(201);
      const record = await res.json();
      expect(record.title).toBe("Hello World");
      expect(record.views).toBe(42);
      expect(record._status).toBe("draft");
    });

    it("creates a record with partial data", async () => {
      const res = await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "Just a title" } });
      expect(res.status).toBe(201);
      const record = await res.json();

      const getRes = await handler(new Request(`http://localhost/api/records/${record.id}?modelApiKey=post`));
      const fromDb = await getRes.json();
      expect(fromDb.body).toBeNull();
    });

    it("rejects unknown model", async () => {
      const res = await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "nonexistent", data: {} });
      expect(res.status).toBe(404);
    });

    it("allows saving drafts without required fields, rejects on publish", async () => {
      await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
        label: "Slug", apiKey: "slug", fieldType: "slug", validators: { required: true },
      });
      // Draft models allow saving without required fields
      const res = await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "No slug" } });
      expect(res.status).toBe(201);
      const record = await res.json();
      // But publishing should fail
      const pubRes = await jsonRequest(handler, "POST", `/api/records/${record.id}/publish?modelApiKey=post`);
      expect(pubRes.status).toBe(400);
    });

    it("validates required fields on create for non-draft models", async () => {
      const ndRes = await jsonRequest(handler, "POST", "/api/models", { name: "Page", apiKey: "page", hasDraft: false });
      const ndModel = await ndRes.json();
      await jsonRequest(handler, "POST", `/api/models/${ndModel.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string", validators: { required: true },
      });
      const res = await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "page", data: {} });
      expect(res.status).toBe(400);
    });

    it("enforces singleton constraint", async () => {
      const sRes = await jsonRequest(handler, "POST", "/api/models", { name: "Homepage", apiKey: "homepage", singleton: true });
      const s = await sRes.json();
      await jsonRequest(handler, "POST", `/api/models/${s.id}/fields`, { label: "Title", apiKey: "title", fieldType: "string" });

      const res1 = await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "homepage", data: { title: "Welcome" } });
      expect(res1.status).toBe(201);
      const res2 = await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "homepage", data: { title: "Another" } });
      expect(res2.status).toBe(409);
    });

    it("rejects non-existent link references on create", async () => {
      const authorRes = await jsonRequest(handler, "POST", "/api/models", { name: "Author", apiKey: "author" });
      const author = await authorRes.json();
      await jsonRequest(handler, "POST", `/api/models/${author.id}/fields`, { label: "Name", apiKey: "name", fieldType: "string" });
      await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
        label: "Author", apiKey: "author", fieldType: "link", validators: { item_item_type: ["author"] },
      });

      const res = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post",
        data: { title: "Broken", author: "01NONEXISTENTAUTHOR0000000000" },
      });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: expect.stringContaining("Linked record(s) not found for field 'author'"),
      });
    });

    it("rejects link objects that use id instead of a record ID string with a clear error", async () => {
      const categoryRes = await jsonRequest(handler, "POST", "/api/models", { name: "Category", apiKey: "category" });
      const category = await categoryRes.json();
      await jsonRequest(handler, "POST", `/api/models/${category.id}/fields`, { label: "Name", apiKey: "name", fieldType: "string" });
      await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
        label: "Category", apiKey: "category", fieldType: "link", validators: { item_item_type: ["category"] },
      });

      const res = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post",
        data: { title: "Broken link shape", category: { id: "01NONEXISTENTCATEGORY00000000" } },
      });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: expect.stringContaining("Invalid link for field 'category': use a record ID string, not {\"id\":\"...\"}"),
      });
    });
  });

  describe("GET /api/records", () => {
    it("lists records", async () => {
      await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "Post 1" } });
      await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "Post 2" } });
      const res = await handler(new Request("http://localhost/api/records?modelApiKey=post"));
      const body = await res.json();
      expect(body).toHaveLength(2);
    });

    it("requires modelApiKey", async () => {
      const res = await handler(new Request("http://localhost/api/records"));
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/records/:id", () => {
    it("returns a single record", async () => {
      const createRes = await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "My Post", views: 10 } });
      const created = await createRes.json();
      const res = await handler(new Request(`http://localhost/api/records/${created.id}?modelApiKey=post`));
      const record = await res.json();
      expect(record.title).toBe("My Post");
    });
  });

  describe("PATCH /api/records/:id", () => {
    it("updates record fields", async () => {
      const createRes = await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "Original", views: 0 } });
      const created = await createRes.json();
      const res = await jsonRequest(handler, "PATCH", `/api/records/${created.id}`, { modelApiKey: "post", data: { title: "Updated", views: 100 } });
      const updated = await res.json();
      expect(updated.title).toBe("Updated");
      expect(updated.views).toBe(100);
    });
  });

  describe("DELETE /api/records/:id", () => {
    it("deletes a record", async () => {
      const createRes = await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "Doomed" } });
      const created = await createRes.json();
      const res = await handler(new Request(`http://localhost/api/records/${created.id}?modelApiKey=post`, { method: "DELETE" }));
      expect(res.status).toBe(200);
      const getRes = await handler(new Request(`http://localhost/api/records/${created.id}?modelApiKey=post`));
      expect(getRes.status).toBe(404);
    });
  });
});
