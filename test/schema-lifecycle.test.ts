import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { createTestApp, jsonRequest } from "./app-helpers.js";

describe("Schema Lifecycle", () => {
  let handler: (req: Request) => Promise<Response>;
  let sqlLayer: any;

  beforeEach(() => {
    ({ handler, sqlLayer } = createTestApp());
  });

  describe("P4.1: Field type change rejection", () => {
    it("rejects field type change when records have data", async () => {
      // Create model + field
      const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
      const model = await modelRes.json();
      const fieldRes = await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });
      const field = await fieldRes.json();

      // Insert a record with data
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post", data: { title: "Hello" },
      });

      // Try to change field type — should fail
      const res = await jsonRequest(handler, "PATCH", `/api/models/${model.id}/fields/${field.id}`, {
        fieldType: "integer",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Cannot change field type");
      expect(body.error).toContain("has data");
    });

    it("allows field type change when field has no data", async () => {
      const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
      const model = await modelRes.json();
      const fieldRes = await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Count", apiKey: "count", fieldType: "string",
      });
      const field = await fieldRes.json();

      // No records inserted — field has no data
      const res = await jsonRequest(handler, "PATCH", `/api/models/${model.id}/fields/${field.id}`, {
        fieldType: "integer",
      });
      // Should succeed (no data to conflict)
      expect(res.status).toBe(200);
    });

    it("allows field type change when records exist but field is null", async () => {
      const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
      const model = await modelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });
      const fieldRes = await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Subtitle", apiKey: "subtitle", fieldType: "string",
      });
      const field = await fieldRes.json();

      // Insert record with title but no subtitle
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post", data: { title: "Hello" },
      });

      // subtitle is NULL in the record — type change should be allowed
      const res = await jsonRequest(handler, "PATCH", `/api/models/${model.id}/fields/${field.id}`, {
        fieldType: "integer",
      });
      expect(res.status).toBe(200);
    });

    it("allows non-type updates even when field has data", async () => {
      const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
      const model = await modelRes.json();
      const fieldRes = await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });
      const field = await fieldRes.json();

      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post", data: { title: "Hello" },
      });

      // Changing label/hint/validators is fine even with data
      const res = await jsonRequest(handler, "PATCH", `/api/models/${model.id}/fields/${field.id}`, {
        label: "Post Title",
        hint: "Enter the post title",
      });
      expect(res.status).toBe(200);
      const updated = await res.json();
      expect(updated.label).toBe("Post Title");
      expect(updated.hint).toBe("Enter the post title");
    });
  });

  describe("P4.2: Required field with existing records", () => {
    it("rejects adding required field without default_value when records exist", async () => {
      const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
      const model = await modelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });

      // Insert a record
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post", data: { title: "Existing Post" },
      });

      // Try adding a required field without default — should fail
      const res = await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Category", apiKey: "category", fieldType: "string",
        validators: { required: true },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("default_value");
      expect(body.error).toContain("existing record");
    });

    it("allows adding required field with default_value and populates records", async () => {
      ({ handler, sqlLayer } = createTestApp());
      const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
      const model = await modelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });

      // Insert records
      await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "Post 1" } });
      await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "Post 2" } });

      // Add required field WITH default value
      const res = await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Status", apiKey: "status", fieldType: "string",
        validators: { required: true },
        defaultValue: "active",
      });
      expect(res.status).toBe(201);

      // Verify existing records got the default
      const records = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql.unsafe<{ status: string }>('SELECT status FROM "content_post"');
        }).pipe(Effect.provide(sqlLayer))
      );
      expect(records).toHaveLength(2);
      expect(records[0].status).toBe("active");
      expect(records[1].status).toBe("active");
    });

    it("allows adding required field to empty model without default", async () => {
      const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
      const model = await modelRes.json();

      // No records — should be fine even without default
      const res = await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
        validators: { required: true },
      });
      expect(res.status).toBe(201);
    });

    it("allows adding non-required field to model with records", async () => {
      const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
      const model = await modelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });
      await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "Post" } });

      // Adding non-required field is always fine
      const res = await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Subtitle", apiKey: "subtitle", fieldType: "string",
      });
      expect(res.status).toBe(201);
    });
  });
});
