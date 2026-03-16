import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("includeDrafts (X-Include-Drafts header)", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    ({ handler } = createTestApp());

    const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
    const model = await modelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, { label: "Title", apiKey: "title", fieldType: "string" });

    // Create a draft post
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post", data: { title: "Draft Post" },
    });

    // Create and publish a post
    const pubRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post", data: { title: "Published Post" },
    });
    const pubRecord = await pubRes.json();
    await handler(new Request(`http://localhost/api/records/${pubRecord.id}/publish?modelApiKey=post`, { method: "POST" }));

    // Create, publish, then edit a post (status = "updated")
    const updRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post", data: { title: "Original Title" },
    });
    const updRecord = await updRes.json();
    await handler(new Request(`http://localhost/api/records/${updRecord.id}/publish?modelApiKey=post`, { method: "POST" }));
    await jsonRequest(handler, "PATCH", `/api/records/${updRecord.id}`, {
      modelApiKey: "post", data: { title: "Updated Title" },
    });
  });

  describe("without X-Include-Drafts (default)", () => {
    it("excludes draft records", async () => {
      const result = await gqlQuery(handler, `{ allPosts { title _status } }`, undefined, { includeDrafts: false });
      expect(result.errors).toBeUndefined();
      // Should only see published + updated records (not draft)
      expect(result.data.allPosts).toHaveLength(2);
      const titles = result.data.allPosts.map((p: any) => p.title);
      expect(titles).not.toContain("Draft Post");
    });

    it("returns published version for 'updated' records", async () => {
      const result = await gqlQuery(handler, `{ allPosts { title } }`, undefined, { includeDrafts: false });
      // The "updated" record should show its published snapshot title
      const titles = result.data.allPosts.map((p: any) => p.title);
      expect(titles).toContain("Original Title"); // Published version, not "Updated Title"
      expect(titles).not.toContain("Updated Title");
    });

    it("count excludes drafts", async () => {
      const result = await gqlQuery(handler, `{ _allPostsMeta { count } }`, undefined, { includeDrafts: false });
      expect(result.data._allPostsMeta.count).toBe(2); // Only published + updated
    });
  });

  describe("with X-Include-Drafts: true", () => {
    it("includes all records including drafts", async () => {
      const result = await gqlQuery(handler, `{ allPosts { title _status } }`, undefined, { includeDrafts: true });
      expect(result.errors).toBeUndefined();
      expect(result.data.allPosts).toHaveLength(3); // draft + published + updated
      const titles = result.data.allPosts.map((p: any) => p.title);
      expect(titles).toContain("Draft Post");
    });

    it("returns draft version for 'updated' records", async () => {
      const result = await gqlQuery(handler, `{ allPosts { title _status } }`, undefined, { includeDrafts: true });
      const updatedPost = result.data.allPosts.find((p: any) => p._status === "updated");
      expect(updatedPost).toBeDefined();
      expect(updatedPost.title).toBe("Updated Title"); // Draft version, not published
    });

    it("shows _status correctly", async () => {
      const result = await gqlQuery(handler, `{ allPosts { title _status } }`, undefined, { includeDrafts: true });
      const statuses = result.data.allPosts.map((p: any) => p._status).sort();
      expect(statuses).toEqual(["draft", "published", "updated"]);
    });

    it("count includes all records", async () => {
      const result = await gqlQuery(handler, `{ _allPostsMeta { count } }`, undefined, { includeDrafts: true });
      expect(result.data._allPostsMeta.count).toBe(3);
    });
  });
});
