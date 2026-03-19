import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runMigrations } from "./migrate.js";
import { createWebHandler } from "../src/http/router.js";

function createSqlMigrationApp(writeKey: string = "write-key") {
  const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-editor-token-sql-"));
  const dbPath = join(tmpDir, "test.db");
  const sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });
  Effect.runSync(runMigrations().pipe(Effect.provide(sqlLayer)));
  return {
    handler: createWebHandler(sqlLayer, { writeKey }).fetch,
    sqlLayer,
  };
}

async function createEditorToken(
  handler: (req: Request) => Promise<Response>,
  body: { name: string; expiresIn?: number },
) {
  const response = await handler(new Request("http://localhost/api/tokens", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer write-key",
    },
    body: JSON.stringify(body),
  }));
  return {
    response,
    json: await response.json() as {
      id: string;
      token: string;
      tokenPrefix: string;
      name: string;
      createdAt: string;
      expiresAt: string | null;
    },
  };
}

describe("editor tokens", () => {
  it("creates tokens via SQL migrations and lists only redacted metadata", async () => {
    const { handler } = createSqlMigrationApp();

    const created = await createEditorToken(handler, { name: "Preview", expiresIn: 60 });
    expect(created.response.status).toBe(201);
    expect(created.json.id.startsWith("etid_")).toBe(true);
    expect(created.json.token.startsWith("etk_")).toBe(true);
    expect(created.json.tokenPrefix).toBe(created.json.token.slice(0, 12));

    const listResponse = await handler(new Request("http://localhost/api/tokens", {
      headers: { Authorization: "Bearer write-key" },
    }));
    expect(listResponse.status).toBe(200);
    const listed = await listResponse.json() as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(created.json.id);
    expect(listed[0].token_prefix).toBe(created.json.tokenPrefix);
    expect("token" in listed[0]).toBe(false);
  });

  it("allows content writes with an editor token but rejects schema mutations", async () => {
    const { handler } = createSqlMigrationApp();

    const createModelResponse = await handler(new Request("http://localhost/api/models", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer write-key",
      },
      body: JSON.stringify({ name: "Post", apiKey: "post" }),
    }));
    const model = await createModelResponse.json() as { id: string };

    const createFieldResponse = await handler(new Request(`http://localhost/api/models/${model.id}/fields`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer write-key",
      },
      body: JSON.stringify({ label: "Title", apiKey: "title", fieldType: "string" }),
    }));
    expect(createFieldResponse.status).toBe(201);

    const created = await createEditorToken(handler, { name: "Editor", expiresIn: 60 });

    const createRecordResponse = await handler(new Request("http://localhost/api/records", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${created.json.token}`,
      },
      body: JSON.stringify({ modelApiKey: "post", data: { title: "Draft post" } }),
    }));
    expect(createRecordResponse.status).toBe(201);

    const schemaMutationResponse = await handler(new Request("http://localhost/api/models", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${created.json.token}`,
      },
      body: JSON.stringify({ name: "Category", apiKey: "category" }),
    }));
    expect(schemaMutationResponse.status).toBe(401);
  });

  it("rejects zero-second expiry for REST token creation", async () => {
    const { handler } = createSqlMigrationApp();

    const created = await createEditorToken(handler, { name: "Bad token", expiresIn: 0 });
    expect(created.response.status).toBe(400);
    expect((created.json as { error: string }).error).toContain("Expected a positive number, actual 0");
  });

});
