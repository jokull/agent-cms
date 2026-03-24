import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { createTestApp, jsonRequest } from "./app-helpers.js";

describe("markdown + blocks persistence", () => {
  it("persists inline block field data during create_record", async () => {
    const { handler, sqlLayer } = createTestApp();

    const blockRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Code Snippet",
      apiKey: "code_snippet",
      isBlock: true,
    });
    const block = await blockRes.json();
    await jsonRequest(handler, "POST", `/api/models/${block.id}/fields`, {
      label: "Language",
      apiKey: "language",
      fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${block.id}/fields`, {
      label: "Code",
      apiKey: "code",
      fieldType: "text",
    });

    const docRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Doc",
      apiKey: "doc",
    });
    const doc = await docRes.json();
    await jsonRequest(handler, "POST", `/api/models/${doc.id}/fields`, {
      label: "Body",
      apiKey: "body",
      fieldType: "structured_text",
      validators: { structured_text_blocks: ["code_snippet"] },
    });

    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "doc",
      data: {
        body: {
          markdown: "Intro\n\n<!-- cms:block:snippet1 -->\n\nOutro",
          blocks: {
            snippet1: {
              _type: "code_snippet",
              language: "typescript",
              code: "function identity<T>(value: T): T { return value; }",
            },
          },
        },
      },
    });

    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe<Record<string, unknown>>(
          'SELECT id, language, code FROM "block_code_snippet" WHERE _root_record_id = ?',
          [created.id],
        );
      }).pipe(Effect.provide(sqlLayer)),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "snippet1",
      language: "typescript",
      code: "function identity<T>(value: T): T { return value; }",
    });
  });
});
