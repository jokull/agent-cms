import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { runMigrations } from "./migrate.js";
import { createWebHandler } from "../src/http/router.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function createAuthTestApp(writeKey?: string) {
  const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-auth-"));
  const dbPath = join(tmpDir, "test.db");
  const sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });
  Effect.runSync(runMigrations().pipe(Effect.provide(sqlLayer)));
  const webHandler = createWebHandler(sqlLayer, { writeKey });
  return webHandler.fetch;
}

describe("API key auth", () => {
  describe("no keys configured (local dev)", () => {
    it("allows all requests without auth", async () => {
      const handler = createAuthTestApp();
      const res = await handler(new Request("http://localhost/api/models"));
      expect(res.status).toBe(200);
    });
  });

  describe("with writeKey configured", () => {
    let handler: (req: Request) => Promise<Response>;

    beforeEach(() => {
      handler = createAuthTestApp("write-key-456");
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
      const res = await handler(new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ _site { locales } }" }),
      }));
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
  });
});
