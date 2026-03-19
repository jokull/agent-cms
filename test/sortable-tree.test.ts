import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("Sortable and tree models", () => {
  let handler: (req: Request) => Promise<Response>;

  describe("Sortable models", () => {
    beforeEach(async () => {
      ({ handler } = createTestApp());

      const modelRes = await jsonRequest(handler, "POST", "/api/models", {
        name: "Task", apiKey: "task", sortable: true,
      });
      const model = await modelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });
    });

    it("auto-assigns incrementing _position on record creation", async () => {
      const r1 = await (await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "task", data: { title: "First" },
      })).json();
      const r2 = await (await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "task", data: { title: "Second" },
      })).json();
      const r3 = await (await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "task", data: { title: "Third" },
      })).json();

      expect(r1._position).toBe(0);
      expect(r2._position).toBe(1);
      expect(r3._position).toBe(2);
    });

    it("exposes _position in GraphQL and supports _position ordering", async () => {
      await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "task", data: { title: "A" } });
      await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "task", data: { title: "B" } });
      await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "task", data: { title: "C" } });

      const result = await gqlQuery(handler, `{
        allTasks(orderBy: [_position_ASC]) { title _position }
      }`, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      expect(result.data.allTasks).toHaveLength(3);
      expect(result.data.allTasks[0].title).toBe("A");
      expect(result.data.allTasks[0]._position).toBe(0);
      expect(result.data.allTasks[2].title).toBe("C");
      expect(result.data.allTasks[2]._position).toBe(2);

      // Descending
      const desc = await gqlQuery(handler, `{
        allTasks(orderBy: [_position_DESC]) { title _position }
      }`, { includeDrafts: true });
      expect(desc.data.allTasks[0].title).toBe("C");
    });

    it("supports reordering via REST", async () => {
      const r1 = await (await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "task", data: { title: "A" } })).json();
      const r2 = await (await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "task", data: { title: "B" } })).json();
      const r3 = await (await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "task", data: { title: "C" } })).json();

      // Reorder: C, A, B
      const reorderRes = await jsonRequest(handler, "POST", "/api/reorder", {
        modelApiKey: "task",
        recordIds: [r3.id, r1.id, r2.id],
      });
      expect(reorderRes.status).toBe(200);

      const result = await gqlQuery(handler, `{
        allTasks(orderBy: [_position_ASC]) { title _position }
      }`, { includeDrafts: true });

      expect(result.data.allTasks[0].title).toBe("C");
      expect(result.data.allTasks[0]._position).toBe(0);
      expect(result.data.allTasks[1].title).toBe("A");
      expect(result.data.allTasks[2].title).toBe("B");
    });
  });

  describe("Tree models", () => {
    beforeEach(async () => {
      ({ handler } = createTestApp());

      const modelRes = await jsonRequest(handler, "POST", "/api/models", {
        name: "Category", apiKey: "category", tree: true,
      });
      const model = await modelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Name", apiKey: "name", fieldType: "string",
      });
    });

    it("creates records with _parent_id for tree hierarchy", async () => {
      const root = await (await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "category", data: { name: "Electronics" },
      })).json();

      const child = await (await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "category", data: { name: "Phones", _parent_id: root.id },
      })).json();

      expect(child._parent_id).toBe(root.id);
      expect(child._position).toBe(1);
    });

    it("resolves _parent and _children in GraphQL", async () => {
      const root = await (await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "category", data: { name: "Electronics" },
      })).json();

      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "category", data: { name: "Phones", _parent_id: root.id },
      });
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "category", data: { name: "Laptops", _parent_id: root.id },
      });

      // Query children of root
      const result = await gqlQuery(handler, `{
        category(id: "${root.id}") {
          name
          _children { name _position _parentId }
        }
      }`, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      const cat = result.data.category;
      expect(cat.name).toBe("Electronics");
      expect(cat._children).toHaveLength(2);
      expect(cat._children[0].name).toBe("Phones");
      expect(cat._children[0]._parentId).toBe(root.id);
      expect(cat._children[1].name).toBe("Laptops");

      // Query parent from child
      const childResult = await gqlQuery(handler, `{
        allCategories(filter: { name: { eq: "Phones" } }) {
          name
          _parent { name }
        }
      }`, { includeDrafts: true });

      expect(childResult.errors).toBeUndefined();
      expect(childResult.data.allCategories[0]._parent.name).toBe("Electronics");
    });

    it("supports model-level default ordering", async () => {
      // Create a non-sortable model with default ordering
      const modelRes = await jsonRequest(handler, "POST", "/api/models", {
        name: "Article", apiKey: "article", ordering: "title_ASC",
      });
      const model = await modelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });

      await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "article", data: { title: "Zebra" } });
      await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "article", data: { title: "Apple" } });
      await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "article", data: { title: "Mango" } });

      // Without orderBy — should use model's default ordering (title_ASC)
      const result = await gqlQuery(handler, `{
        allArticles { title }
      }`, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      expect(result.data.allArticles.map((r: { title: string }) => r.title)).toEqual(["Apple", "Mango", "Zebra"]);

      // Explicit orderBy should override the default
      const desc = await gqlQuery(handler, `{
        allArticles(orderBy: [title_DESC]) { title }
      }`, { includeDrafts: true });

      expect(desc.data.allArticles.map((r: { title: string }) => r.title)).toEqual(["Zebra", "Mango", "Apple"]);
    });

    it("supports updating model ordering", async () => {
      // Create model without ordering
      const modelRes = await jsonRequest(handler, "POST", "/api/models", {
        name: "Post", apiKey: "post",
      });
      const model = await modelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Title", apiKey: "title", fieldType: "string",
      });

      // Set ordering via update
      const updateRes = await jsonRequest(handler, "PATCH", `/api/models/${model.id}`, {
        ordering: "_createdAt_DESC",
      });
      expect(updateRes.status).toBe(200);
      const updated = await updateRes.json();
      expect(updated.ordering).toBe("_createdAt_DESC");

      // Clear ordering
      const clearRes = await jsonRequest(handler, "PATCH", `/api/models/${model.id}`, {
        ordering: null,
      });
      expect(clearRes.status).toBe(200);
      const cleared = await clearRes.json();
      expect(cleared.ordering).toBeNull();
    });

    it("rejects reorder on non-sortable model", async () => {
      // Create a non-sortable model
      const modelRes = await jsonRequest(handler, "POST", "/api/models", {
        name: "Tag", apiKey: "tag",
      });
      const model = await modelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Name", apiKey: "name", fieldType: "string",
      });

      const reorderRes = await jsonRequest(handler, "POST", "/api/reorder", {
        modelApiKey: "tag", recordIds: [],
      });
      expect(reorderRes.status).toBe(400);
    });
  });
});
