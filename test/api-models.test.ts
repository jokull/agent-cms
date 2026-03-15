import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest } from "./app-helpers.js";

describe("Models REST API", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(() => {
    ({ handler } = createTestApp());
  });

  describe("POST /api/models", () => {
    it("creates a model and its content table", async () => {
      const res = await jsonRequest(handler, "POST", "/api/models", {
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
    });

    it("creates a block model", async () => {
      const res = await jsonRequest(handler, "POST", "/api/models", {
        name: "Hero Section",
        apiKey: "hero_section",
        isBlock: true,
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.isBlock).toBe(true);
    });

    it("rejects duplicate apiKey", async () => {
      await jsonRequest(handler, "POST", "/api/models", { name: "Article", apiKey: "article" });
      const res = await jsonRequest(handler, "POST", "/api/models", { name: "Another", apiKey: "article" });
      expect(res.status).toBe(409);
    });

    it("rejects invalid apiKey format", async () => {
      const res = await jsonRequest(handler, "POST", "/api/models", { name: "Bad", apiKey: "BadKey" });
      expect(res.status).toBe(400);
    });

    it("rejects missing name", async () => {
      const res = await jsonRequest(handler, "POST", "/api/models", { apiKey: "test" });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/models", () => {
    it("returns empty list initially", async () => {
      const res = await handler(new Request("http://localhost/api/models"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([]);
    });

    it("returns all models", async () => {
      await jsonRequest(handler, "POST", "/api/models", { name: "Article", apiKey: "article" });
      await jsonRequest(handler, "POST", "/api/models", { name: "Author", apiKey: "author" });

      const res = await handler(new Request("http://localhost/api/models"));
      const body = await res.json();
      expect(body).toHaveLength(2);
    });
  });

  describe("GET /api/models/:id", () => {
    it("returns a model with its fields", async () => {
      const createRes = await jsonRequest(handler, "POST", "/api/models", { name: "Article", apiKey: "article" });
      const model = await createRes.json();

      const res = await handler(new Request(`http://localhost/api/models/${model.id}`));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("Article");
      expect(body.fields).toEqual([]);
    });

    it("returns 404 for unknown id", async () => {
      const res = await handler(new Request("http://localhost/api/models/nonexistent"));
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/models/:id", () => {
    it("deletes a model", async () => {
      const createRes = await jsonRequest(handler, "POST", "/api/models", { name: "Article", apiKey: "article" });
      const model = await createRes.json();

      const res = await handler(new Request(`http://localhost/api/models/${model.id}`, { method: "DELETE" }));
      expect(res.status).toBe(200);

      const getRes = await handler(new Request(`http://localhost/api/models/${model.id}`));
      expect(getRes.status).toBe(404);
    });

    it("refuses to delete a model referenced by link fields", async () => {
      const authorRes = await jsonRequest(handler, "POST", "/api/models", { name: "Author", apiKey: "author" });
      const author = await authorRes.json();
      const postRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
      const post = await postRes.json();

      await jsonRequest(handler, "POST", `/api/models/${post.id}/fields`, {
        label: "Author", apiKey: "post_author", fieldType: "link",
        validators: { item_item_type: ["author"] },
      });

      const deleteRes = await handler(new Request(`http://localhost/api/models/${author.id}`, { method: "DELETE" }));
      expect(deleteRes.status).toBe(409);
      const body = await deleteRes.json();
      expect(body.error).toContain("referenced");
    });
  });
});
