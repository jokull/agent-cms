import { describe, it, expect, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "@effect/sql";
import { createTestApp, jsonRequest } from "./app-helpers.js";

/** Count rows in a table using the app's shared SQL layer. */
async function countRows(sqlLayer: Layer.Layer<SqlClient.SqlClient>, table: string): Promise<number> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.unsafe<{ c: number }>(`SELECT COUNT(*) as c FROM "${table}"`);
      return rows[0]?.c ?? 0;
    }).pipe(Effect.provide(sqlLayer)),
  );
}

describe("Validation dry-run + sync state", () => {
  let handler: (req: Request) => Promise<Response>;
  let sqlLayer: Layer.Layer<SqlClient.SqlClient>;
  let r1Id: string;
  let r2Id: string;

  beforeEach(async () => {
    ({ handler, sqlLayer } = createTestApp());

    // Block model used by the structured_text field's whitelist.
    const calloutRes = await jsonRequest(handler, "POST", "/api/models", { name: "Callout", apiKey: "callout", isBlock: true });
    const callout = await calloutRes.json();
    await jsonRequest(handler, "POST", `/api/models/${callout.id}/fields`, { label: "Text", apiKey: "text", fieldType: "string" });

    const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
    const model = await modelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, { label: "Title", apiKey: "title", fieldType: "string", validators: { required: true } });
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, { label: "Category", apiKey: "category", fieldType: "string", validators: { enum: ["news", "blog"] } });
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, { label: "Email", apiKey: "email", fieldType: "string", validators: { unique: true } });
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, { label: "Slug", apiKey: "slug", fieldType: "slug" });
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, { label: "Body", apiKey: "body", fieldType: "structured_text", validators: { structured_text_blocks: ["callout"] } });

    const r1 = await (await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: { title: "First", category: "news", email: "taken@example.com", slug: "taken" },
    })).json();
    r1Id = r1.id;
    const r2 = await (await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: { title: "Second", category: "blog", email: "other@example.com", slug: "second" },
    })).json();
    r2Id = r2.id;
  });

  describe("POST /api/records/validate (create-shaped)", () => {
    it("returns 400 with one coded issue per bad field and persists nothing", async () => {
      const before = await countRows(sqlLayer, "content_post");

      // title omitted (required), category not in enum, email collides (unique).
      const res = await jsonRequest(handler, "POST", "/api/records/validate", {
        modelApiKey: "post",
        data: { category: "invalid", email: "taken@example.com" },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(Array.isArray(body.issues)).toBe(true);
      expect(body.issues).toHaveLength(3);
      for (const issue of body.issues) {
        expect(typeof issue.field).toBe("string");
        expect(typeof issue.code).toBe("string");
      }
      const byField = Object.fromEntries(body.issues.map((i: { field: string; code: string }) => [i.field, i.code]));
      expect(byField.title).toBe("required");
      expect(byField.category).toBe("enum");
      expect(byField.email).toBe("unique");

      const after = await countRows(sqlLayer, "content_post");
      expect(after).toBe(before);
    });

    it("returns 204 for a valid payload and writes no record or block rows", async () => {
      const beforeRecords = await countRows(sqlLayer, "content_post");
      const beforeBlocks = await countRows(sqlLayer, "block_callout");

      const res = await jsonRequest(handler, "POST", "/api/records/validate", {
        modelApiKey: "post",
        data: {
          title: "Fresh",
          category: "news",
          email: "fresh@example.com",
          slug: "taken", // would collide — proves no slug is reserved / persisted
          body: {
            value: { schema: "dast", document: { type: "root", children: [{ type: "block", item: "b1" }] } },
            blocks: { b1: { _type: "callout", text: "Hello" } },
          },
        },
      });
      expect(res.status).toBe(204);

      expect(await countRows(sqlLayer, "content_post")).toBe(beforeRecords);
      expect(await countRows(sqlLayer, "block_callout")).toBe(beforeBlocks);
      expect(await countRows(sqlLayer, "block_callout")).toBe(0);
    });

    it("rejects a disallowed block type with a block_type code", async () => {
      const res = await jsonRequest(handler, "POST", "/api/records/validate", {
        modelApiKey: "post",
        data: {
          title: "Fresh",
          body: {
            value: { schema: "dast", document: { type: "root", children: [{ type: "block", item: "b1" }] } },
            blocks: { b1: { _type: "not_allowed", text: "Hi" } },
          },
        },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      const codes = body.issues.map((i: { code: string }) => i.code);
      expect(codes).toContain("block_type");
    });

    it("404s for an unknown model", async () => {
      const res = await jsonRequest(handler, "POST", "/api/records/validate", { modelApiKey: "nope", data: {} });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/records/:id/validate (patch-shaped)", () => {
    it("404s when the record does not exist", async () => {
      const res = await jsonRequest(handler, "POST", "/api/records/does-not-exist/validate", {
        modelApiKey: "post",
        data: { title: "x" },
      });
      expect(res.status).toBe(404);
    });

    it("only checks provided fields (absent required field is not flagged)", async () => {
      const res = await jsonRequest(handler, "POST", `/api/records/${r1Id}/validate`, {
        modelApiKey: "post",
        data: { category: "blog" },
      });
      expect(res.status).toBe(204);
    });

    it("excludes the record itself from the unique check", async () => {
      // R1 keeping its own email is valid.
      const selfRes = await jsonRequest(handler, "POST", `/api/records/${r1Id}/validate`, {
        modelApiKey: "post",
        data: { email: "taken@example.com" },
      });
      expect(selfRes.status).toBe(204);

      // R2 taking R1's email collides.
      const collideRes = await jsonRequest(handler, "POST", `/api/records/${r2Id}/validate`, {
        modelApiKey: "post",
        data: { email: "taken@example.com" },
      });
      expect(collideRes.status).toBe(400);
      const body = await collideRes.json();
      expect(body.issues.map((i: { code: string }) => i.code)).toContain("unique");
    });
  });

  describe("GET /api/records/:id/sync-state", () => {
    it("reports every meaningful field as changed for a never-published record", async () => {
      const res = await handler(new Request(`http://localhost/api/records/${r1Id}/sync-state?modelApiKey=post`));
      expect(res.status).toBe(200);
      const state = await res.json();
      expect(state.status).toBe("draft");
      expect(state.publishedAt).toBeNull();
      expect(state.scheduledPublishAt).toBeNull();
      expect(state.scheduledUnpublishAt).toBeNull();
      // R1 set title/category/email/slug.
      expect(state.changedFields.sort()).toEqual(["category", "email", "slug", "title"]);
    });

    it("lists only the edited field after publish-then-edit", async () => {
      const rec = await (await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post",
        data: { title: "Original", category: "news" },
      })).json();

      const pub = await jsonRequest(handler, "POST", `/api/records/${rec.id}/publish?modelApiKey=post`);
      expect(pub.status).toBe(200);

      await jsonRequest(handler, "PATCH", `/api/records/${rec.id}`, {
        modelApiKey: "post",
        data: { title: "Edited" },
      });

      const res = await handler(new Request(`http://localhost/api/records/${rec.id}/sync-state?modelApiKey=post`));
      const state = await res.json();
      expect(state.publishedAt).not.toBeNull();
      expect(state.firstPublishedAt).not.toBeNull();
      expect(state.changedFields).toEqual(["title"]);
    });

    it("surfaces scheduled publish/unpublish timestamps", async () => {
      const publishAt = "2099-01-01T00:00:00.000Z";
      const unpublishAt = "2099-06-01T00:00:00.000Z";
      await jsonRequest(handler, "POST", `/api/records/${r2Id}/schedule-publish`, { modelApiKey: "post", at: publishAt });
      await jsonRequest(handler, "POST", `/api/records/${r2Id}/schedule-unpublish`, { modelApiKey: "post", at: unpublishAt });

      const res = await handler(new Request(`http://localhost/api/records/${r2Id}/sync-state?modelApiKey=post`));
      const state = await res.json();
      expect(state.scheduledPublishAt).toBe(publishAt);
      expect(state.scheduledUnpublishAt).toBe(unpublishAt);
    });

    it("404s for a missing record", async () => {
      const res = await handler(new Request(`http://localhost/api/records/nope/sync-state?modelApiKey=post`));
      expect(res.status).toBe(404);
    });
  });
});
