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
      expect(body.references).toEqual(["post.post_author"]);
    });
  });

  describe("titleField / imagePreviewField presentation hints", () => {
    async function createModelWithFields() {
      const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Article", apiKey: "article" });
      const model = await modelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Cover", apiKey: "cover", fieldType: "media",
      });
      return model;
    }

    it("rejects non-null hints at model creation time (fields don't exist yet)", async () => {
      const res = await jsonRequest(handler, "POST", "/api/models", {
        name: "Article", apiKey: "article", titleField: "title",
      });
      expect(res.status).toBe(400);
    });

    it("allows null hints at model creation time", async () => {
      const res = await jsonRequest(handler, "POST", "/api/models", {
        name: "Article", apiKey: "article", titleField: null, imagePreviewField: null,
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.titleField).toBeNull();
      expect(body.imagePreviewField).toBeNull();
    });

    it("sets hints via PATCH and reads them back", async () => {
      const model = await createModelWithFields();

      const patchRes = await jsonRequest(handler, "PATCH", `/api/models/${model.id}`, {
        titleField: "title",
        imagePreviewField: "cover",
      });
      expect(patchRes.status).toBe(200);
      const patched = await patchRes.json();
      expect(patched.titleField).toBe("title");
      expect(patched.imagePreviewField).toBe("cover");

      const getRes = await handler(new Request(`http://localhost/api/models/${model.id}`));
      const fetched = await getRes.json();
      expect(fetched.titleField).toBe("title");
      expect(fetched.imagePreviewField).toBe("cover");
    });

    it("rejects titleField referencing a nonexistent field api_key", async () => {
      const model = await createModelWithFields();
      const res = await jsonRequest(handler, "PATCH", `/api/models/${model.id}`, {
        titleField: "does_not_exist",
      });
      expect(res.status).toBe(400);
    });

    it("rejects imagePreviewField referencing a non-media field", async () => {
      const model = await createModelWithFields();
      const res = await jsonRequest(handler, "PATCH", `/api/models/${model.id}`, {
        imagePreviewField: "title",
      });
      expect(res.status).toBe(400);
    });

    it("allows clearing hints with null", async () => {
      const model = await createModelWithFields();
      await jsonRequest(handler, "PATCH", `/api/models/${model.id}`, {
        titleField: "title", imagePreviewField: "cover",
      });

      const clearRes = await jsonRequest(handler, "PATCH", `/api/models/${model.id}`, {
        titleField: null, imagePreviewField: null,
      });
      expect(clearRes.status).toBe(200);
      const cleared = await clearRes.json();
      expect(cleared.titleField).toBeNull();
      expect(cleared.imagePreviewField).toBeNull();
    });

    it("clears the hint when the referenced field is deleted", async () => {
      const model = await createModelWithFields();
      await jsonRequest(handler, "PATCH", `/api/models/${model.id}`, {
        titleField: "title", imagePreviewField: "cover",
      });

      const fieldsRes = await handler(new Request(`http://localhost/api/models/${model.id}/fields`));
      const fields = await fieldsRes.json();
      const coverField = fields.find((f: { api_key: string }) => f.api_key === "cover");

      const delRes = await handler(
        new Request(`http://localhost/api/models/${model.id}/fields/${coverField.id}`, { method: "DELETE" })
      );
      expect(delRes.status).toBe(200);

      const getRes = await handler(new Request(`http://localhost/api/models/${model.id}`));
      const fetched = await getRes.json();
      expect(fetched.imagePreviewField).toBeNull();
      expect(fetched.titleField).toBe("title");
    });
  });
});
