import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("Multi-target link resolution", () => {
  let handler: (req: Request) => Promise<Response>;
  let authorId: string;
  let tagId: string;

  beforeEach(async () => {
    ({ handler } = createTestApp());

    // Create two target models
    const authorModelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Author", apiKey: "author" });
    const authorModel = await authorModelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${authorModel.id}/fields`, {
      label: "Name", apiKey: "name", fieldType: "string",
    });

    const tagModelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Tag", apiKey: "tag" });
    const tagModel = await tagModelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${tagModel.id}/fields`, {
      label: "Label", apiKey: "label", fieldType: "string",
    });

    // Create records
    authorId = (await (await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "author", data: { name: "Bob" },
    })).json()).id;

    tagId = (await (await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "tag", data: { label: "TypeScript" },
    })).json()).id;

    // Create a model with multi-target link and links fields
    const postModelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
    const postModel = await postModelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    // Single link with multiple allowed targets
    await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
      label: "Related", apiKey: "related", fieldType: "link",
      validators: { item_item_type: ["author", "tag"] },
    });
    // Multi-link with multiple allowed targets
    await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
      label: "References", apiKey: "references", fieldType: "links",
      validators: { items_item_type: ["author", "tag"] },
    });
  });

  it("resolves multi-target link field to correct record with __typename", async () => {
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: { title: "Linked to Author", related: authorId },
    });

    const result = await gqlQuery(handler, `{
      allPosts { title related }
    }`, { includeDrafts: true });

    expect(result.errors).toBeUndefined();
    const post = result.data.allPosts[0];
    // Multi-target returns JSON type, so resolved record comes as JSON object
    expect(post.related.name).toBe("Bob");
    expect(post.related.__typename).toBe("AuthorRecord");
  });

  it("resolves multi-target link to a different model", async () => {
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: { title: "Linked to Tag", related: tagId },
    });

    const result = await gqlQuery(handler, `{
      allPosts { related }
    }`, { includeDrafts: true });

    expect(result.errors).toBeUndefined();
    const post = result.data.allPosts[0];
    expect(post.related.label).toBe("TypeScript");
    expect(post.related.__typename).toBe("TagRecord");
  });

  it("resolves multi-target links field with mixed types", async () => {
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: { title: "Mixed Refs", references: [authorId, tagId] },
    });

    const result = await gqlQuery(handler, `{
      allPosts { references }
    }`, { includeDrafts: true });

    expect(result.errors).toBeUndefined();
    const refs = result.data.allPosts[0].references;
    expect(refs).toHaveLength(2);

    const author = refs.find((r: any) => r.__typename === "AuthorRecord");
    expect(author.name).toBe("Bob");

    const tag = refs.find((r: any) => r.__typename === "TagRecord");
    expect(tag.label).toBe("TypeScript");
  });

  it("returns null for link to non-existent record", async () => {
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: { title: "Broken Link", related: "nonexistent-id" },
    });

    const result = await gqlQuery(handler, `{
      allPosts { related }
    }`, { includeDrafts: true });

    expect(result.errors).toBeUndefined();
    expect(result.data.allPosts[0].related).toBeNull();
  });
});
