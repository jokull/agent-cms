import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("Meta field filtering and ordering", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    ({ handler } = createTestApp());

    const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Article", apiKey: "article" });
    const model = await modelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
  });

  it("exposes _modelApiKey on records", async () => {
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "Hello" },
    });

    const result = await gqlQuery(handler, `{
      allArticles { title _modelApiKey }
    }`, { includeDrafts: true });

    expect(result.errors).toBeUndefined();
    expect(result.data.allArticles[0]._modelApiKey).toBe("article");
  });

  it("filters by _firstPublishedAt exists (Trip pattern)", async () => {
    // Create two records, publish only one
    const r1 = await (await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "Published" },
    })).json();
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "Draft Only" },
    });

    // Publish the first one
    await jsonRequest(handler, "POST", `/api/records/${r1.id}/publish?modelApiKey=article`);

    const result = await gqlQuery(handler, `{
      allArticles(filter: { _firstPublishedAt: { exists: true } }) { title }
    }`, { includeDrafts: true });

    expect(result.errors).toBeUndefined();
    expect(result.data.allArticles).toHaveLength(1);
    expect(result.data.allArticles[0].title).toBe("Published");
  });

  it("orders by _firstPublishedAt DESC (Trip pattern)", async () => {
    const r1 = await (await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "First Published" },
    })).json();
    const r2 = await (await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "Second Published" },
    })).json();

    // Publish both — r1 first, then r2
    await jsonRequest(handler, "POST", `/api/records/${r1.id}/publish?modelApiKey=article`);
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));
    await jsonRequest(handler, "POST", `/api/records/${r2.id}/publish?modelApiKey=article`);

    const result = await gqlQuery(handler, `{
      allArticles(orderBy: [_firstPublishedAt_DESC]) { title _firstPublishedAt }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data.allArticles).toHaveLength(2);
    // Most recently published first
    expect(result.data.allArticles[0].title).toBe("Second Published");
    expect(result.data.allArticles[1].title).toBe("First Published");
  });

  it("filters by _createdAt range", async () => {
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "Recent" },
    });

    // Filter for records created after epoch (should find all)
    const result = await gqlQuery(handler, `{
      allArticles(filter: { _createdAt: { gt: "2020-01-01T00:00:00Z" } }) { title }
    }`, { includeDrafts: true });

    expect(result.errors).toBeUndefined();
    expect(result.data.allArticles.length).toBeGreaterThanOrEqual(1);
  });

  it("filters by _status with in operator", async () => {
    const r1 = await (await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "Will Publish" },
    })).json();
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "Stays Draft" },
    });
    await jsonRequest(handler, "POST", `/api/records/${r1.id}/publish?modelApiKey=article`);

    const result = await gqlQuery(handler, `{
      allArticles(filter: { _status: { eq: published } }) { title }
    }`, { includeDrafts: true });

    expect(result.errors).toBeUndefined();
    expect(result.data.allArticles).toHaveLength(1);
    expect(result.data.allArticles[0].title).toBe("Will Publish");
  });

  it("orders by _publishedAt ASC", async () => {
    const r1 = await (await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "A" },
    })).json();
    const r2 = await (await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article", data: { title: "B" },
    })).json();

    await jsonRequest(handler, "POST", `/api/records/${r2.id}/publish?modelApiKey=article`);
    await new Promise((r) => setTimeout(r, 10));
    await jsonRequest(handler, "POST", `/api/records/${r1.id}/publish?modelApiKey=article`);

    const result = await gqlQuery(handler, `{
      allArticles(orderBy: [_publishedAt_ASC]) { title }
    }`);

    expect(result.errors).toBeUndefined();
    // B was published first
    expect(result.data.allArticles[0].title).toBe("B");
  });
});
