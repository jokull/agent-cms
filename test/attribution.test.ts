import { beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "./migrate.js";
import { createWebHandler } from "../src/http/router.js";
import * as TokenService from "../src/services/token-service.js";

function createAttributionTestApp() {
  const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-attribution-"));
  const dbPath = join(tmpDir, "test.db");
  const sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });
  Effect.runSync(runMigrations().pipe(Effect.provide(sqlLayer)));
  return {
    sqlLayer,
    handler: createWebHandler(sqlLayer, { writeKey: "write-key" }).fetch,
  };
}

async function jsonRequest(
  handler: (req: Request) => Promise<Response>,
  method: string,
  path: string,
  options?: {
    body?: unknown;
    headers?: Record<string, string>;
  },
) {
  return handler(new Request(`http://localhost${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
  }));
}

async function gqlRequest(
  handler: (req: Request) => Promise<Response>,
  query: string,
  headers?: Record<string, string>,
) {
  const response = await handler(new Request("http://localhost/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ query }),
  }));
  return response.json() as Promise<{ data?: Record<string, unknown>; errors?: unknown[] }>;
}

describe("record attribution", () => {
  let handler: (req: Request) => Promise<Response>;
  let sqlLayer: ReturnType<typeof createAttributionTestApp>["sqlLayer"];

  beforeEach(() => {
    ({ handler, sqlLayer } = createAttributionTestApp());
  });

  it("tracks editor token attribution on current rows and auto-republish versions", async () => {
    const editorToken = await Effect.runPromise(
      TokenService.createEditorToken({ name: "Pigeon Editor" }).pipe(Effect.provide(sqlLayer))
    );

    const model = await jsonRequest(handler, "POST", "/api/models", {
      headers: { Authorization: "Bearer write-key" },
      body: { name: "Note", apiKey: "note", hasDraft: false },
    }).then((response) => response.json() as Promise<{ id: string }>);

    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      headers: { Authorization: "Bearer write-key" },
      body: { label: "Title", apiKey: "title", fieldType: "string" },
    });

    const created = await jsonRequest(handler, "POST", "/api/records", {
      headers: { Authorization: `Bearer ${editorToken.token}` },
      body: { modelApiKey: "note", data: { title: "Initial sighting" } },
    }).then((response) => response.json() as Promise<Record<string, unknown>>);

    expect(created._created_by).toBe("Pigeon Editor");
    expect(created._updated_by).toBe("Pigeon Editor");
    expect(created._published_by).toBe("Pigeon Editor");

    const updated = await jsonRequest(handler, "PATCH", `/api/records/${created.id}`, {
      headers: { Authorization: `Bearer ${editorToken.token}` },
      body: { modelApiKey: "note", data: { title: "Revised sighting" } },
    }).then((response) => response.json() as Promise<Record<string, unknown>>);

    expect(updated._updated_by).toBe("Pigeon Editor");
    expect(updated._published_by).toBe("Pigeon Editor");

    const versions = await jsonRequest(
      handler,
      "GET",
      `/api/records/${created.id}/versions?modelApiKey=note`,
      { headers: { Authorization: `Bearer ${editorToken.token}` } },
    ).then((response) => response.json() as Promise<Array<Record<string, unknown>>>);

    expect(versions).toHaveLength(1);
    expect(versions[0]?.action).toBe("auto_republish");
    expect(versions[0]?.actor_type).toBe("editor");
    expect(versions[0]?.actor_label).toBe("Pigeon Editor");
    expect(versions[0]?.actor_token_id).toBe(editorToken.id);
    expect((versions[0]?.snapshot as Record<string, unknown>).title).toBe("Initial sighting");

    const gql = await gqlRequest(
      handler,
      "{ allNotes { title _createdBy _updatedBy _publishedBy } }",
      { Authorization: `Bearer ${editorToken.token}` },
    );

    expect(gql.errors).toBeUndefined();
    expect(gql.data?.allNotes).toEqual([
      {
        title: "Revised sighting",
        _createdBy: "Pigeon Editor",
        _updatedBy: "Pigeon Editor",
        _publishedBy: "Pigeon Editor",
      },
    ]);
  });

  it("tracks admin attribution on publish versions", async () => {
    const model = await jsonRequest(handler, "POST", "/api/models", {
      headers: { Authorization: "Bearer write-key" },
      body: { name: "Post", apiKey: "post" },
    }).then((response) => response.json() as Promise<{ id: string }>);

    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      headers: { Authorization: "Bearer write-key" },
      body: { label: "Title", apiKey: "title", fieldType: "string" },
    });

    const created = await jsonRequest(handler, "POST", "/api/records", {
      headers: { Authorization: "Bearer write-key" },
      body: { modelApiKey: "post", data: { title: "Original title" } },
    }).then((response) => response.json() as Promise<Record<string, unknown>>);

    await jsonRequest(handler, "POST", `/api/records/${created.id}/publish?modelApiKey=post`, {
      headers: { Authorization: "Bearer write-key" },
    });

    await jsonRequest(handler, "PATCH", `/api/records/${created.id}`, {
      headers: { Authorization: "Bearer write-key" },
      body: { modelApiKey: "post", data: { title: "Draft revision" } },
    });

    const published = await jsonRequest(handler, "POST", `/api/records/${created.id}/publish?modelApiKey=post`, {
      headers: { Authorization: "Bearer write-key" },
    }).then((response) => response.json() as Promise<Record<string, unknown>>);

    expect(published._updated_by).toBe("admin");
    expect(published._published_by).toBe("admin");

    const versions = await jsonRequest(
      handler,
      "GET",
      `/api/records/${created.id}/versions?modelApiKey=post`,
      { headers: { Authorization: "Bearer write-key" } },
    ).then((response) => response.json() as Promise<Array<Record<string, unknown>>>);

    expect(versions).toHaveLength(1);
    expect(versions[0]?.action).toBe("publish");
    expect(versions[0]?.actor_type).toBe("admin");
    expect(versions[0]?.actor_label).toBe("admin");
    expect((versions[0]?.snapshot as Record<string, unknown>).title).toBe("Original title");
  });
});
