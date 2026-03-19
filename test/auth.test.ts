import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { runMigrations } from "./migrate.js";
import { createWebHandler } from "../src/http/router.js";
import * as TokenService from "../src/services/token-service.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function createAuthTestApp(writeKey?: string) {
  const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-auth-"));
  const dbPath = join(tmpDir, "test.db");
  const sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });
  Effect.runSync(runMigrations().pipe(Effect.provide(sqlLayer)));
  const webHandler = createWebHandler(sqlLayer, { writeKey });
  return { handler: webHandler.fetch, sqlLayer };
}

function gqlRequest(handler: (req: Request) => Promise<Response>, headers?: Record<string, string>) {
  return handler(new Request("http://localhost/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ query: "{ _site { locales } }" }),
  }));
}

async function insertExpiredEditorToken(sqlLayer: ReturnType<typeof createAuthTestApp>["sqlLayer"]) {
  const token = "etk_expired_editor_token";
  const id = TokenService.EditorTokenHelpers.generateTokenId();
  const tokenPrefix = TokenService.EditorTokenHelpers.getTokenPrefix(token);
  const secretHash = await Effect.runPromise(TokenService.EditorTokenHelpers.hashToken(token));
  const expiresAt = new Date(Date.now() - 1_000).toISOString();
  const createdAt = new Date(Date.now() - 60_000).toISOString();

  await Effect.runPromise(Effect.gen(function* () {
    const sql = yield* SqliteClient.SqliteClient;
    yield* sql.unsafe(
      `INSERT INTO editor_tokens (id, name, token_prefix, secret_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, "expired", tokenPrefix, secretHash, createdAt, expiresAt]
    );
  }).pipe(Effect.provide(sqlLayer)));

  return { id, token };
}

describe("API key auth", () => {
  describe("no keys configured (local dev)", () => {
    it("allows all requests without auth", async () => {
      const { handler } = createAuthTestApp();
      const res = await handler(new Request("http://localhost/api/models"));
      expect(res.status).toBe(200);
    });

    it("GraphQL respects X-Include-Drafts in dev mode", async () => {
      const { handler } = createAuthTestApp();
      const res = await gqlRequest(handler, { "X-Include-Drafts": "true" });
      expect(res.status).toBe(200);
    });
  });

  describe("with writeKey configured", () => {
    let handler: (req: Request) => Promise<Response>;
    let sqlLayer: ReturnType<typeof createAuthTestApp>["sqlLayer"];

    beforeEach(() => {
      ({ handler, sqlLayer } = createAuthTestApp("write-key-456"));
    });

    it("health endpoint needs no auth", async () => {
      const res = await handler(new Request("http://localhost/health"));
      expect(res.status).toBe(200);
    });

    it("GraphiQL (GET /graphql) needs no auth", async () => {
      const res = await handler(new Request("http://localhost/graphql"));
      expect(res.status).toBe(200);
    });

    it("GraphQL POST needs no auth", async () => {
      const res = await gqlRequest(handler);
      expect(res.status).toBe(200);
    });

    it("REST write rejected without key", async () => {
      const res = await handler(new Request("http://localhost/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test", apiKey: "test" }),
      }));
      expect(res.status).toBe(401);
    });

    it("REST write allowed with write key", async () => {
      const res = await handler(new Request("http://localhost/api/models", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer write-key-456",
        },
        body: JSON.stringify({ name: "Test", apiKey: "test" }),
      }));
      expect(res.status).toBe(201);
    });

    it("MCP rejected without write key", async () => {
      const res = await handler(new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
        }),
      }));
      expect(res.status).toBe(401);
    });

    it("MCP allowed with write key", async () => {
      const res = await handler(new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "Authorization": "Bearer write-key-456",
        },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
        }),
      }));
      expect(res.status).toBe(200);
    });

    it("MCP rejected with editor token (admin only)", async () => {
      const token = await Effect.runPromise(
        TokenService.createEditorToken({ name: "test-editor" }).pipe(Effect.provide(sqlLayer))
      );
      const res = await handler(new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "Authorization": `Bearer ${token.token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
        }),
      }));
      expect(res.status).toBe(401);
    });

    it("chat endpoint rejected without write key", async () => {
      const res = await handler(new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [] }),
      }));
      expect(res.status).toBe(401);
    });

    it("chat endpoint allowed through auth layer and returns 501 without AI binding", async () => {
      const res = await handler(new Request("http://localhost/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer write-key-456",
        },
        body: JSON.stringify({ messages: [] }),
      }));
      expect(res.status).toBe(501);
      const body = await res.json();
      expect(body.error).toContain("AI binding not configured");
    });

    // --- Editor token auth ---

    it("editor token allows REST record operations", async () => {
      const token = await Effect.runPromise(
        TokenService.createEditorToken({ name: "editor" }).pipe(Effect.provide(sqlLayer))
      );
      const res = await handler(new Request("http://localhost/api/models", {
        headers: { Authorization: `Bearer ${token.token}` },
      }));
      expect(res.status).toBe(200);
    });

    it("editor token rejected for schema mutations", async () => {
      const token = await Effect.runPromise(
        TokenService.createEditorToken({ name: "editor" }).pipe(Effect.provide(sqlLayer))
      );
      const res = await handler(new Request("http://localhost/api/models", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token.token}`,
        },
        body: JSON.stringify({ name: "Test", apiKey: "test" }),
      }));
      expect(res.status).toBe(401);
    });

    it("editor token rejected for token management", async () => {
      const token = await Effect.runPromise(
        TokenService.createEditorToken({ name: "editor" }).pipe(Effect.provide(sqlLayer))
      );
      const res = await handler(new Request("http://localhost/api/tokens", {
        headers: { Authorization: `Bearer ${token.token}` },
      }));
      expect(res.status).toBe(401);
    });

    it("expired editor token rejected", async () => {
      const token = await insertExpiredEditorToken(sqlLayer);
      const res = await handler(new Request("http://localhost/api/models", {
        headers: { Authorization: `Bearer ${token.token}` },
      }));
      expect(res.status).toBe(401);
    });

    it("revoked editor token rejected", async () => {
      const token = await Effect.runPromise(
        TokenService.createEditorToken({ name: "revoked" }).pipe(Effect.provide(sqlLayer))
      );
      await Effect.runPromise(
        TokenService.revokeEditorToken(token.id).pipe(Effect.provide(sqlLayer))
      );
      const res = await handler(new Request("http://localhost/api/models", {
        headers: { Authorization: `Bearer ${token.token}` },
      }));
      expect(res.status).toBe(401);
    });

    it("invalid editor token prefix rejected", async () => {
      const res = await handler(new Request("http://localhost/api/models", {
        headers: { Authorization: "Bearer etk_bogus_token_value" },
      }));
      expect(res.status).toBe(401);
    });

    // --- Forged X-Credential-Type header ---

    it("forged X-Credential-Type: admin does not grant draft access", async () => {
      // Attacker sends forged header with no valid credential
      const res = await gqlRequest(handler, {
        "X-Credential-Type": "admin",
        "X-Include-Drafts": "true",
      });
      expect(res.status).toBe(200);
      // The response should come back, but the context should have includeDrafts=false
      // We verify by checking that a draft record is NOT visible (tested below with data)
    });

    it("forged X-Credential-Type: editor does not grant draft access", async () => {
      const res = await gqlRequest(handler, {
        "X-Credential-Type": "editor",
        "X-Include-Drafts": "true",
      });
      expect(res.status).toBe(200);
    });

    // --- Token CRUD endpoints ---

    it("POST /api/tokens creates editor token", async () => {
      const res = await handler(new Request("http://localhost/api/tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer write-key-456",
        },
        body: JSON.stringify({ name: "test-token" }),
      }));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toMatch(/^etid_/);
      expect(body.token).toMatch(/^etk_/);
      expect(body.name).toBe("test-token");
    });

    it("GET /api/tokens lists tokens", async () => {
      // Create a token first
      await handler(new Request("http://localhost/api/tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer write-key-456",
        },
        body: JSON.stringify({ name: "list-test" }),
      }));

      const res = await handler(new Request("http://localhost/api/tokens", {
        headers: { "Authorization": "Bearer write-key-456" },
      }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body.some((t: { name: string }) => t.name === "list-test")).toBe(true);
    });

    it("DELETE /api/tokens/:id revokes token", async () => {
      const createRes = await handler(new Request("http://localhost/api/tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer write-key-456",
        },
        body: JSON.stringify({ name: "to-revoke" }),
      }));
      const { id } = await createRes.json();

      const deleteRes = await handler(new Request(`http://localhost/api/tokens/${id}`, {
        method: "DELETE",
        headers: { "Authorization": "Bearer write-key-456" },
      }));
      expect(deleteRes.status).toBe(200);

      // Verify it's gone
      const listRes = await handler(new Request("http://localhost/api/tokens", {
        headers: { "Authorization": "Bearer write-key-456" },
      }));
      const tokens = await listRes.json();
      expect(tokens.some((t: { id: string }) => t.id === id)).toBe(false);
    });

    it("token CRUD rejected without write key", async () => {
      const res = await handler(new Request("http://localhost/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "should-fail" }),
      }));
      expect(res.status).toBe(401);
    });
  });

  // --- Draft visibility by credential type ---

  describe("draft visibility", () => {
    let handler: (req: Request) => Promise<Response>;
    let sqlLayer: ReturnType<typeof createAuthTestApp>["sqlLayer"];
    const authHeaders = {
      "Content-Type": "application/json",
      "Authorization": "Bearer write-key-456",
    };

    beforeEach(async () => {
      ({ handler, sqlLayer } = createAuthTestApp("write-key-456"));

      // Create a draft model + field + record
      const modelRes = await handler(new Request("http://localhost/api/models", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ name: "Article", apiKey: "article", hasDraft: true }),
      }));
      const model = await modelRes.json();

      await handler(new Request(`http://localhost/api/models/${model.id}/fields`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ label: "Title", apiKey: "title", fieldType: "string" }),
      }));

      await handler(new Request("http://localhost/api/records", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ modelApiKey: "article", data: { title: "Draft Post" } }),
      }));
    });

    it("unauthenticated GraphQL does not see draft records", async () => {
      const res = await handler(new Request("http://localhost/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Include-Drafts": "true",
        },
        body: JSON.stringify({ query: "{ allArticles { title } }" }),
      }));
      const body = await res.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.allArticles).toHaveLength(0);
    });

    it("unauthenticated GraphQL with forged X-Credential-Type still does not see drafts", async () => {
      const res = await handler(new Request("http://localhost/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Credential-Type": "admin",
          "X-Include-Drafts": "true",
        },
        body: JSON.stringify({ query: "{ allArticles { title } }" }),
      }));
      const body = await res.json();
      expect(body.data.allArticles).toHaveLength(0);
    });

    it("writeKey with X-Include-Drafts sees draft records", async () => {
      const res = await handler(new Request("http://localhost/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer write-key-456",
          "X-Include-Drafts": "true",
        },
        body: JSON.stringify({ query: "{ allArticles { title } }" }),
      }));
      const body = await res.json();
      expect(body.data.allArticles).toHaveLength(1);
      expect(body.data.allArticles[0].title).toBe("Draft Post");
    });

    it("writeKey without X-Include-Drafts does not see draft records", async () => {
      const res = await handler(new Request("http://localhost/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer write-key-456",
        },
        body: JSON.stringify({ query: "{ allArticles { title } }" }),
      }));
      const body = await res.json();
      expect(body.data.allArticles).toHaveLength(0);
    });

    it("editor token always sees draft records (no header needed)", async () => {
      const token = await Effect.runPromise(
        TokenService.createEditorToken({ name: "editor" }).pipe(Effect.provide(sqlLayer))
      );
      const res = await handler(new Request("http://localhost/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token.token}`,
        },
        body: JSON.stringify({ query: "{ allArticles { title } }" }),
      }));
      const body = await res.json();
      expect(body.data.allArticles).toHaveLength(1);
      expect(body.data.allArticles[0].title).toBe("Draft Post");
    });

    it("expired editor token does not see draft records", async () => {
      const token = await insertExpiredEditorToken(sqlLayer);
      const res = await handler(new Request("http://localhost/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token.token}`,
          "X-Include-Drafts": "true",
        },
        body: JSON.stringify({ query: "{ allArticles { title } }" }),
      }));
      const body = await res.json();
      expect(body.data.allArticles).toHaveLength(0);
    });
  });
});
