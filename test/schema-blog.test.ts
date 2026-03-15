import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";
import type { Hono } from "hono";

/**
 * [SCHEMA:blog] — Blog schema integration test
 *
 * Models:
 * - author (singleton): name, bio, avatar (media)
 * - category: name, slug
 * - post: title, slug, body, excerpt, cover_image (media), author (link), category (link), published (boolean)
 */
describe("[SCHEMA:blog] Blog Schema Integration", () => {
  let app: Hono;
  let authorModelId: string;
  let categoryModelId: string;
  let postModelId: string;

  beforeEach(async () => {
    ({ app } = createTestApp());

    // --- Create models ---
    const authorRes = await jsonRequest(app, "POST", "/api/models", {
      name: "Author",
      apiKey: "author",
      singleton: true,
    });
    authorModelId = (await authorRes.json()).id;

    const categoryRes = await jsonRequest(app, "POST", "/api/models", {
      name: "Category",
      apiKey: "category",
    });
    categoryModelId = (await categoryRes.json()).id;

    const postRes = await jsonRequest(app, "POST", "/api/models", {
      name: "Post",
      apiKey: "post",
    });
    postModelId = (await postRes.json()).id;

    // --- Create fields ---

    // Author fields
    await jsonRequest(app, "POST", `/api/models/${authorModelId}/fields`, {
      label: "Name", apiKey: "name", fieldType: "string",
      validators: { required: true },
    });
    await jsonRequest(app, "POST", `/api/models/${authorModelId}/fields`, {
      label: "Bio", apiKey: "bio", fieldType: "text",
    });
    await jsonRequest(app, "POST", `/api/models/${authorModelId}/fields`, {
      label: "Avatar", apiKey: "avatar", fieldType: "media",
    });

    // Category fields
    await jsonRequest(app, "POST", `/api/models/${categoryModelId}/fields`, {
      label: "Name", apiKey: "name", fieldType: "string",
      validators: { required: true },
    });
    await jsonRequest(app, "POST", `/api/models/${categoryModelId}/fields`, {
      label: "Slug", apiKey: "slug", fieldType: "slug",
      validators: { slug_source: "name" },
    });

    // Post fields
    await jsonRequest(app, "POST", `/api/models/${postModelId}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
      validators: { required: true },
    });
    await jsonRequest(app, "POST", `/api/models/${postModelId}/fields`, {
      label: "Slug", apiKey: "slug", fieldType: "slug",
      validators: { slug_source: "title" },
    });
    await jsonRequest(app, "POST", `/api/models/${postModelId}/fields`, {
      label: "Body", apiKey: "body", fieldType: "text",
    });
    await jsonRequest(app, "POST", `/api/models/${postModelId}/fields`, {
      label: "Excerpt", apiKey: "excerpt", fieldType: "text",
    });
    await jsonRequest(app, "POST", `/api/models/${postModelId}/fields`, {
      label: "Cover Image", apiKey: "cover_image", fieldType: "media",
    });
    await jsonRequest(app, "POST", `/api/models/${postModelId}/fields`, {
      label: "Author", apiKey: "author", fieldType: "link",
      validators: { item_item_type: ["author"] },
    });
    await jsonRequest(app, "POST", `/api/models/${postModelId}/fields`, {
      label: "Category", apiKey: "category", fieldType: "link",
      validators: { item_item_type: ["category"] },
    });
    await jsonRequest(app, "POST", `/api/models/${postModelId}/fields`, {
      label: "Published", apiKey: "published", fieldType: "boolean",
    });
  });

  it("creates the full blog schema via REST", async () => {
    const modelsRes = await app.request("/api/models");
    const models = await modelsRes.json() as any[];
    expect(models).toHaveLength(3);
    expect(models.map((m: any) => m.apiKey).sort()).toEqual(["author", "category", "post"]);
  });

  it("creates sample content and queries via GraphQL", async () => {
    // Create author
    const authorRes = await jsonRequest(app, "POST", "/api/records", {
      modelApiKey: "author",
      data: { name: "Jokull Solberg", bio: "Icelandic developer and entrepreneur" },
    });
    const author = await authorRes.json();

    // Create categories
    const techRes = await jsonRequest(app, "POST", "/api/records", {
      modelApiKey: "category",
      data: { name: "Technology" },
    });
    const tech = await techRes.json();

    const travelRes = await jsonRequest(app, "POST", "/api/records", {
      modelApiKey: "category",
      data: { name: "Travel" },
    });
    const travel = await travelRes.json();

    // Create posts
    await jsonRequest(app, "POST", "/api/records", {
      modelApiKey: "post",
      data: {
        title: "Building an Agent-First CMS",
        body: "Let me tell you about agent-cms...",
        excerpt: "A headless CMS with no UI",
        author: author.id,
        category: tech.id,
        published: true,
      },
    });

    await jsonRequest(app, "POST", "/api/records", {
      modelApiKey: "post",
      data: {
        title: "Íslensku bloggfærslurnar",
        body: "Þetta er bloggfærsla á íslensku",
        excerpt: "Icelandic blog post with diacritics",
        author: author.id,
        category: travel.id,
        published: true,
      },
    });

    await jsonRequest(app, "POST", "/api/records", {
      modelApiKey: "post",
      data: {
        title: "Draft Post",
        body: "This is a draft",
        author: author.id,
        category: tech.id,
        published: false,
      },
    });

    // --- GraphQL queries ---

    // 1. Query all posts with linked author and category
    const allPosts = await gqlQuery(app, `{
      allPosts {
        title
        slug
        published
        author { name }
        category { name slug }
      }
    }`);

    expect(allPosts.errors).toBeUndefined();
    expect(allPosts.data.allPosts).toHaveLength(3);

    const cmsPost = allPosts.data.allPosts.find((p: any) => p.title === "Building an Agent-First CMS");
    expect(cmsPost.slug).toBe("building-an-agent-first-cms");
    expect(cmsPost.author.name).toBe("Jokull Solberg");
    expect(cmsPost.category.name).toBe("Technology");
    expect(cmsPost.category.slug).toBe("technology");

    // 2. Verify Icelandic slug generation
    const icelandicPost = allPosts.data.allPosts.find((p: any) => p.title === "Íslensku bloggfærslurnar");
    expect(icelandicPost.slug).toBe("islensku-bloggfaerslurnar");

    // 3. Filter published posts only
    const publishedPosts = await gqlQuery(app, `{
      allPosts(filter: { published: { eq: true } }) { title }
    }`);
    expect(publishedPosts.data.allPosts).toHaveLength(2);

    // 4. Order by title
    const orderedPosts = await gqlQuery(app, `{
      allPosts(orderBy: [title_ASC]) { title }
    }`);
    expect(orderedPosts.data.allPosts[0].title).toBe("Building an Agent-First CMS");

    // 5. Count with filter
    const meta = await gqlQuery(app, `{
      _allPostsMeta(filter: { published: { eq: true } }) { count }
    }`);
    expect(meta.data._allPostsMeta.count).toBe(2);

    // 6. Single post by ID — use filter instead of id arg for reliability
    const firstPost = allPosts.data.allPosts[0];
    const single = await gqlQuery(app, `{
      post(filter: { title: { eq: "Building an Agent-First CMS" } }) {
        title
        author { name bio }
      }
    }`);
    expect(single.data.post.title).toBe("Building an Agent-First CMS");
    expect(single.data.post.author.name).toBe("Jokull Solberg");

    // 7. Author singleton
    const authors = await gqlQuery(app, `{ allAuthors { name bio } }`);
    expect(authors.data.allAuthors).toHaveLength(1);
    expect(authors.data.allAuthors[0].name).toBe("Jokull Solberg");

    // 8. Categories
    const categories = await gqlQuery(app, `{
      allCategorys { name slug }
    }`);
    expect(categories.data.allCategorys).toHaveLength(2);
  });

  it("enforces author singleton constraint", async () => {
    await jsonRequest(app, "POST", "/api/records", {
      modelApiKey: "author",
      data: { name: "First Author" },
    });

    const secondRes = await jsonRequest(app, "POST", "/api/records", {
      modelApiKey: "author",
      data: { name: "Second Author" },
    });
    expect(secondRes.status).toBe(409);
  });

  it("validates required fields", async () => {
    const res = await jsonRequest(app, "POST", "/api/records", {
      modelApiKey: "post",
      data: { body: "Missing title" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("title");
  });

  it("refuses to delete author model (referenced by post)", async () => {
    const models = await (await app.request("/api/models")).json() as any[];
    const authorModel = models.find((m: any) => m.apiKey === "author");

    const res = await app.request(`/api/models/${authorModel.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("referenced");
  });
});
