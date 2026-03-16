import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("GraphQL reverse reference queries", () => {
  let handler: (req: Request) => Promise<Response>;

  describe("basic reverse ref from link field", () => {
    let categoryId: string;

    beforeEach(async () => {
      ({ handler } = createTestApp());

      // Create Category model
      const catModelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Category", apiKey: "category" });
      const catModel = await catModelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${catModel.id}/fields`, {
        label: "Name", apiKey: "name", fieldType: "string",
      });

      // Create Post model with category link
      const postModelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
      const postModel = await postModelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });
      await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
        label: "Category", apiKey: "category", fieldType: "link",
        validators: { item_item_type: ["category"] },
      });

      // Create a category
      const catRes = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "category", data: { name: "Tech" },
      });
      categoryId = (await catRes.json()).id;

      // Create 3 posts linked to this category
      for (const title of ["Post A", "Post B", "Post C"]) {
        await jsonRequest(handler, "POST", "/api/records", {
          modelApiKey: "post", data: { title, category: categoryId },
        });
      }
    });

    it("returns all posts referencing a category via link field", async () => {
      const result = await gqlQuery(handler, `{
        category(id: "${categoryId}") {
          name
          _allReferencingPosts { title }
        }
      }`, undefined, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      expect(result.data.category.name).toBe("Tech");
      expect(result.data.category._allReferencingPosts).toHaveLength(3);
      const titles = result.data.category._allReferencingPosts.map((p: any) => p.title).sort();
      expect(titles).toEqual(["Post A", "Post B", "Post C"]);
    });
  });

  describe("reverse ref from links field", () => {
    let tagId: string;

    beforeEach(async () => {
      ({ handler } = createTestApp());

      // Create Tag model
      const tagModelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Tag", apiKey: "tag" });
      const tagModel = await tagModelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${tagModel.id}/fields`, {
        label: "Label", apiKey: "label", fieldType: "string",
      });

      // Create Post model with tags links field
      const postModelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
      const postModel = await postModelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });
      await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
        label: "Tags", apiKey: "tags", fieldType: "links",
        validators: { items_item_type: ["tag"] },
      });

      // Create a tag
      const tagRes = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "tag", data: { label: "JavaScript" },
      });
      tagId = (await tagRes.json()).id;

      // Create posts with the tag
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post", data: { title: "JS Intro", tags: [tagId] },
      });
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post", data: { title: "JS Advanced", tags: [tagId] },
      });
      // Post without this tag
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post", data: { title: "Python Basics", tags: [] },
      });
    });

    it("returns posts referencing a tag via links field", async () => {
      const result = await gqlQuery(handler, `{
        tag(id: "${tagId}") {
          label
          _allReferencingPosts { title }
        }
      }`, undefined, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      expect(result.data.tag.label).toBe("JavaScript");
      expect(result.data.tag._allReferencingPosts).toHaveLength(2);
      const titles = result.data.tag._allReferencingPosts.map((p: any) => p.title).sort();
      expect(titles).toEqual(["JS Advanced", "JS Intro"]);
    });
  });

  describe("filter on reverse refs", () => {
    let categoryId: string;

    beforeEach(async () => {
      ({ handler } = createTestApp());

      const catModelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Category", apiKey: "category" });
      const catModel = await catModelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${catModel.id}/fields`, {
        label: "Name", apiKey: "name", fieldType: "string",
      });

      const postModelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
      const postModel = await postModelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });
      await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
        label: "Category", apiKey: "category", fieldType: "link",
        validators: { item_item_type: ["category"] },
      });

      const catRes = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "category", data: { name: "Tech" },
      });
      categoryId = (await catRes.json()).id;

      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post", data: { title: "Hello", category: categoryId },
      });
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post", data: { title: "World", category: categoryId },
      });
    });

    it("filters reverse ref results", async () => {
      const result = await gqlQuery(handler, `{
        category(id: "${categoryId}") {
          _allReferencingPosts(filter: { title: { eq: "Hello" } }) { title }
        }
      }`, undefined, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      expect(result.data.category._allReferencingPosts).toHaveLength(1);
      expect(result.data.category._allReferencingPosts[0].title).toBe("Hello");
    });
  });

  describe("pagination on reverse refs", () => {
    let categoryId: string;

    beforeEach(async () => {
      ({ handler } = createTestApp());

      const catModelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Category", apiKey: "category" });
      const catModel = await catModelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${catModel.id}/fields`, {
        label: "Name", apiKey: "name", fieldType: "string",
      });

      const postModelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
      const postModel = await postModelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });
      await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
        label: "Category", apiKey: "category", fieldType: "link",
        validators: { item_item_type: ["category"] },
      });

      const catRes = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "category", data: { name: "Tech" },
      });
      categoryId = (await catRes.json()).id;

      for (let i = 1; i <= 5; i++) {
        await jsonRequest(handler, "POST", "/api/records", {
          modelApiKey: "post", data: { title: `Post ${i}`, category: categoryId },
        });
      }
    });

    it("paginates reverse ref results with first and skip", async () => {
      const result = await gqlQuery(handler, `{
        category(id: "${categoryId}") {
          _allReferencingPosts(first: 2, skip: 1) { title }
        }
      }`, undefined, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      expect(result.data.category._allReferencingPosts).toHaveLength(2);
    });
  });

  describe("multiple link fields to same target", () => {
    let categoryId: string;

    beforeEach(async () => {
      ({ handler } = createTestApp());

      const catModelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Category", apiKey: "category" });
      const catModel = await catModelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${catModel.id}/fields`, {
        label: "Name", apiKey: "name", fieldType: "string",
      });

      const postModelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
      const postModel = await postModelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });
      await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
        label: "Primary Category", apiKey: "primary_category", fieldType: "link",
        validators: { item_item_type: ["category"] },
      });
      await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
        label: "Secondary Category", apiKey: "secondary_category", fieldType: "link",
        validators: { item_item_type: ["category"] },
      });

      const catRes = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "category", data: { name: "Tech" },
      });
      categoryId = (await catRes.json()).id;

      // One post with primary_category set
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post", data: { title: "Primary Post", primary_category: categoryId },
      });
      // Another post with secondary_category set
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post", data: { title: "Secondary Post", secondary_category: categoryId },
      });
    });

    it("returns posts linked via either field", async () => {
      const result = await gqlQuery(handler, `{
        category(id: "${categoryId}") {
          _allReferencingPosts { title }
        }
      }`, undefined, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      expect(result.data.category._allReferencingPosts).toHaveLength(2);
      const titles = result.data.category._allReferencingPosts.map((p: any) => p.title).sort();
      expect(titles).toEqual(["Primary Post", "Secondary Post"]);
    });
  });

  describe("draft filtering on reverse refs", () => {
    let categoryId: string;

    beforeEach(async () => {
      ({ handler } = createTestApp());

      const catModelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Category", apiKey: "category" });
      const catModel = await catModelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${catModel.id}/fields`, {
        label: "Name", apiKey: "name", fieldType: "string",
      });

      const postModelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
      const postModel = await postModelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });
      await jsonRequest(handler, "POST", `/api/models/${postModel.id}/fields`, {
        label: "Category", apiKey: "category", fieldType: "link",
        validators: { item_item_type: ["category"] },
      });

      // Create and publish the category
      const catRes = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "category", data: { name: "Tech" },
      });
      categoryId = (await catRes.json()).id;
      await handler(new Request(`http://localhost/api/records/${categoryId}/publish?modelApiKey=category`, { method: "POST" }));

      // Create posts and publish only some
      const post1Res = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post", data: { title: "Published Post", category: categoryId },
      });
      const post1Id = (await post1Res.json()).id;
      await handler(new Request(`http://localhost/api/records/${post1Id}/publish?modelApiKey=post`, { method: "POST" }));

      // Draft post (not published)
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "post", data: { title: "Draft Post", category: categoryId },
      });
    });

    it("excludes drafts when includeDrafts is false", async () => {
      const result = await gqlQuery(handler, `{
        category(id: "${categoryId}") {
          _allReferencingPosts { title }
        }
      }`, undefined, { includeDrafts: false });

      expect(result.errors).toBeUndefined();
      expect(result.data.category._allReferencingPosts).toHaveLength(1);
      expect(result.data.category._allReferencingPosts[0].title).toBe("Published Post");
    });

    it("includes drafts when includeDrafts is true", async () => {
      const result = await gqlQuery(handler, `{
        category(id: "${categoryId}") {
          _allReferencingPosts { title }
        }
      }`, undefined, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      expect(result.data.category._allReferencingPosts).toHaveLength(2);
    });
  });

  describe("no incoming references", () => {
    beforeEach(async () => {
      ({ handler } = createTestApp());

      // Create a standalone model with no links pointing at it
      const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Standalone", apiKey: "standalone" });
      const model = await modelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Name", apiKey: "name", fieldType: "string",
      });

      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "standalone", data: { name: "Test" },
      });
    });

    it("does not have _allReferencing fields", async () => {
      // Query should work fine, _allReferencing* fields should not exist
      const result = await gqlQuery(handler, `{
        allStandalones { name }
      }`, undefined, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      expect(result.data.allStandalones).toHaveLength(1);

      // Attempting to query a nonexistent reverse ref field should error
      const badResult = await gqlQuery(handler, `{
        standalone(filter: { name: { eq: "Test" } }) {
          _allReferencingPosts { id }
        }
      }`, undefined, { includeDrafts: true });

      expect(badResult.errors).toBeDefined();
    });
  });
});
