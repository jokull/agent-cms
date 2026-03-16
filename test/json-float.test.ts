import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("JSON and Float field types", () => {
  let handler: (req: Request) => Promise<Response>;

  describe("JSON field", () => {
    beforeEach(async () => {
      ({ handler } = createTestApp());

      const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Config", apiKey: "config", singleton: true });
      const model = await modelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Name", apiKey: "name", fieldType: "string",
      });
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Settings", apiKey: "settings", fieldType: "json",
      });
    });

    it("stores and retrieves arbitrary JSON objects", async () => {
      const data = {
        theme: { primary: "#ff0000", secondary: "#00ff00" },
        features: ["dark-mode", "notifications"],
        version: 2,
      };
      const res = await (await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "config",
        data: { name: "Site Settings", settings: data },
      })).json();

      expect(res.settings).toEqual(data);
    });

    it("resolves JSON field in GraphQL as JSON scalar", async () => {
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "config",
        data: { name: "App Config", settings: { debug: true, maxRetries: 3 } },
      });

      const result = await gqlQuery(handler, `{
        allConfigs { name settings }
      }`, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      expect(result.data.allConfigs[0].settings).toEqual({ debug: true, maxRetries: 3 });
    });

    it("handles null JSON field", async () => {
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "config",
        data: { name: "Minimal" },
      });

      const result = await gqlQuery(handler, `{
        allConfigs { name settings }
      }`, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      expect(result.data.allConfigs[0].settings).toBeNull();
    });
  });

  describe("Float field", () => {
    beforeEach(async () => {
      ({ handler } = createTestApp());

      const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Product", apiKey: "product" });
      const model = await modelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Name", apiKey: "name", fieldType: "string",
      });
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Price", apiKey: "price", fieldType: "float",
      });
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Rating", apiKey: "rating", fieldType: "float",
      });
    });

    it("stores and retrieves float values", async () => {
      const res = await (await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "product",
        data: { name: "Widget", price: 19.99, rating: 4.5 },
      })).json();

      expect(res.price).toBe(19.99);
      expect(res.rating).toBe(4.5);
    });

    it("resolves float field in GraphQL as Float", async () => {
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "product",
        data: { name: "Gadget", price: 99.95, rating: 3.7 },
      });

      const result = await gqlQuery(handler, `{
        allProducts { name price rating }
      }`, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      const product = result.data.allProducts[0];
      expect(product.price).toBe(99.95);
      expect(product.rating).toBe(3.7);
    });

    it("supports float filtering in GraphQL", async () => {
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "product", data: { name: "Cheap", price: 5.00 },
      });
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "product", data: { name: "Expensive", price: 199.99 },
      });

      const result = await gqlQuery(handler, `{
        allProducts(filter: { price: { gt: 10.0 } }) { name price }
      }`, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      expect(result.data.allProducts).toHaveLength(1);
      expect(result.data.allProducts[0].name).toBe("Expensive");
    });

    it("supports float ordering", async () => {
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "product", data: { name: "B", price: 50.0 },
      });
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "product", data: { name: "A", price: 10.0 },
      });

      const result = await gqlQuery(handler, `{
        allProducts(orderBy: [price_ASC]) { name price }
      }`, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      expect(result.data.allProducts[0].name).toBe("A");
      expect(result.data.allProducts[1].name).toBe("B");
    });
  });
});
