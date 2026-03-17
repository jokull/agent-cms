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

  describe("P4.3: Model/field rename", () => {
    it("renames a model api_key and its table", async () => {
      const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
      const model = await modelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });
      await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "Hello" } });

      // Rename model
      const renameRes = await jsonRequest(handler, "PATCH", `/api/models/${model.id}`, { apiKey: "article" });
      expect(renameRes.status).toBe(200);
      const renamed = await renameRes.json();
      expect(renamed.api_key).toBe("article");

      // Old model name should not work, new one should
      const oldRes = await handler(new Request("http://localhost/api/records?modelApiKey=post"));
      expect(oldRes.status).toBe(404);

      const newRes = await handler(new Request("http://localhost/api/records?modelApiKey=article"));
      expect(newRes.status).toBe(200);
      const records = await newRes.json();
      expect(records).toHaveLength(1);
      expect(records[0].title).toBe("Hello");
    });

    it("renames a field api_key and its column", async () => {
      const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
      const model = await modelRes.json();
      const fieldRes = await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });
      const field = await fieldRes.json();
      await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "Hello" } });

      // Rename field
      const renameRes = await jsonRequest(handler, "PATCH", `/api/models/${model.id}/fields/${field.id}`, {
        apiKey: "headline",
      });
      expect(renameRes.status).toBe(200);
      const renamed = await renameRes.json();
      expect(renamed.api_key).toBe("headline");

      // Data should still be accessible under new column name
      const records = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql.unsafe<Record<string, any>>('SELECT * FROM "content_post"');
        }).pipe(Effect.provide(sqlLayer))
      );
      expect(records[0].headline).toBe("Hello");
    });

    it("rejects rename to duplicate api_key", async () => {
      const m1Res = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
      await jsonRequest(handler, "POST", "/api/models", { name: "Article", apiKey: "article" });
      const m1 = await m1Res.json();

      const res = await jsonRequest(handler, "PATCH", `/api/models/${m1.id}`, { apiKey: "article" });
      expect(res.status).toBe(409);
    });

    it("updates link field validators when model is renamed", async () => {
      const authorRes = await jsonRequest(handler, "POST", "/api/models", { name: "Author", apiKey: "author" });
      const author = await authorRes.json();
      const postRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
      const post = await postRes.json();
      await jsonRequest(handler, "POST", `/api/models/${post.id}/fields`, {
        label: "Author", apiKey: "author_link", fieldType: "link",
        validators: { item_item_type: ["author"] },
      });

      // Rename author → writer
      await jsonRequest(handler, "PATCH", `/api/models/${author.id}`, { apiKey: "writer" });

      // Check that the post's link field validator was updated
      const postDetail = await (await handler(new Request(`http://localhost/api/models/${post.id}`))).json();
      const linkField = postDetail.fields.find((f: any) => f.api_key === "author_link");
      expect(linkField.validators.item_item_type).toEqual(["writer"]);
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

    it("preserves falsy boolean default_value metadata and populates existing records", async () => {
      ({ handler, sqlLayer } = createTestApp());
      const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Flag", apiKey: "flag" });
      const model = await modelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });
      await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "flag", data: { title: "One" } });

      const res = await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Enabled", apiKey: "enabled", fieldType: "boolean",
        validators: { required: true },
        defaultValue: false,
      });
      expect(res.status).toBe(201);
      const field = await res.json();
      expect(field.defaultValue).toBe(false);

      const records = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql.unsafe<{ enabled: number }>('SELECT enabled FROM "content_flag"');
          const fields = yield* sql.unsafe<{ default_value: string | null }>(
            "SELECT default_value FROM fields WHERE model_id = ? AND api_key = ?",
            [model.id, "enabled"]
          );
          return { rows, field: fields[0] };
        }).pipe(Effect.provide(sqlLayer))
      );
      expect(records.rows[0].enabled).toBe(0);
      expect(records.field.default_value).toBe("false");
    });

    it("preserves zero default_value metadata and populates existing records", async () => {
      ({ handler, sqlLayer } = createTestApp());
      const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Counter", apiKey: "counter" });
      const model = await modelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });
      await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "counter", data: { title: "One" } });

      const res = await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Count", apiKey: "count", fieldType: "integer",
        validators: { required: true },
        defaultValue: 0,
      });
      expect(res.status).toBe(201);
      const field = await res.json();
      expect(field.defaultValue).toBe(0);

      const records = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql.unsafe<{ count: number }>('SELECT count FROM "content_counter"');
          const fields = yield* sql.unsafe<{ default_value: string | null }>(
            "SELECT default_value FROM fields WHERE model_id = ? AND api_key = ?",
            [model.id, "count"]
          );
          return { rows, field: fields[0] };
        }).pipe(Effect.provide(sqlLayer))
      );
      expect(records.rows[0].count).toBe(0);
      expect(records.field.default_value).toBe("0");
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
