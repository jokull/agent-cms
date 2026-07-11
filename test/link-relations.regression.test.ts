import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

// Regression: a link/links validator that references the target model by ID
// (DatoCMS-style `items_item_type: [<modelId>]`) used to fall back to a scalar
// `JSON` GraphQL field — the relation was unreadable ({ tags { name } } errored)
// AND create_record reference validation false-negatived valid linked records.
// Both are fixed by normalizing link targets (id -> api_key) on create_field.
describe("link/links relations by model ID", () => {
  let handler: (req: Request) => Promise<Response>;
  beforeEach(() => {
    ({ handler } = createTestApp());
  });

  it("resolves a nested `links` relation and validates real linked records", async () => {
    const tag = await (
      await jsonRequest(handler, "POST", "/api/models", { name: "Tag", apiKey: "tag" })
    ).json();
    await jsonRequest(handler, "POST", `/api/models/${tag.id}/fields`, {
      label: "Name",
      apiKey: "name",
      fieldType: "string",
    });

    const post = await (
      await jsonRequest(handler, "POST", "/api/models", { name: "BlogPost", apiKey: "blog_post" })
    ).json();
    await jsonRequest(handler, "POST", `/api/models/${post.id}/fields`, {
      label: "Title",
      apiKey: "title",
      fieldType: "string",
    });
    // The target is given by MODEL ID — the case that used to break.
    const fieldRes = await jsonRequest(handler, "POST", `/api/models/${post.id}/fields`, {
      label: "Tags",
      apiKey: "tags",
      fieldType: "links",
      validators: { items_item_type: [tag.id] },
    });
    expect(fieldRes.status).toBe(201);
    // Stored validator is normalized to the api_key.
    const field = await fieldRes.json();
    expect(field.validators.items_item_type).toEqual(["tag"]);

    const t1 = await (
      await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "tag", data: { name: "alpha" } })
    ).json();
    const t2 = await (
      await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "tag", data: { name: "beta" } })
    ).json();

    // H3: linking valid, existing records must PASS (no skipReferenceValidation).
    const created = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "blog_post",
      data: { title: "Hello", tags: [t1.id, t2.id] },
    });
    expect(created.status).toBe(201);

    // H2: the relation resolves nested, not as scalar JSON.
    const q = await gqlQuery(handler, `{ allBlogPosts { title tags { name } } }`);
    expect(q.errors).toBeUndefined();
    const p = q.data.allBlogPosts[0];
    expect(p.title).toBe("Hello");
    expect(p.tags.map((x: { name: string }) => x.name).sort()).toEqual(["alpha", "beta"]);
  });
});
