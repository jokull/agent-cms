import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest } from "./app-helpers.js";

describe("Schema Lifecycle", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(() => {
    ({ handler } = createTestApp());
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
});
