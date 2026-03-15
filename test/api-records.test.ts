import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest } from "./app-helpers.js";
import type { Hono } from "hono";

describe("Records REST API", () => {
  let app: Hono;
  let db: any;
  let modelId: string;

  beforeEach(async () => {
    ({ app, db } = createTestApp());

    // Create model with fields
    const modelRes = await jsonRequest(app, "POST", "/api/models", {
      name: "Post",
      apiKey: "post",
    });
    const model = await modelRes.json();
    modelId = model.id;

    await jsonRequest(app, "POST", `/api/models/${modelId}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    await jsonRequest(app, "POST", `/api/models/${modelId}/fields`, {
      label: "Body", apiKey: "body", fieldType: "text",
    });
    await jsonRequest(app, "POST", `/api/models/${modelId}/fields`, {
      label: "Views", apiKey: "views", fieldType: "integer",
    });
    await jsonRequest(app, "POST", `/api/models/${modelId}/fields`, {
      label: "Published", apiKey: "published", fieldType: "boolean",
    });
  });

  describe("POST /api/records", () => {
    it("creates a record with field values", async () => {
      const res = await jsonRequest(app, "POST", "/api/records", {
        modelApiKey: "post",
        data: {
          title: "Hello World",
          body: "This is my first post",
          views: 42,
          published: true,
        },
      });

      expect(res.status).toBe(201);
      const record = await res.json();
      expect(record.title).toBe("Hello World");
      expect(record.body).toBe("This is my first post");
      expect(record.views).toBe(42);
      expect(record.published).toBe(true);
      expect(record._status).toBe("draft");
      expect(record.id).toBeTruthy();
    });

    it("creates a record with partial data", async () => {
      const res = await jsonRequest(app, "POST", "/api/records", {
        modelApiKey: "post",
        data: { title: "Just a title" },
      });

      expect(res.status).toBe(201);
      const record = await res.json();
      expect(record.title).toBe("Just a title");
      // Fields not provided are undefined in the insert response
      // but null when read back from the database
      const getRes = await app.request(`/api/records/${record.id}?modelApiKey=post`);
      const fromDb = await getRes.json();
      expect(fromDb.body).toBeNull();
    });

    it("rejects unknown model", async () => {
      const res = await jsonRequest(app, "POST", "/api/records", {
        modelApiKey: "nonexistent",
        data: {},
      });
      expect(res.status).toBe(404);
    });

    it("validates required fields", async () => {
      // Add a required field
      await jsonRequest(app, "POST", `/api/models/${modelId}/fields`, {
        label: "Slug",
        apiKey: "slug",
        fieldType: "slug",
        validators: { required: true },
      });

      const res = await jsonRequest(app, "POST", "/api/records", {
        modelApiKey: "post",
        data: { title: "No slug" },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("slug");
      expect(body.error).toContain("required");
    });

    it("enforces singleton constraint", async () => {
      // Create a singleton model
      const singletonRes = await jsonRequest(app, "POST", "/api/models", {
        name: "Homepage",
        apiKey: "homepage",
        singleton: true,
      });
      const singleton = await singletonRes.json();
      await jsonRequest(app, "POST", `/api/models/${singleton.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });

      // First record OK
      const res1 = await jsonRequest(app, "POST", "/api/records", {
        modelApiKey: "homepage",
        data: { title: "Welcome" },
      });
      expect(res1.status).toBe(201);

      // Second record rejected
      const res2 = await jsonRequest(app, "POST", "/api/records", {
        modelApiKey: "homepage",
        data: { title: "Another" },
      });
      expect(res2.status).toBe(409);
    });
  });

  describe("GET /api/records", () => {
    it("lists records for a model", async () => {
      await jsonRequest(app, "POST", "/api/records", {
        modelApiKey: "post",
        data: { title: "Post 1" },
      });
      await jsonRequest(app, "POST", "/api/records", {
        modelApiKey: "post",
        data: { title: "Post 2" },
      });

      const res = await app.request("/api/records?modelApiKey=post");
      expect(res.status).toBe(200);
      const records = await res.json();
      expect(records).toHaveLength(2);
    });

    it("requires modelApiKey parameter", async () => {
      const res = await app.request("/api/records");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/records/:id", () => {
    it("returns a single record", async () => {
      const createRes = await jsonRequest(app, "POST", "/api/records", {
        modelApiKey: "post",
        data: { title: "My Post", views: 10 },
      });
      const created = await createRes.json();

      const res = await app.request(`/api/records/${created.id}?modelApiKey=post`);
      expect(res.status).toBe(200);
      const record = await res.json();
      expect(record.title).toBe("My Post");
      expect(record.views).toBe(10);
    });

    it("returns 404 for unknown record", async () => {
      const res = await app.request("/api/records/nonexistent?modelApiKey=post");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /api/records/:id", () => {
    it("updates record fields", async () => {
      const createRes = await jsonRequest(app, "POST", "/api/records", {
        modelApiKey: "post",
        data: { title: "Original", views: 0 },
      });
      const created = await createRes.json();

      const res = await jsonRequest(app, "PATCH", `/api/records/${created.id}`, {
        modelApiKey: "post",
        data: { title: "Updated", views: 100 },
      });

      expect(res.status).toBe(200);
      const updated = await res.json();
      expect(updated.title).toBe("Updated");
      expect(updated.views).toBe(100);
    });

    it("returns 404 for unknown record", async () => {
      const res = await jsonRequest(app, "PATCH", "/api/records/nonexistent", {
        modelApiKey: "post",
        data: { title: "X" },
      });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/records/:id", () => {
    it("deletes a record", async () => {
      const createRes = await jsonRequest(app, "POST", "/api/records", {
        modelApiKey: "post",
        data: { title: "Doomed" },
      });
      const created = await createRes.json();

      const res = await app.request(`/api/records/${created.id}?modelApiKey=post`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);

      // Verify gone
      const getRes = await app.request(`/api/records/${created.id}?modelApiKey=post`);
      expect(getRes.status).toBe(404);
    });
  });
});
