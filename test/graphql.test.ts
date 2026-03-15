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
