import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("GraphQL Content Delivery API", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    ({ handler } = createTestApp());
    const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
    const model = await modelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, { label: "Title", apiKey: "title", fieldType: "string" });
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, { label: "Body", apiKey: "body", fieldType: "text" });
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, { label: "Views", apiKey: "views", fieldType: "integer" });
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, { label: "Published", apiKey: "published", fieldType: "boolean" });
    await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "First Post", body: "Hello world", views: 100, published: true } });
    await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "Second Post", body: "Another post", views: 50, published: false } });
  });

  it("queries all records", async () => {
    const result = await gqlQuery(handler, `{ allPosts { id title body views published _status _createdAt } }`);
    expect(result.errors).toBeUndefined();
    expect(result.data.allPosts).toHaveLength(2);
    expect(result.data.allPosts[0].title).toBe("First Post");
    expect(result.data.allPosts[0]._status).toBe("draft");
  });

  it("supports pagination", async () => {
    const result = await gqlQuery(handler, `{ allPosts(first: 1, skip: 1) { title } }`);
    expect(result.data.allPosts).toHaveLength(1);
    expect(result.data.allPosts[0].title).toBe("Second Post");
  });

  it("returns meta count", async () => {
    const result = await gqlQuery(handler, `{ _allPostsMeta { count } }`);
    expect(result.data._allPostsMeta.count).toBe(2);
  });

  it("filters by string equality", async () => {
    const result = await gqlQuery(handler, `{ allPosts(filter: { title: { eq: "First Post" } }) { title } }`);
    expect(result.data.allPosts).toHaveLength(1);
  });

  it("filters by integer comparison", async () => {
    const result = await gqlQuery(handler, `{ allPosts(filter: { views: { gt: 60 } }) { title } }`);
    expect(result.data.allPosts).toHaveLength(1);
  });

  it("filters by boolean", async () => {
    const result = await gqlQuery(handler, `{ allPosts(filter: { published: { eq: true } }) { title } }`);
    expect(result.data.allPosts).toHaveLength(1);
  });

  it("filters with AND/OR", async () => {
    const andResult = await gqlQuery(handler, `{ allPosts(filter: { AND: [{ published: { eq: true } }, { views: { gte: 50 } }] }) { title } }`);
    expect(andResult.data.allPosts).toHaveLength(1);

    const orResult = await gqlQuery(handler, `{ allPosts(filter: { OR: [{ title: { eq: "First Post" } }, { title: { eq: "Second Post" } }] }) { title } }`);
    expect(orResult.data.allPosts).toHaveLength(2);
  });

  it("orders by field", async () => {
    const asc = await gqlQuery(handler, `{ allPosts(orderBy: [views_ASC]) { views } }`);
    expect(asc.data.allPosts[0].views).toBe(50);

    const desc = await gqlQuery(handler, `{ allPosts(orderBy: [views_DESC]) { views } }`);
    expect(desc.data.allPosts[0].views).toBe(100);
  });

  it("resolves link fields", async () => {
    const authorRes = await jsonRequest(handler, "POST", "/api/models", { name: "Author", apiKey: "author" });
    const author = await authorRes.json();
    await jsonRequest(handler, "POST", `/api/models/${author.id}/fields`, { label: "Name", apiKey: "name", fieldType: "string" });

    const models = await (await handler(new Request("http://localhost/api/models"))).json() as any[];
    const postModel = models.find((m: any) => m.api_key === "post");
    await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
      label: "Author", apiKey: "author", fieldType: "link", validators: { item_item_type: ["author"] },
    });

    const authorRecRes = await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "author", data: { name: "Alice" } });
    const authorRec = await authorRecRes.json();
    await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "Linked Post", body: "test", views: 5, published: true, author: authorRec.id } });

    const result = await gqlQuery(handler, `{ allPosts(filter: { title: { eq: "Linked Post" } }) { title author { name } } }`);
    expect(result.errors).toBeUndefined();
    expect(result.data.allPosts[0].author.name).toBe("Alice");
  });

  it("includes meta fields", async () => {
    const result = await gqlQuery(handler, `{ allPosts { _status _createdAt _updatedAt } }`);
    expect(result.data.allPosts[0]._status).toBe("draft");
    expect(result.data.allPosts[0]._createdAt).toBeTruthy();
  });
});
