import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { createWebHandler } from "../src/http/router.js";
import { runMigrations } from "./migrate.js";
import { jsonRequest } from "./app-helpers.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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
});
