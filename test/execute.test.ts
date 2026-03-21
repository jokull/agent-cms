import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { createWebHandler } from "../src/http/router.js";
import { runMigrations } from "./migrate.js";
import { jsonRequest } from "./app-helpers.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function getTracePath(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const trace = Reflect.get(value, "_trace");
  if (typeof trace !== "object" || trace === null || Array.isArray(trace)) return null;
  const path = Reflect.get(trace, "path");
  return typeof path === "string" ? path : null;
}

describe("execute() — in-process GraphQL", () => {
  let fetchHandler: (req: Request) => Promise<Response>;
  let execute: (
    query: string,
    variables?: Record<string, unknown>,
    context?: { includeDrafts?: boolean; excludeInvalid?: boolean }
  ) => Promise<{ data: unknown; errors?: ReadonlyArray<{ message: string }> }>;

  beforeEach(() => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-execute-"));
    const dbPath = join(tmpDir, "test.db");
    const sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });
    Effect.runSync(runMigrations().pipe(Effect.provide(sqlLayer)));
    const webHandler = createWebHandler(sqlLayer);
    fetchHandler = webHandler.fetch;
    execute = webHandler.execute;
  });

  it("queries content without HTTP round-trip", async () => {
    const modelRes = await jsonRequest(fetchHandler, "POST", "/api/models", {
      name: "Article",
      apiKey: "article",
    });
    const model = await modelRes.json();

    await jsonRequest(fetchHandler, "POST", `/api/models/${model.id}/fields`, {
      label: "Title",
      apiKey: "title",
      fieldType: "string",
    });

    await jsonRequest(fetchHandler, "POST", "/api/records", {
      modelApiKey: "article",
      data: { title: "Hello World" },
    });

    const result = await execute(
      `{ allArticles { title } }`,
      undefined,
      { includeDrafts: true }
    );

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      allArticles: [{ title: "Hello World" }],
    });
  });

  it("returns validation errors for invalid queries", async () => {
    const result = await execute(`{ nonExistentField }`);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it("respects includeDrafts context", async () => {
    const modelRes = await jsonRequest(fetchHandler, "POST", "/api/models", {
      name: "Post",
      apiKey: "post",
      hasDraft: true,
    });
    const model = await modelRes.json();

    await jsonRequest(fetchHandler, "POST", `/api/models/${model.id}/fields`, {
      label: "Title",
      apiKey: "title",
      fieldType: "string",
    });

    await jsonRequest(fetchHandler, "POST", "/api/records", {
      modelApiKey: "post",
      data: { title: "Draft Post" },
    });

    // Without includeDrafts — should not see draft records
    const published = await execute(`{ allPosts { title } }`);
    expect(published.data).toEqual({ allPosts: [] });

    // With includeDrafts — should see draft records
    const drafts = await execute(
      `{ allPosts { title } }`,
      undefined,
      { includeDrafts: true }
    );
    expect(drafts.data).toEqual({
      allPosts: [{ title: "Draft Post" }],
    });
  });

  it("allows introspection queries (exempt from depth limits)", async () => {
    const result = await execute(`{
      __schema {
        queryType { name }
        types { name kind fields { name type { name kind ofType { name kind ofType { name kind ofType { name } } } } } }
      }
    }`);
    expect(result.errors).toBeUndefined();
    const schema = (result.data as { __schema: { queryType: { name: string } } }).__schema;
    expect(schema.queryType.name).toBe("Query");
  });

  it("uses the custom executor for deep structured content queries", async () => {
    const authorModelRes = await jsonRequest(fetchHandler, "POST", "/api/models", {
      name: "Author",
      apiKey: "author",
    });
    const authorModel = await authorModelRes.json();
    await jsonRequest(fetchHandler, "POST", `/api/models/${authorModel.id}/fields`, {
      label: "Name",
      apiKey: "name",
      fieldType: "string",
    });

    const categoryModelRes = await jsonRequest(fetchHandler, "POST", "/api/models", {
      name: "Category",
      apiKey: "category",
    });
    const categoryModel = await categoryModelRes.json();
    await jsonRequest(fetchHandler, "POST", `/api/models/${categoryModel.id}/fields`, {
      label: "Name",
      apiKey: "name",
      fieldType: "string",
    });
    await jsonRequest(fetchHandler, "POST", `/api/models/${categoryModel.id}/fields`, {
      label: "Slug",
      apiKey: "slug",
      fieldType: "string",
    });

    const codeBlockModelRes = await jsonRequest(fetchHandler, "POST", "/api/models", {
      name: "Code Block",
      apiKey: "code_block",
      isBlock: true,
    });
    const codeBlockModel = await codeBlockModelRes.json();
    for (const apiKey of ["language", "filename", "code"]) {
      await jsonRequest(fetchHandler, "POST", `/api/models/${codeBlockModel.id}/fields`, {
        label: apiKey,
        apiKey,
        fieldType: "string",
      });
    }

    const featureCardModelRes = await jsonRequest(fetchHandler, "POST", "/api/models", {
      name: "Feature Card",
      apiKey: "feature_card",
      isBlock: true,
    });
    const featureCardModel = await featureCardModelRes.json();
    await jsonRequest(fetchHandler, "POST", `/api/models/${featureCardModel.id}/fields`, {
      label: "Title",
      apiKey: "title",
      fieldType: "string",
    });
    await jsonRequest(fetchHandler, "POST", `/api/models/${featureCardModel.id}/fields`, {
      label: "Description",
      apiKey: "description",
      fieldType: "string",
    });
    await jsonRequest(fetchHandler, "POST", `/api/models/${featureCardModel.id}/fields`, {
      label: "Details",
      apiKey: "details",
      fieldType: "structured_text",
      validators: { structured_text_blocks: ["code_block"] },
    });

    const featureGridModelRes = await jsonRequest(fetchHandler, "POST", "/api/models", {
      name: "Feature Grid",
      apiKey: "feature_grid",
      isBlock: true,
    });
    const featureGridModel = await featureGridModelRes.json();
    await jsonRequest(fetchHandler, "POST", `/api/models/${featureGridModel.id}/fields`, {
      label: "Heading",
      apiKey: "heading",
      fieldType: "string",
    });
    await jsonRequest(fetchHandler, "POST", `/api/models/${featureGridModel.id}/fields`, {
      label: "Features",
      apiKey: "features",
      fieldType: "structured_text",
      validators: { structured_text_blocks: ["feature_card"] },
    });

    const postModelRes = await jsonRequest(fetchHandler, "POST", "/api/models", {
      name: "Post",
      apiKey: "post",
    });
    const postModel = await postModelRes.json();
    for (const field of [
      { label: "Title", apiKey: "title", fieldType: "string" },
      { label: "Slug", apiKey: "slug", fieldType: "string" },
      { label: "Excerpt", apiKey: "excerpt", fieldType: "text" },
      { label: "Reading Time", apiKey: "reading_time", fieldType: "integer" },
      { label: "Featured", apiKey: "featured", fieldType: "boolean" },
      { label: "Content", apiKey: "content", fieldType: "structured_text", validators: { structured_text_blocks: ["feature_grid", "code_block"] } },
      { label: "Author", apiKey: "author", fieldType: "link", validators: { item_item_type: ["author"] } },
      { label: "Category", apiKey: "category", fieldType: "link", validators: { item_item_type: ["category"] } },
    ]) {
      await jsonRequest(fetchHandler, "POST", `/api/models/${postModel.id}/fields`, field);
    }

    const authorRes = await jsonRequest(fetchHandler, "POST", "/api/records", {
      modelApiKey: "author",
      data: { name: "Jane Doe" },
    });
    const author = await authorRes.json();

    const categoryRes = await jsonRequest(fetchHandler, "POST", "/api/records", {
      modelApiKey: "category",
      data: { name: "Engineering", slug: "engineering" },
    });
    const category = await categoryRes.json();

    await jsonRequest(fetchHandler, "POST", "/api/records", {
      modelApiKey: "post",
      data: {
        title: "Beyond Keyword Matching",
        slug: "beyond-keyword-matching",
        excerpt: "Structured execution test",
        reading_time: 7,
        featured: true,
        author: author.id,
        category: category.id,
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                { type: "block", item: "grid_1" },
                { type: "block", item: "code_1" },
              ],
            },
          },
          blocks: {
            grid_1: {
              _type: "feature_grid",
              heading: "Key Concepts",
              features: {
                value: {
                  schema: "dast",
                  document: {
                    type: "root",
                    children: [{ type: "block", item: "card_1" }],
                  },
                },
                blocks: {
                  card_1: {
                    _type: "feature_card",
                    title: "Workers",
                    description: "Edge compute",
                    details: {
                      value: {
                        schema: "dast",
                        document: {
                          type: "root",
                          children: [{ type: "block", item: "nested_code_1" }],
                        },
                      },
                      blocks: {
                        nested_code_1: {
                          _type: "code_block",
                          language: "typescript",
                          filename: "worker.ts",
                          code: "export default {}",
                        },
                      },
                    },
                  },
                },
              },
            },
            code_1: {
              _type: "code_block",
              language: "sql",
              filename: "query.sql",
              code: "select 1",
            },
          },
        },
      },
    });

    const result = await execute(
      `query DeepWithLinks($slug: String!) {
        post(filter: { slug: { eq: $slug } }) {
          id
          title
          slug
          excerpt
          readingTime
          featured
          author { id name }
          category { id name slug }
          content {
            value
            blocks {
              __typename
              ... on FeatureGridRecord {
                id
                heading
                features {
                  value
                  blocks {
                    __typename
                    ... on FeatureCardRecord {
                      id
                      title
                      description
                      details {
                        value
                        blocks {
                          __typename
                          ... on CodeBlockRecord {
                            id
                            language
                            filename
                            code
                          }
                        }
                      }
                    }
                  }
                }
              }
              ... on CodeBlockRecord {
                id
                language
                filename
                code
              }
            }
          }
        }
      }`,
      { slug: "beyond-keyword-matching" },
      { includeDrafts: true }
    );

    expect(result.errors).toBeUndefined();
    expect(getTracePath(result)).toBe("custom");
    expect(result.data).toEqual({
      post: {
        id: expect.any(String),
        title: "Beyond Keyword Matching",
        slug: "beyond-keyword-matching",
        excerpt: "Structured execution test",
        readingTime: 7,
        featured: true,
        author: {
          id: author.id,
          name: "Jane Doe",
        },
        category: {
          id: category.id,
          name: "Engineering",
          slug: "engineering",
        },
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                { type: "block", item: "grid_1" },
                { type: "block", item: "code_1" },
              ],
            },
          },
          blocks: [
            {
              __typename: "FeatureGridRecord",
              id: "grid_1",
              heading: "Key Concepts",
              features: {
                value: {
                  schema: "dast",
                  document: {
                    type: "root",
                    children: [{ type: "block", item: "card_1" }],
                  },
                },
                blocks: [
                  {
                    __typename: "FeatureCardRecord",
                    id: "card_1",
                    title: "Workers",
                    description: "Edge compute",
                    details: {
                      value: {
                        schema: "dast",
                        document: {
                          type: "root",
                          children: [{ type: "block", item: "nested_code_1" }],
                        },
                      },
                      blocks: [
                        {
                          __typename: "CodeBlockRecord",
                          id: "nested_code_1",
                          language: "typescript",
                          filename: "worker.ts",
                          code: "export default {}",
                        },
                      ],
                    },
                  },
                ],
              },
            },
            {
              __typename: "CodeBlockRecord",
              id: "code_1",
              language: "sql",
              filename: "query.sql",
              code: "select 1",
            },
          ],
        },
      },
    });

    const listResult = await execute(
      `query DeepList($first: Int) {
        allPosts(first: $first) {
          id
          title
          slug
          author { id name }
          category { id name slug }
          content {
            value
            blocks {
              __typename
              ... on FeatureGridRecord {
                id
                heading
                features {
                  value
                  blocks {
                    __typename
                    ... on FeatureCardRecord {
                      id
                      title
                      description
                      details {
                        value
                        blocks {
                          __typename
                          ... on CodeBlockRecord {
                            id
                            language
                            filename
                            code
                          }
                        }
                      }
                    }
                  }
                }
              }
              ... on CodeBlockRecord {
                id
                language
                filename
                code
              }
            }
          }
        }
      }`,
      { first: 10 },
      { includeDrafts: true }
    );

    expect(listResult.errors).toBeUndefined();
    expect(getTracePath(listResult)).toBe("custom");
    expect(listResult.data).toEqual({
      allPosts: [expect.objectContaining({
        title: "Beyond Keyword Matching",
        slug: "beyond-keyword-matching",
      })],
    });
  });
});
