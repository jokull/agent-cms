import { beforeEach, describe, expect, it } from "vitest";
import { createTestApp, jsonRequest } from "./app-helpers.js";

describe("Record Overrides", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    ({ handler } = createTestApp());

    await jsonRequest(handler, "POST", "/api/locales", { code: "en", position: 0 });
    const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Article", apiKey: "article" });
    const model = await modelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string", localized: true,
    });
  });

  it("preserves overridden system timestamps on create and patch", async () => {
    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      id: "article-1",
      modelApiKey: "article",
      data: {
        title: { en: "Imported" },
      },
      overrides: {
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-02T00:00:00.000Z",
        publishedAt: "2020-01-03T00:00:00.000Z",
        firstPublishedAt: "2020-01-04T00:00:00.000Z",
      },
    });
    expect(createRes.status).toBe(201);

    const created = await (await jsonRequest(handler, "GET", "/api/records/article-1?modelApiKey=article")).json();
    expect(created._created_at).toBe("2020-01-01T00:00:00.000Z");
    expect(created._updated_at).toBe("2020-01-02T00:00:00.000Z");
    expect(created._published_at).toBe("2020-01-03T00:00:00.000Z");
    expect(created._first_published_at).toBe("2020-01-04T00:00:00.000Z");

    const patchRes = await jsonRequest(handler, "PATCH", "/api/records/article-1", {
      modelApiKey: "article",
      data: {
        title: { en: "Imported update" },
      },
      overrides: {
        updatedAt: "2020-02-01T00:00:00.000Z",
        publishedAt: "2020-02-02T00:00:00.000Z",
      },
    });
    expect(patchRes.status).toBe(200);

    const patched = await (await jsonRequest(handler, "GET", "/api/records/article-1?modelApiKey=article")).json();
    expect(patched._created_at).toBe("2020-01-01T00:00:00.000Z");
    expect(patched._updated_at).toBe("2020-02-01T00:00:00.000Z");
    expect(patched._published_at).toBe("2020-02-02T00:00:00.000Z");
    expect(patched._first_published_at).toBe("2020-01-04T00:00:00.000Z");
  });
});
