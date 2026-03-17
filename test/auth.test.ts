import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { runMigrations } from "./migrate.js";
import { createWebHandler } from "../src/http/router.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function createAuthTestApp(readKey?: string, writeKey?: string) {
  const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-auth-"));
  const dbPath = join(tmpDir, "test.db");
  const sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });
  Effect.runSync(runMigrations().pipe(Effect.provide(sqlLayer)));
  const webHandler = createWebHandler(sqlLayer, { readKey, writeKey });
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

  describe("with keys configured", () => {
    let handler: (req: Request) => Promise<Response>;

    beforeEach(() => {
      handler = createAuthTestApp("read-key-123", "write-key-456");
    });

    it("health endpoint needs no auth", async () => {
      const res = await handler(new Request("http://localhost/health"));
      expect(res.status).toBe(200);
    });

    it("GraphiQL (GET /graphql) needs no auth", async () => {
      const res = await handler(new Request("http://localhost/graphql"));
      // Yoga returns 200 with HTML for GET requests (GraphiQL)
      expect(res.status).toBe(200);
    });

    it("GraphQL POST rejected without key", async () => {
      const res = await handler(new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ _site { locales } }" }),
      }));
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain("Unauthorized");
    });

    it("GraphQL POST allowed with read key", async () => {
      const res = await handler(new Request("http://localhost/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer read-key-123",
        },
        body: JSON.stringify({ query: "{ _site { locales } }" }),
      }));
      expect(res.status).toBe(200);
    });

    it("GraphQL POST allowed with write key (write grants read)", async () => {
      const res = await handler(new Request("http://localhost/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer write-key-456",
        },
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

    it("REST write rejected with read key", async () => {
      const res = await handler(new Request("http://localhost/api/models", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer read-key-123",
        },
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
  });
});
