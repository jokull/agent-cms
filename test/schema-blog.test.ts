import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("[SCHEMA:blog] Blog Schema Integration", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    ({ handler } = createTestApp());

    // Create models
    const authorRes = await jsonRequest(handler, "POST", "/api/models", { name: "Author", apiKey: "author", singleton: true });
    const authorModel = (await authorRes.json());
    const categoryRes = await jsonRequest(handler, "POST", "/api/models", { name: "Category", apiKey: "category" });
    const categoryModel = (await categoryRes.json());
    const postRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
    const postModel = (await postRes.json());

    // Author fields
    await jsonRequest(handler, "POST", `/api/models/${authorModel.id}/fields`, { label: "Name", apiKey: "name", fieldType: "string", validators: { required: true } });
    await jsonRequest(handler, "POST", `/api/models/${authorModel.id}/fields`, { label: "Bio", apiKey: "bio", fieldType: "text" });

    // Category fields
    await jsonRequest(handler, "POST", `/api/models/${categoryModel.id}/fields`, { label: "Name", apiKey: "name", fieldType: "string", validators: { required: true } });
    await jsonRequest(handler, "POST", `/api/models/${categoryModel.id}/fields`, { label: "Slug", apiKey: "slug", fieldType: "slug", validators: { slug_source: "name" } });

    // Post fields
    await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, { label: "Title", apiKey: "title", fieldType: "string", validators: { required: true } });
    await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, { label: "Slug", apiKey: "slug", fieldType: "slug", validators: { slug_source: "title" } });
    await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, { label: "Body", apiKey: "body", fieldType: "text" });
    await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, { label: "Excerpt", apiKey: "excerpt", fieldType: "text" });
    await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, { label: "Author", apiKey: "author", fieldType: "link", validators: { item_item_type: ["author"] } });
    await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, { label: "Category", apiKey: "category", fieldType: "link", validators: { item_item_type: ["category"] } });
    await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, { label: "Published", apiKey: "published", fieldType: "boolean" });
  });

  it("creates the full blog schema", async () => {
    const models = await (await handler(new Request("http://localhost/api/models"))).json() as any[];
    expect(models).toHaveLength(3);
  });

  it("creates content and queries via GraphQL", async () => {
    const author = await (await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "author", data: { name: "Jokull Solberg", bio: "Icelandic developer" } })).json();
    const tech = await (await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "category", data: { name: "Technology" } })).json();
    const travel = await (await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "category", data: { name: "Travel" } })).json();

    await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "Building an Agent-First CMS", body: "About agent-cms...", excerpt: "A headless CMS", author: author.id, category: tech.id, published: true } });
    await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "Íslensku bloggfærslurnar", body: "Þetta er bloggfærsla", excerpt: "Icelandic post", author: author.id, category: travel.id, published: true } });
    await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "Draft Post", body: "Draft", author: author.id, category: tech.id, published: false } });

    // Query with links
    const allPosts = await gqlQuery(handler, `{ allPosts { title slug published author { name } category { name slug } } }`);
    expect(allPosts.errors).toBeUndefined();
    expect(allPosts.data.allPosts).toHaveLength(3);

    const cmsPost = allPosts.data.allPosts.find((p: any) => p.title === "Building an Agent-First CMS");
    expect(cmsPost.slug).toBe("building-an-agent-first-cms");
    expect(cmsPost.author.name).toBe("Jokull Solberg");
    expect(cmsPost.category.slug).toBe("technology");

    // Icelandic slug
    const isPost = allPosts.data.allPosts.find((p: any) => p.title === "Íslensku bloggfærslurnar");
    expect(isPost.slug).toBe("islensku-bloggfaerslurnar");

    // Filter published
    const published = await gqlQuery(handler, `{ allPosts(filter: { published: { eq: true } }) { title } }`);
    expect(published.data.allPosts).toHaveLength(2);

    // Meta count
    const meta = await gqlQuery(handler, `{ _allPostsMeta(filter: { published: { eq: true } }) { count } }`);
    expect(meta.data._allPostsMeta.count).toBe(2);

    // Single record by filter
    const single = await gqlQuery(handler, `{ post(filter: { title: { eq: "Building an Agent-First CMS" } }) { title author { name bio } } }`);
    expect(single.data.post.author.name).toBe("Jokull Solberg");
  });

  it("enforces singleton", async () => {
    await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "author", data: { name: "First" } });
    const res = await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "author", data: { name: "Second" } });
    expect(res.status).toBe(409);
  });

  it("validates required fields", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { body: "Missing title" } });
    expect(res.status).toBe(400);
  });

  it("refuses to delete referenced model", async () => {
    const models = await (await handler(new Request("http://localhost/api/models"))).json() as any[];
    const authorModel = models.find((m: any) => m.api_key === "author");
    const res = await handler(new Request(`http://localhost/api/models/${authorModel.id}`, { method: "DELETE" }));
    expect(res.status).toBe(409);
  });
});
