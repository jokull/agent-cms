import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { createTestApp, jsonRequest } from "./app-helpers.js";
import type { Hono } from "hono";

describe("Fields REST API", () => {
  let app: Hono;
  let db: any;
  let modelId: string;

  beforeEach(async () => {
    ({ app, db } = createTestApp());
    // Create a model to add fields to
    const res = await jsonRequest(app, "POST", "/api/models", {
      name: "Article",
      apiKey: "article",
    });
    const model = await res.json();
    modelId = model.id;
  });

  describe("POST /api/models/:modelId/fields", () => {
    it("creates a string field and adds column to table", async () => {
      const res = await jsonRequest(app, "POST", `/api/models/${modelId}/fields`, {
        label: "Title",
        apiKey: "title",
        fieldType: "string",
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.label).toBe("Title");
      expect(body.apiKey).toBe("title");
      expect(body.fieldType).toBe("string");
      expect(body.localized).toBe(false);

      // Verify column was added to the dynamic table
      const cols = db.all(sql.raw('PRAGMA table_info("content_article")')) as any[];
      const colNames = cols.map((c: any) => c.name);
      expect(colNames).toContain("title");
    });

    it("creates multiple fields with auto-positioning", async () => {
      await jsonRequest(app, "POST", `/api/models/${modelId}/fields`, {
        label: "Title",
        apiKey: "title",
        fieldType: "string",
      });
      await jsonRequest(app, "POST", `/api/models/${modelId}/fields`, {
        label: "Body",
        apiKey: "body",
        fieldType: "text",
      });
      const res = await jsonRequest(app, "POST", `/api/models/${modelId}/fields`, {
        label: "Views",
        apiKey: "views",
        fieldType: "integer",
      });

      const body = await res.json();
      expect(body.position).toBe(2); // 0-indexed, third field
    });

    it("creates all v1 field types", async () => {
      const fieldTypes = [
        { label: "Title", apiKey: "title", fieldType: "string" },
        { label: "Body", apiKey: "body", fieldType: "text" },
        { label: "Published", apiKey: "published", fieldType: "boolean" },
        { label: "Views", apiKey: "views", fieldType: "integer" },
        { label: "Slug", apiKey: "slug", fieldType: "slug" },
        { label: "Cover", apiKey: "cover", fieldType: "media" },
        { label: "Photos", apiKey: "photos", fieldType: "media_gallery" },
        { label: "Author", apiKey: "author", fieldType: "link" },
        { label: "Tags", apiKey: "tags", fieldType: "links" },
        { label: "Content", apiKey: "content", fieldType: "structured_text" },
      ];

      for (const ft of fieldTypes) {
        const res = await jsonRequest(app, "POST", `/api/models/${modelId}/fields`, ft);
        expect(res.status).toBe(201);
      }

      // Verify all columns exist
      const cols = db.all(sql.raw('PRAGMA table_info("content_article")')) as any[];
      const colNames = cols.map((c: any) => c.name);
      for (const ft of fieldTypes) {
        expect(colNames).toContain(ft.apiKey);
      }
    });

    it("rejects duplicate apiKey on same model", async () => {
      await jsonRequest(app, "POST", `/api/models/${modelId}/fields`, {
        label: "Title",
        apiKey: "title",
        fieldType: "string",
      });

      const res = await jsonRequest(app, "POST", `/api/models/${modelId}/fields`, {
        label: "Another Title",
        apiKey: "title",
        fieldType: "text",
      });

      expect(res.status).toBe(409);
    });

    it("rejects invalid field type", async () => {
      const res = await jsonRequest(app, "POST", `/api/models/${modelId}/fields`, {
        label: "Bad",
        apiKey: "bad",
        fieldType: "nonexistent",
      });

      expect(res.status).toBe(400);
    });

    it("rejects invalid apiKey format", async () => {
      const res = await jsonRequest(app, "POST", `/api/models/${modelId}/fields`, {
        label: "Bad",
        apiKey: "BadKey",
        fieldType: "string",
      });

      expect(res.status).toBe(400);
    });

    it("returns 404 for nonexistent model", async () => {
      const res = await jsonRequest(app, "POST", "/api/models/nonexistent/fields", {
        label: "Title",
        apiKey: "title",
        fieldType: "string",
      });

      expect(res.status).toBe(404);
    });

    it("stores validators as JSON", async () => {
      const res = await jsonRequest(app, "POST", `/api/models/${modelId}/fields`, {
        label: "Title",
        apiKey: "title",
        fieldType: "string",
        validators: { required: true, length: { min: 1, max: 255 } },
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.validators).toEqual({ required: true, length: { min: 1, max: 255 } });
    });
  });

  describe("GET /api/models/:modelId/fields", () => {
    it("lists fields for a model", async () => {
      await jsonRequest(app, "POST", `/api/models/${modelId}/fields`, {
        label: "Title",
        apiKey: "title",
        fieldType: "string",
      });
      await jsonRequest(app, "POST", `/api/models/${modelId}/fields`, {
        label: "Body",
        apiKey: "body",
        fieldType: "text",
      });

      const res = await app.request(`/api/models/${modelId}/fields`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(2);
    });
  });

  describe("PATCH /api/models/:modelId/fields/:fieldId", () => {
    it("updates field properties", async () => {
      const createRes = await jsonRequest(app, "POST", `/api/models/${modelId}/fields`, {
        label: "Title",
        apiKey: "title",
        fieldType: "string",
      });
      const field = await createRes.json();

      const res = await jsonRequest(app, "PATCH", `/api/models/${modelId}/fields/${field.id}`, {
        label: "Post Title",
        hint: "Enter the title of the post",
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.label).toBe("Post Title");
      expect(body.hint).toBe("Enter the title of the post");
    });
  });

  describe("DELETE /api/models/:modelId/fields/:fieldId", () => {
    it("deletes a field and removes column from table", async () => {
      const createRes = await jsonRequest(app, "POST", `/api/models/${modelId}/fields`, {
        label: "Title",
        apiKey: "title",
        fieldType: "string",
      });
      const field = await createRes.json();

      // Also add another field so we can verify title is gone but body remains
      await jsonRequest(app, "POST", `/api/models/${modelId}/fields`, {
        label: "Body",
        apiKey: "body",
        fieldType: "text",
      });

      const res = await app.request(`/api/models/${modelId}/fields/${field.id}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);

      // Verify column is gone
      const cols = db.all(sql.raw('PRAGMA table_info("content_article")')) as any[];
      const colNames = cols.map((c: any) => c.name);
      expect(colNames).not.toContain("title");
      expect(colNames).toContain("body");
    });
  });
});
