import { describe, it, expect, beforeEach } from "vitest";
import { generateSlug } from "../src/slug.js";
import { createTestApp, jsonRequest } from "./app-helpers.js";

describe("Slug generation", () => {
  describe("generateSlug", () => {
    it("lowercases and hyphenates", () => { expect(generateSlug("Hello World")).toBe("hello-world"); });
    it("handles Icelandic Þ", () => { expect(generateSlug("Þórbergur Ögmundsson")).toBe("thorbergur-ogmundsson"); });
    it("handles ð", () => { expect(generateSlug("Garðabær")).toBe("gardabaer"); });
    it("handles æ", () => { expect(generateSlug("Pair of Ævintýri")).toBe("pair-of-aevintyri"); });
    it("handles accented vowels", () => { expect(generateSlug("Íslensku bloggfærslurnar")).toBe("islensku-bloggfaerslurnar"); });
    it("strips special chars", () => { expect(generateSlug("Hello! World? #1")).toBe("hello-world-1"); });
    it("collapses hyphens", () => { expect(generateSlug("hello   world--test")).toBe("hello-world-test"); });
  });

  describe("Slug field in records API", () => {
    let handler: (req: Request) => Promise<Response>;

    beforeEach(async () => {
      ({ handler } = createTestApp());
      const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
      const model = await modelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, { label: "Title", apiKey: "title", fieldType: "string" });
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: "Slug", apiKey: "slug", fieldType: "slug", validators: { slug_source: "title" },
      });
    });

    it("auto-generates slug from source field", async () => {
      const res = await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "My First Post" } });
      const record = await res.json();
      expect(record.slug).toBe("my-first-post");
    });

    it("auto-generates slug with diacritics", async () => {
      const res = await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "Íslensku bloggfærslurnar" } });
      const record = await res.json();
      expect(record.slug).toBe("islensku-bloggfaerslurnar");
    });

    it("enforces slug uniqueness", async () => {
      await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "Hello World" } });
      const res = await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "Hello World" } });
      const record = await res.json();
      expect(record.slug).toBe("hello-world-2");
    });

    it("allows explicit slug override", async () => {
      const res = await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "post", data: { title: "My Post", slug: "custom-slug" } });
      const record = await res.json();
      expect(record.slug).toBe("custom-slug");
    });
  });
});
