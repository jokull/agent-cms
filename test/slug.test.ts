import { describe, it, expect, beforeEach } from "vitest";
import { generateSlug } from "../src/slug.js";
import { createTestApp, jsonRequest } from "./app-helpers.js";
import type { Hono } from "hono";

describe("Slug generation", () => {
  describe("generateSlug", () => {
    it("lowercases and hyphenates", () => {
      expect(generateSlug("Hello World")).toBe("hello-world");
    });

    it("handles Icelandic characters", () => {
      expect(generateSlug("Þórbergur Ögmundsson")).toBe("thorbergur-ogmundsson");
    });

    it("handles eth (ð)", () => {
      expect(generateSlug("Garðabær")).toBe("gardabaer");
    });

    it("handles æ", () => {
      expect(generateSlug("Pair of Ævintýri")).toBe("pair-of-aevintyri");
    });

    it("handles accented vowels", () => {
      expect(generateSlug("Íslensku bloggfærslurnar")).toBe("islensku-bloggfaerslurnar");
    });

    it("strips special characters", () => {
      expect(generateSlug("Hello! World? #1")).toBe("hello-world-1");
    });

    it("handles multiple spaces and hyphens", () => {
      expect(generateSlug("hello   world--test")).toBe("hello-world-test");
    });
  });

  describe("Slug field in records API", () => {
    let app: Hono;
    let modelId: string;

    beforeEach(async () => {
      ({ app } = createTestApp());

      const modelRes = await jsonRequest(app, "POST", "/api/models", {
        name: "Post",
        apiKey: "post",
      });
      const model = await modelRes.json();
      modelId = model.id;

      await jsonRequest(app, "POST", `/api/models/${modelId}/fields`, {
        label: "Title",
        apiKey: "title",
        fieldType: "string",
      });
      await jsonRequest(app, "POST", `/api/models/${modelId}/fields`, {
        label: "Slug",
        apiKey: "slug",
        fieldType: "slug",
        validators: { slug_source: "title" },
      });
    });

    it("auto-generates slug from source field", async () => {
      const res = await jsonRequest(app, "POST", "/api/records", {
        modelApiKey: "post",
        data: { title: "My First Post" },
      });

      expect(res.status).toBe(201);
      const record = await res.json();
      expect(record.slug).toBe("my-first-post");
    });

    it("auto-generates slug with diacritics", async () => {
      const res = await jsonRequest(app, "POST", "/api/records", {
        modelApiKey: "post",
        data: { title: "Íslensku bloggfærslurnar" },
      });

      const record = await res.json();
      expect(record.slug).toBe("islensku-bloggfaerslurnar");
    });

    it("enforces slug uniqueness with suffix", async () => {
      await jsonRequest(app, "POST", "/api/records", {
        modelApiKey: "post",
        data: { title: "Hello World" },
      });

      const res = await jsonRequest(app, "POST", "/api/records", {
        modelApiKey: "post",
        data: { title: "Hello World" },
      });

      const record = await res.json();
      expect(record.slug).toBe("hello-world-2");
    });

    it("allows explicit slug override", async () => {
      const res = await jsonRequest(app, "POST", "/api/records", {
        modelApiKey: "post",
        data: { title: "My Post", slug: "custom-slug" },
      });

      const record = await res.json();
      expect(record.slug).toBe("custom-slug");
    });
  });
});
