import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { createTestApp, jsonRequest } from "./app-helpers.js";

describe("Fields REST API", () => {
  let handler: (req: Request) => Promise<Response>;
  let sqlLayer: any;
  let modelId: string;

  beforeEach(async () => {
    ({ handler, sqlLayer } = createTestApp());
    const res = await jsonRequest(handler, "POST", "/api/models", { name: "Article", apiKey: "article" });
    const model = await res.json();
    modelId = model.id;
  });

  describe("POST /api/models/:modelId/fields", () => {
    it("creates a string field and adds column to table", async () => {
      const res = await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.label).toBe("Title");
      expect(body.fieldType).toBe("string");

      // Verify column exists via @effect/sql
      const cols = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql.unsafe<{ name: string }>('PRAGMA table_info("content_article")');
        }).pipe(Effect.provide(sqlLayer))
      );
      expect(cols.map((c) => c.name)).toContain("title");
    });

    it("creates all v1 field types", async () => {
      const types = ["string", "text", "boolean", "integer", "slug", "media", "media_gallery", "link", "links", "structured_text"];
      for (const ft of types) {
        const res = await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
          label: ft, apiKey: `field_${ft}`, fieldType: ft,
        });
        expect(res.status).toBe(201);
      }
    });

    it("rejects duplicate apiKey", async () => {
      await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, { label: "Title", apiKey: "title", fieldType: "string" });
      const res = await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, { label: "Title2", apiKey: "title", fieldType: "text" });
      expect(res.status).toBe(409);
    });

    it("rejects invalid field type", async () => {
      const res = await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, { label: "Bad", apiKey: "bad", fieldType: "nonexistent" });
      expect(res.status).toBe(400);
    });

    it("stores validators as JSON", async () => {
      const res = await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
        validators: { required: true, length: { min: 1, max: 255 } },
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.validators).toEqual({ required: true, length: { min: 1, max: 255 } });
    });
  });

  describe("GET /api/models/:modelId/fields", () => {
    it("lists fields for a model", async () => {
      await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, { label: "Title", apiKey: "title", fieldType: "string" });
      await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, { label: "Body", apiKey: "body", fieldType: "text" });
      const res = await handler(new Request(`http://localhost/api/models/${modelId}/fields`));
      const body = await res.json();
      expect(body).toHaveLength(2);
    });
  });

  describe("DELETE /api/models/:modelId/fields/:fieldId", () => {
    it("deletes a field and removes column", async () => {
      const createRes = await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, { label: "Title", apiKey: "title", fieldType: "string" });
      const field = await createRes.json();
      await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, { label: "Body", apiKey: "body", fieldType: "text" });

      const res = await handler(new Request(`http://localhost/api/models/${modelId}/fields/${field.id}`, { method: "DELETE" }));
      expect(res.status).toBe(200);

      const cols = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql.unsafe<{ name: string }>('PRAGMA table_info("content_article")');
        }).pipe(Effect.provide(sqlLayer))
      );
      expect(cols.map((c) => c.name)).not.toContain("title");
      expect(cols.map((c) => c.name)).toContain("body");
    });
  });
});
