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
      expect(result!.where).toBe('"title" LIKE ? ESCAPE \'\\\'');
      expect(result!.params).toEqual(["%hello%"]);
    });

    it("escapes LIKE metacharacters in matches so they match literally", () => {
      const result = compileFilterToSql({ title: { matches: "50%" } });
      expect(result!.params).toEqual(["%50\\%%"]);
    });

    it("escapes underscore in matches so it does not act as a single-char wildcard", () => {
      const result = compileFilterToSql({ filename: { matches: "report_2026" } });
      expect(result!.params).toEqual(["%report\\_2026%"]);
    });

    it("compiles notMatches with escaping and NOT LIKE", () => {
      const result = compileFilterToSql({ title: { notMatches: "50%" } });
      expect(result!.where).toBe('"title" NOT LIKE ? ESCAPE \'\\\'');
      expect(result!.params).toEqual(["%50\\%%"]);
    });

    it("compiles case-sensitive matches via GLOB with bracket-escaped metacharacters", () => {
      const result = compileFilterToSql({ title: { matches: { pattern: "a*b?", caseSensitive: true } } });
      expect(result!.where).toBe('"title" GLOB ?');
      expect(result!.params).toEqual(["*a[*]b[?]*"]);
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

  describe("_locales filter", () => {
    it("anyIn ORs across locales (record content in ANY requested locale matches)", () => {
      const result = compileFilterToSql(
        { _locales: { anyIn: ["en", "de"] } },
        { localizedDbColumns: ["title"] }
      );
      // Must be a single OR-of-locales group, not one AND-ed condition per locale.
      expect(result!.where).toBe(
        "(((json_extract(\"title\", '$.en') IS NOT NULL AND json_extract(\"title\", '$.en') != '')) OR"
        + " ((json_extract(\"title\", '$.de') IS NOT NULL AND json_extract(\"title\", '$.de') != '')))"
      );
    });

    it("allIn ANDs across locales (every requested locale must have content)", () => {
      const result = compileFilterToSql(
        { _locales: { allIn: ["en", "de"] } },
        { localizedDbColumns: ["title"] }
      );
      expect(result!.where).toBe(
        "((json_extract(\"title\", '$.en') IS NOT NULL AND json_extract(\"title\", '$.en') != '')) AND"
        + " ((json_extract(\"title\", '$.de') IS NOT NULL AND json_extract(\"title\", '$.de') != ''))"
      );
    });

    it("anyIn is not byte-identical to allIn (regression: they used to compile to the same SQL)", () => {
      const anyIn = compileFilterToSql({ _locales: { anyIn: ["en", "de"] } }, { localizedDbColumns: ["title"] });
      const allIn = compileFilterToSql({ _locales: { allIn: ["en", "de"] } }, { localizedDbColumns: ["title"] });
      expect(anyIn!.where).not.toBe(allIn!.where);
      // anyIn ORs the per-locale groups together...
      expect(anyIn!.where).toContain(") OR (");
      // ...while allIn ANDs them.
      expect(allIn!.where).toContain(") AND (");
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

  // Regression: #68 — locale is interpolated into a JSON path literal and must
  // be rejected if it isn't a safe locale code (SQL injection on the read path).
  describe("locale injection guard (#68)", () => {
    const localizedOpts = { fieldIsLocalized: (f: string) => f === "title", locale: "" };

    it("accepts BCP-47-shaped locales in filters and orderBy", () => {
      expect(() =>
        compileFilterToSql({ title: { eq: "x" } }, { ...localizedOpts, locale: "en-US" })
      ).not.toThrow();
      expect(compileOrderBy(["title_ASC"], { ...localizedOpts, locale: "pt_BR" })).toContain("$.pt_BR");
    });

    it("rejects a locale that would break out of the JSON path literal", () => {
      expect(() =>
        compileFilterToSql({ title: { eq: "x" } }, { ...localizedOpts, locale: "x') OR 1=1 --" })
      ).toThrow(/Invalid locale/);
      expect(() =>
        compileOrderBy(["title_ASC"], { ...localizedOpts, locale: "en'||(SELECT 1)" })
      ).toThrow(/Invalid locale/);
    });

    it("rejects an injected locale inside a _locales filter", () => {
      expect(() =>
        compileFilterToSql(
          { _locales: { anyIn: ["en", "x') OR 1=1 --"] } },
          { localizedDbColumns: ["title"] }
        )
      ).toThrow(/Invalid locale/);
    });
  });
});
