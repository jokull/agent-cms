import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { createTestApp, jsonRequest } from "./app-helpers.js";
import type { Hono } from "hono";

describe("Models REST API", () => {
  let app: Hono;
  let db: any;

  beforeEach(() => {
    ({ app, db } = createTestApp());
  });

  describe("POST /api/models", () => {
    it("creates a model and its content table", async () => {
      const res = await jsonRequest(app, "POST", "/api/models", {
        name: "Article",
        apiKey: "article",
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe("Article");
      expect(body.apiKey).toBe("article");
      expect(body.isBlock).toBe(false);
      expect(body.hasDraft).toBe(true);
      expect(body.id).toBeTruthy();

      // Verify the content table was created
      const tableCheck = db.get(
        sql.raw("SELECT name FROM sqlite_master WHERE type='table' AND name='content_article'")
      );
      expect(tableCheck).toBeDefined();
    });

    it("creates a block model and its block table", async () => {
      const res = await jsonRequest(app, "POST", "/api/models", {
        name: "Hero Section",
        apiKey: "hero_section",
        isBlock: true,
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.isBlock).toBe(true);

      const tableCheck = db.get(
        sql.raw("SELECT name FROM sqlite_master WHERE type='table' AND name='block_hero_section'")
      );
      expect(tableCheck).toBeDefined();
    });

    it("rejects duplicate apiKey", async () => {
      await jsonRequest(app, "POST", "/api/models", {
        name: "Article",
        apiKey: "article",
      });

      const res = await jsonRequest(app, "POST", "/api/models", {
        name: "Another Article",
        apiKey: "article",
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain("already exists");
    });

    it("rejects invalid apiKey format", async () => {
      const res = await jsonRequest(app, "POST", "/api/models", {
        name: "Bad",
        apiKey: "BadKey",
      });

      expect(res.status).toBe(400);
    });

    it("rejects missing name", async () => {
      const res = await jsonRequest(app, "POST", "/api/models", {
        apiKey: "test",
      });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/models", () => {
    it("returns empty list initially", async () => {
      const res = await app.request("/api/models");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([]);
    });

    it("returns all models", async () => {
      await jsonRequest(app, "POST", "/api/models", { name: "Article", apiKey: "article" });
      await jsonRequest(app, "POST", "/api/models", { name: "Author", apiKey: "author" });

      const res = await app.request("/api/models");
      const body = await res.json();
      expect(body).toHaveLength(2);
    });
  });

  describe("GET /api/models/:id", () => {
    it("returns a model with its fields", async () => {
      const createRes = await jsonRequest(app, "POST", "/api/models", {
        name: "Article",
        apiKey: "article",
      });
      const model = await createRes.json();

      const res = await app.request(`/api/models/${model.id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("Article");
      expect(body.fields).toEqual([]);
    });

    it("returns 404 for unknown id", async () => {
      const res = await app.request("/api/models/nonexistent");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /api/models/:id", () => {
    it("updates model properties", async () => {
      const createRes = await jsonRequest(app, "POST", "/api/models", {
        name: "Article",
        apiKey: "article",
      });
      const model = await createRes.json();

      const res = await jsonRequest(app, "PATCH", `/api/models/${model.id}`, {
        name: "Blog Post",
        singleton: true,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("Blog Post");
      expect(body.singleton).toBe(true);
    });
  });

  describe("DELETE /api/models/:id", () => {
    it("deletes a model and its table", async () => {
      const createRes = await jsonRequest(app, "POST", "/api/models", {
        name: "Article",
        apiKey: "article",
      });
      const model = await createRes.json();

      const res = await app.request(`/api/models/${model.id}`, { method: "DELETE" });
      expect(res.status).toBe(200);

      // Verify model is gone
      const getRes = await app.request(`/api/models/${model.id}`);
      expect(getRes.status).toBe(404);

      // Verify table is gone
      const tableCheck = db.get(
        sql.raw("SELECT name FROM sqlite_master WHERE type='table' AND name='content_article'")
      );
      expect(tableCheck).toBeUndefined();
    });

    it("returns 404 for unknown model", async () => {
      const res = await app.request("/api/models/nonexistent", { method: "DELETE" });
      expect(res.status).toBe(404);
    });

    it("refuses to delete a model referenced by link fields in other models", async () => {
      // Create two models
      const authorRes = await jsonRequest(app, "POST", "/api/models", {
        name: "Author",
        apiKey: "author",
      });
      const author = await authorRes.json();

      const postRes = await jsonRequest(app, "POST", "/api/models", {
        name: "Post",
        apiKey: "post",
      });
      const post = await postRes.json();

      // Add a link field on post pointing to author
      await jsonRequest(app, "POST", `/api/models/${post.id}/fields`, {
        label: "Author",
        apiKey: "post_author",
        fieldType: "link",
        validators: { item_item_type: ["author"] },
      });

      // Try to delete author — should be refused
      const deleteRes = await app.request(`/api/models/${author.id}`, { method: "DELETE" });
      expect(deleteRes.status).toBe(409);
      const body = await deleteRes.json();
      expect(body.error).toContain("referenced by");
      expect(body.error).toContain("post.post_author");
    });
  });
});
