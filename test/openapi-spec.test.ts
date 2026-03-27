import { describe, it, expect } from "vitest";
import { openApiSpec } from "../src/http/api/index.js";

describe("OpenAPI spec", () => {
  it("generates a valid 3.1.0 spec", () => {
    expect(openApiSpec.openapi).toBe("3.1.0");
    expect(openApiSpec.info.title).toBe("Agent CMS API");
    expect(openApiSpec.info.version).toBe("1.0.0");
  });

  it("includes all route groups", () => {
    const paths = Object.keys(openApiSpec.paths);
    // Models
    expect(paths).toContain("/models");
    expect(paths).toContain("/models/{id}");
    // Fields
    expect(paths.some((p) => p.includes("fields"))).toBe(true);
    // Records
    expect(paths).toContain("/records");
    expect(paths).toContain("/records/{id}");
    // Assets
    expect(paths).toContain("/assets");
    expect(paths).toContain("/assets/{id}");
    // Locales
    expect(paths).toContain("/locales");
    // Schema
    expect(paths).toContain("/schema");
    // Search
    expect(paths).toContain("/search");
    // Tokens
    expect(paths).toContain("/tokens");
    // Preview tokens
    expect(paths.some((p) => p.includes("preview-tokens"))).toBe(true);
    // Paths
    expect(paths.some((p) => p.includes("paths"))).toBe(true);
  });

  it("has tags for each group", () => {
    const tags = openApiSpec.tags as Array<{ name: string }>;
    expect(tags.length).toBeGreaterThan(0);
    const tagNames = tags.map((t) => t.name);
    // Groups should produce tags (exact names depend on HttpApiGroup config)
    expect(tagNames.length).toBeGreaterThanOrEqual(5);
  });

  it("POST /models has request body schema", () => {
    const post = openApiSpec.paths["/models"]?.post;
    expect(post).toBeDefined();
    expect(post?.requestBody).toBeDefined();
  });

  it("GET /models/{id} has path parameter", () => {
    const get = openApiSpec.paths["/models/{id}"]?.get;
    expect(get).toBeDefined();
    const params = get?.parameters as Array<{ name: string; in: string }>;
    expect(params.some((p) => p.name === "id" && p.in === "path")).toBe(true);
  });
});
