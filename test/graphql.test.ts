import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";
import type { Hono } from "hono";

describe("GraphQL Content Delivery API", () => {
  let app: Hono;

  beforeEach(async () => {
    ({ app } = createTestApp());

    // Create a model with fields
    const modelRes = await jsonRequest(app, "POST", "/api/models", {
      name: "Post",
      apiKey: "post",
    });
    const model = await modelRes.json();

    await jsonRequest(app, "POST", `/api/models/${model.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    await jsonRequest(app, "POST", `/api/models/${model.id}/fields`, {
      label: "Body", apiKey: "body", fieldType: "text",
    });
    await jsonRequest(app, "POST", `/api/models/${model.id}/fields`, {
      label: "Views", apiKey: "views", fieldType: "integer",
    });
    await jsonRequest(app, "POST", `/api/models/${model.id}/fields`, {
      label: "Published", apiKey: "published", fieldType: "boolean",
    });

    // Insert some records
    await jsonRequest(app, "POST", "/api/records", {
      modelApiKey: "post",
      data: { title: "First Post", body: "Hello world", views: 100, published: true },
    });
    await jsonRequest(app, "POST", "/api/records", {
      modelApiKey: "post",
      data: { title: "Second Post", body: "Another post", views: 50, published: false },
    });
  });

  it("queries all records for a model", async () => {
    const result = await gqlQuery(app, `{
      allPosts {
        id
        title
        body
        views
        published
        _status
        _createdAt
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data.allPosts).toHaveLength(2);
    expect(result.data.allPosts[0].title).toBe("First Post");
    expect(result.data.allPosts[0].views).toBe(100);
    expect(result.data.allPosts[0].published).toBe(true);
    expect(result.data.allPosts[0]._status).toBe("draft");
  });

  it("queries a single record by ID", async () => {
    // First get all to find an ID
    const listResult = await gqlQuery(app, `{ allPosts { id title } }`);
    const postId = listResult.data.allPosts[0].id;

    const result = await gqlQuery(app, `{
      post(id: "${postId}") {
        id
        title
        body
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data.post.title).toBe("First Post");
    expect(result.data.post.body).toBe("Hello world");
  });

  it("returns null for unknown ID", async () => {
    const result = await gqlQuery(app, `{
      post(id: "nonexistent") {
        id
        title
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data.post).toBeNull();
  });

  it("supports pagination with first and skip", async () => {
    const result = await gqlQuery(app, `{
      allPosts(first: 1, skip: 1) {
        title
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data.allPosts).toHaveLength(1);
    expect(result.data.allPosts[0].title).toBe("Second Post");
  });

  it("returns meta with count", async () => {
    const result = await gqlQuery(app, `{
      _allPostsMeta {
        count
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data._allPostsMeta.count).toBe(2);
  });

  it("handles multiple models", async () => {
    // Create an author model
    const authorRes = await jsonRequest(app, "POST", "/api/models", {
      name: "Author",
      apiKey: "author",
    });
    const author = await authorRes.json();
    await jsonRequest(app, "POST", `/api/models/${author.id}/fields`, {
      label: "Name", apiKey: "name", fieldType: "string",
    });
    await jsonRequest(app, "POST", "/api/records", {
      modelApiKey: "author",
      data: { name: "Alice" },
    });

    const result = await gqlQuery(app, `{
      allAuthors {
        name
      }
      allPosts {
        title
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data.allAuthors).toHaveLength(1);
    expect(result.data.allAuthors[0].name).toBe("Alice");
    expect(result.data.allPosts).toHaveLength(2);
  });

  // --- Filtering ---

  it("filters by string equality", async () => {
    const result = await gqlQuery(app, `{
      allPosts(filter: { title: { eq: "First Post" } }) { title }
    }`);
    expect(result.errors).toBeUndefined();
    expect(result.data.allPosts).toHaveLength(1);
    expect(result.data.allPosts[0].title).toBe("First Post");
  });

  it("filters by integer comparison", async () => {
    const result = await gqlQuery(app, `{
      allPosts(filter: { views: { gt: 60 } }) { title views }
    }`);
    expect(result.errors).toBeUndefined();
    expect(result.data.allPosts).toHaveLength(1);
    expect(result.data.allPosts[0].title).toBe("First Post");
  });

  it("filters by boolean equality", async () => {
    const result = await gqlQuery(app, `{
      allPosts(filter: { published: { eq: true } }) { title }
    }`);
    expect(result.errors).toBeUndefined();
    expect(result.data.allPosts).toHaveLength(1);
    expect(result.data.allPosts[0].title).toBe("First Post");
  });

  it("filters with string matches (regex)", async () => {
    const result = await gqlQuery(app, `{
      allPosts(filter: { title: { matches: "First" } }) { title }
    }`);
    expect(result.errors).toBeUndefined();
    expect(result.data.allPosts).toHaveLength(1);
  });

  it("filters with AND", async () => {
    const result = await gqlQuery(app, `{
      allPosts(filter: { AND: [{ published: { eq: true } }, { views: { gte: 50 } }] }) { title }
    }`);
    expect(result.errors).toBeUndefined();
    expect(result.data.allPosts).toHaveLength(1);
  });

  it("filters with OR", async () => {
    const result = await gqlQuery(app, `{
      allPosts(filter: { OR: [{ title: { eq: "First Post" } }, { title: { eq: "Second Post" } }] }) { title }
    }`);
    expect(result.errors).toBeUndefined();
    expect(result.data.allPosts).toHaveLength(2);
  });

  it("meta query respects filter", async () => {
    const result = await gqlQuery(app, `{
      _allPostsMeta(filter: { published: { eq: true } }) { count }
    }`);
    expect(result.errors).toBeUndefined();
    expect(result.data._allPostsMeta.count).toBe(1);
  });

  // --- Ordering ---

  it("orders by field ASC", async () => {
    const result = await gqlQuery(app, `{
      allPosts(orderBy: [views_ASC]) { title views }
    }`);
    expect(result.errors).toBeUndefined();
    expect(result.data.allPosts[0].views).toBe(50);
    expect(result.data.allPosts[1].views).toBe(100);
  });

  it("orders by field DESC", async () => {
    const result = await gqlQuery(app, `{
      allPosts(orderBy: [views_DESC]) { title views }
    }`);
    expect(result.errors).toBeUndefined();
    expect(result.data.allPosts[0].views).toBe(100);
    expect(result.data.allPosts[1].views).toBe(50);
  });

  // --- Link resolution ---

  it("resolves link fields to nested objects", async () => {
    // Create author model
    const authorRes = await jsonRequest(app, "POST", "/api/models", {
      name: "Author",
      apiKey: "author",
    });
    const authorModel = await authorRes.json();
    await jsonRequest(app, "POST", `/api/models/${authorModel.id}/fields`, {
      label: "Name", apiKey: "name", fieldType: "string",
    });

    // Add author link field to post
    const postModel = (await (await app.request("/api/models")).json()) as any[];
    const post = postModel.find((m: any) => m.apiKey === "post");
    await jsonRequest(app, "POST", `/api/models/${post.id}/fields`, {
      label: "Author",
      apiKey: "author",
      fieldType: "link",
      validators: { item_item_type: ["author"] },
    });

    // Create an author record
    const authorRecordRes = await jsonRequest(app, "POST", "/api/records", {
      modelApiKey: "author",
      data: { name: "Alice" },
    });
    const authorRecord = await authorRecordRes.json();

    // Create a post linked to the author
    await jsonRequest(app, "POST", "/api/records", {
      modelApiKey: "post",
      data: { title: "Linked Post", body: "test", views: 5, published: true, author: authorRecord.id },
    });

    // Query with link resolution
    const result = await gqlQuery(app, `{
      allPosts(filter: { title: { eq: "Linked Post" } }) {
        title
        author {
          name
        }
      }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data.allPosts[0].author.name).toBe("Alice");
  });

  it("returns null for unset link fields", async () => {
    const result = await gqlQuery(app, `{
      allPosts {
        title
      }
    }`);

    // Posts created in beforeEach have no author field
    expect(result.errors).toBeUndefined();
    expect(result.data.allPosts.length).toBeGreaterThan(0);
  });

  it("includes meta fields on records", async () => {
    const result = await gqlQuery(app, `{
      allPosts {
        id
        _status
        _createdAt
        _updatedAt
      }
    }`);

    expect(result.errors).toBeUndefined();
    const post = result.data.allPosts[0];
    expect(post.id).toBeTruthy();
    expect(post._status).toBe("draft");
    expect(post._createdAt).toBeTruthy();
    expect(post._updatedAt).toBeTruthy();
  });
});
