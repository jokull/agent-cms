import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("_status GraphQL filtering", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(() => {
    ({ handler } = createTestApp());
  });

  it("filters draft, published, and updated records on draft-capable models", async () => {
    const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
    const model = await modelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });

    const draft = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post", data: { title: "Draft" },
    }).then((res) => res.json());

    const published = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post", data: { title: "Published" },
    }).then((res) => res.json());
    await jsonRequest(handler, "POST", `/api/records/${published.id}/publish?modelApiKey=post`);

    const updated = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post", data: { title: "Before update" },
    }).then((res) => res.json());
    await jsonRequest(handler, "POST", `/api/records/${updated.id}/publish?modelApiKey=post`);
    await jsonRequest(handler, "PATCH", `/api/records/${updated.id}`, {
      modelApiKey: "post", data: { title: "After update" },
    });

    const result = await gqlQuery(handler, `{
      drafts: allPosts(filter: { _status: { eq: draft } }) { id _status title }
      published: allPosts(filter: { _status: { eq: published } }) { id _status title }
      updated: allPosts(filter: { _status: { eq: updated } }) { id _status title }
      publishedOrUpdated: allPosts(filter: { _status: { in: [published, updated] } }) { id _status title }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data.drafts).toHaveLength(1);
    expect(result.data.drafts[0].id).toBe(draft.id);
    expect(result.data.published).toHaveLength(1);
    expect(result.data.published[0].id).toBe(published.id);
    expect(result.data.updated).toHaveLength(1);
    expect(result.data.updated[0].id).toBe(updated.id);
    expect(result.data.publishedOrUpdated).toHaveLength(2);
  });

  it("filters auto-published models as published-only and never returns draft status", async () => {
    const modelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Location", apiKey: "location", hasDraft: false,
    });
    const model = await modelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Name", apiKey: "name", fieldType: "string",
    });

    const first = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "location", data: { name: "Tokyo" },
    }).then((res) => res.json());

    await jsonRequest(handler, "PATCH", `/api/records/${first.id}`, {
      modelApiKey: "location", data: { name: "Tokyo Updated" },
    });

    const second = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "location", data: { name: "Osaka" },
    }).then((res) => res.json());

    const result = await gqlQuery(handler, `{
      published: allLocations(filter: { _status: { eq: published } }) { id _status name }
      drafts: allLocations(filter: { _status: { eq: draft } }) { id _status name }
      notDraft: allLocations(filter: { _status: { notIn: [draft] } }) { id _status name }
    }`);

    expect(result.errors).toBeUndefined();
    expect(result.data.published).toHaveLength(2);
    expect(result.data.published.every((record: { _status: string }) => record._status === "published")).toBe(true);
    expect(result.data.drafts).toEqual([]);
    expect(result.data.notDraft).toHaveLength(2);
    expect(result.data.notDraft.some((record: { id: string }) => record.id === second.id)).toBe(true);
  });
});
