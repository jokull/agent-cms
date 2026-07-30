import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest } from "./app-helpers.js";

// Workstream C: errorToResponse enriches error bodies additively.
// { error } always present; field/references/entity+id appear only when the
// underlying error carries that detail.
describe("REST error response shape", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(() => {
    ({ handler } = createTestApp());
  });

  it("400 field-level validation errors carry { error, issues } with an honest single-element array", async () => {
    const modelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Page",
      apiKey: "page",
      hasDraft: false,
    });
    const model = await modelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Title",
      apiKey: "title",
      fieldType: "string",
      validators: { required: true },
    });

    const res = await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "page", data: {} });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    // Aggregated path: a single bad field still yields an issues array of one.
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0].field).toBe("title");
  });

  it("409 reference conflicts carry { error, references }", async () => {
    const authorRes = await jsonRequest(handler, "POST", "/api/models", { name: "Author", apiKey: "author" });
    const author = await authorRes.json();
    const postRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
    const post = await postRes.json();

    await jsonRequest(handler, "POST", `/api/models/${post.id}/fields`, {
      label: "Author",
      apiKey: "post_author",
      fieldType: "link",
      validators: { item_item_type: ["author"] },
    });

    const res = await handler(new Request(`http://localhost/api/models/${author.id}`, { method: "DELETE" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.references).toEqual(["post.post_author"]);
  });

  it("404s carry { error, entity, id }", async () => {
    const res = await handler(new Request("http://localhost/api/models/nonexistent"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.entity).toBe("Model");
    expect(body.id).toBe("nonexistent");
  });

  it("errors without field detail still return plain { error } with no field key", async () => {
    const res = await jsonRequest(handler, "POST", "/api/models", { name: "Bad", apiKey: "BadKey" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect("field" in body).toBe(false);
  });
});
