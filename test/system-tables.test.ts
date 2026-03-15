import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { ulid } from "ulidx";
import { createTestDb } from "./helpers.js";
import * as schema from "../src/db/schema.js";

describe("System tables", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  describe("models", () => {
    it("creates and reads a model", () => {
      const now = new Date().toISOString();
      const id = ulid();

      db.insert(schema.models).values({
        id,
        name: "Article",
        apiKey: "article",
        createdAt: now,
        updatedAt: now,
      }).run();

      const result = db.select().from(schema.models).where(eq(schema.models.id, id)).get();

      expect(result).toBeDefined();
      expect(result!.name).toBe("Article");
      expect(result!.apiKey).toBe("article");
      expect(result!.isBlock).toBe(false);
      expect(result!.singleton).toBe(false);
      expect(result!.hasDraft).toBe(true);
    });

    it("enforces unique api_key", () => {
      const now = new Date().toISOString();
      db.insert(schema.models).values({
        id: ulid(),
        name: "Article",
        apiKey: "article",
        createdAt: now,
        updatedAt: now,
      }).run();

      expect(() =>
        db.insert(schema.models).values({
          id: ulid(),
          name: "Post",
          apiKey: "article",
          createdAt: now,
          updatedAt: now,
        }).run()
      ).toThrow();
    });

    it("creates a block type model", () => {
      const now = new Date().toISOString();
      const id = ulid();

      db.insert(schema.models).values({
        id,
        name: "Hero Section",
        apiKey: "hero_section",
        isBlock: true,
        createdAt: now,
        updatedAt: now,
      }).run();

      const result = db.select().from(schema.models).where(eq(schema.models.id, id)).get();
      expect(result!.isBlock).toBe(true);
    });
  });

  describe("fields", () => {
    it("creates fields linked to a model", () => {
      const now = new Date().toISOString();
      const modelId = ulid();

      db.insert(schema.models).values({
        id: modelId,
        name: "Article",
        apiKey: "article",
        createdAt: now,
        updatedAt: now,
      }).run();

      const fieldId = ulid();
      db.insert(schema.fields).values({
        id: fieldId,
        modelId,
        label: "Title",
        apiKey: "title",
        fieldType: "string",
        position: 0,
        createdAt: now,
        updatedAt: now,
      }).run();

      const result = db.select().from(schema.fields).where(eq(schema.fields.modelId, modelId)).all();
      expect(result).toHaveLength(1);
      expect(result[0].label).toBe("Title");
      expect(result[0].fieldType).toBe("string");
    });

    it("cascades delete when model is removed", () => {
      const now = new Date().toISOString();
      const modelId = ulid();

      db.insert(schema.models).values({
        id: modelId,
        name: "Article",
        apiKey: "article",
        createdAt: now,
        updatedAt: now,
      }).run();

      db.insert(schema.fields).values({
        id: ulid(),
        modelId,
        label: "Title",
        apiKey: "title",
        fieldType: "string",
        createdAt: now,
        updatedAt: now,
      }).run();

      db.delete(schema.models).where(eq(schema.models.id, modelId)).run();

      const fields = db.select().from(schema.fields).where(eq(schema.fields.modelId, modelId)).all();
      expect(fields).toHaveLength(0);
    });

    it("stores validators as JSON", () => {
      const now = new Date().toISOString();
      const modelId = ulid();
      const fieldId = ulid();

      db.insert(schema.models).values({
        id: modelId,
        name: "Article",
        apiKey: "article",
        createdAt: now,
        updatedAt: now,
      }).run();

      const validators = {
        required: true,
        length: { min: 1, max: 255 },
      };

      db.insert(schema.fields).values({
        id: fieldId,
        modelId,
        label: "Title",
        apiKey: "title",
        fieldType: "string",
        validators,
        createdAt: now,
        updatedAt: now,
      }).run();

      const result = db.select().from(schema.fields).where(eq(schema.fields.id, fieldId)).get();
      expect(result!.validators).toEqual(validators);
    });
  });

  describe("locales", () => {
    it("creates locales with fallback chain", () => {
      const now = new Date().toISOString();
      const enId = ulid();
      const isId = ulid();

      db.insert(schema.locales).values({ id: enId, code: "en", position: 0 }).run();
      db.insert(schema.locales).values({
        id: isId,
        code: "is",
        position: 1,
        fallbackLocaleId: enId,
      }).run();

      const isLocale = db.select().from(schema.locales).where(eq(schema.locales.code, "is")).get();
      expect(isLocale!.fallbackLocaleId).toBe(enId);
    });

    it("enforces unique locale code", () => {
      db.insert(schema.locales).values({ id: ulid(), code: "en", position: 0 }).run();
      expect(() =>
        db.insert(schema.locales).values({ id: ulid(), code: "en", position: 1 }).run()
      ).toThrow();
    });
  });

  describe("assets", () => {
    it("creates an asset with metadata", () => {
      const id = ulid();
      const now = new Date().toISOString();

      db.insert(schema.assets).values({
        id,
        filename: "hero.jpg",
        mimeType: "image/jpeg",
        size: 1024000,
        width: 1920,
        height: 1080,
        alt: "Hero image",
        r2Key: "uploads/hero.jpg",
        focalPoint: { x: 0.5, y: 0.3 },
        colors: ["#ff0000", "#00ff00"],
        tags: ["hero", "homepage"],
        createdAt: now,
      }).run();

      const result = db.select().from(schema.assets).where(eq(schema.assets.id, id)).get();
      expect(result!.filename).toBe("hero.jpg");
      expect(result!.width).toBe(1920);
      expect(result!.focalPoint).toEqual({ x: 0.5, y: 0.3 });
      expect(result!.colors).toEqual(["#ff0000", "#00ff00"]);
      expect(result!.tags).toEqual(["hero", "homepage"]);
    });
  });
});
