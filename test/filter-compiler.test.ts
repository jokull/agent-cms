import { describe, it, expect } from "vitest";
import { compileFilterToSql, compileOrderBy } from "../src/graphql/filter-compiler.js";

describe("Filter Compiler", () => {
  describe("compileFilterToSql", () => {
    it("returns null for empty filter", () => {
      expect(compileFilterToSql(undefined)).toBeNull();
      expect(compileFilterToSql({})).toBeNull();
    });

    it("compiles eq filter", () => {
      const result = compileFilterToSql({ title: { eq: "Hello" } });
      expect(result).toEqual({ where: '"title" = ?', params: ["Hello"] });
    });

    it("compiles boolean eq with SQLite coercion", () => {
      const result = compileFilterToSql({ published: { eq: true } });
      expect(result).toEqual({ where: '"published" = ?', params: [1] });
    });

    it("compiles integer comparison operators", () => {
      const result = compileFilterToSql({ views: { gt: 10, lte: 100 } });
      expect(result!.where).toBe('"views" > ? AND "views" <= ?');
      expect(result!.params).toEqual([10, 100]);
    });

    it("compiles matches (LIKE)", () => {
      const result = compileFilterToSql({ title: { matches: "hello" } });
      expect(result!.where).toBe('"title" LIKE ?');
      expect(result!.params).toEqual(["%hello%"]);
    });

    it("compiles exists", () => {
      const trueResult = compileFilterToSql({ avatar: { exists: true } });
      expect(trueResult!.where).toBe('"avatar" IS NOT NULL');

      const falseResult = compileFilterToSql({ avatar: { exists: false } });
      expect(falseResult!.where).toBe('"avatar" IS NULL');
    });

    it("compiles isBlank", () => {
      const result = compileFilterToSql({ body: { isBlank: true } });
      expect(result!.where).toBe('("body" IS NULL OR "body" = \'\')');
    });

    it("compiles in operator", () => {
      const result = compileFilterToSql({ status: { in: ["draft", "published"] } });
      expect(result!.where).toBe('"status" IN (?, ?)');
      expect(result!.params).toEqual(["draft", "published"]);
    });

    it("compiles AND", () => {
      const result = compileFilterToSql({
        AND: [
          { title: { eq: "Hello" } },
          { published: { eq: true } },
        ],
      });
      expect(result!.where).toBe('(("title" = ?) AND ("published" = ?))');
      expect(result!.params).toEqual(["Hello", 1]);
    });

    it("compiles OR", () => {
      const result = compileFilterToSql({
        OR: [
          { title: { eq: "Hello" } },
          { title: { eq: "World" } },
        ],
      });
      expect(result!.where).toBe('(("title" = ?) OR ("title" = ?))');
      expect(result!.params).toEqual(["Hello", "World"]);
    });

    it("compiles nested AND + OR", () => {
      const result = compileFilterToSql({
        AND: [
          { published: { eq: true } },
          {
            OR: [
              { views: { gt: 100 } },
              { title: { matches: "featured" } },
            ],
          },
        ],
      });
      expect(result!.where).toContain("AND");
      expect(result!.where).toContain("OR");
      expect(result!.params).toEqual([1, 100, "%featured%"]);
    });

    it("handles localized fields with json_extract", () => {
      const result = compileFilterToSql(
        { title: { eq: "Halló" } },
        { fieldIsLocalized: (f) => f === "title", locale: "is" }
      );
      expect(result!.where).toBe("json_extract(\"title\", '$.is') = ?");
      expect(result!.params).toEqual(["Halló"]);
    });

    it("mixes localized and non-localized fields", () => {
      const result = compileFilterToSql(
        { title: { eq: "Hello" }, views: { gt: 10 } },
        { fieldIsLocalized: (f) => f === "title", locale: "en" }
      );
      expect(result!.where).toContain("json_extract");
      expect(result!.where).toContain('"views"');
    });
  });

  describe("compileOrderBy", () => {
    it("returns null for empty orderBy", () => {
      expect(compileOrderBy(undefined)).toBeNull();
      expect(compileOrderBy([])).toBeNull();
    });

    it("compiles single field ASC", () => {
      expect(compileOrderBy(["title_ASC"])).toBe('"title" ASC');
    });

    it("compiles single field DESC", () => {
      expect(compileOrderBy(["views_DESC"])).toBe('"views" DESC');
    });

    it("compiles multiple fields", () => {
      expect(compileOrderBy(["_created_at_DESC", "title_ASC"])).toBe(
        '"_created_at" DESC, "title" ASC'
      );
    });

    it("handles localized fields", () => {
      const result = compileOrderBy(["title_ASC"], {
        fieldIsLocalized: (f) => f === "title",
        locale: "en",
      });
      expect(result).toBe("json_extract(\"title\", '$.en') ASC");
    });
  });
});
