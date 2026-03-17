import { describe, expect, it } from "vitest";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createWebHandler } from "../src/http/router.js";

describe("/api/setup", () => {
  it("bootstraps system tables explicitly before normal API writes", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-setup-"));
    const dbPath = join(tmpDir, "test.db");
    const sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });
    const handler = createWebHandler(sqlLayer);

    const beforeSetup = await handler(new Request("http://localhost/api/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Post", apiKey: "post" }),
    }));
    expect(beforeSetup.status).toBe(500);

    const setup = await handler(new Request("http://localhost/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }));
    expect(setup.status).toBe(200);
    await expect(setup.json()).resolves.toEqual({ ok: true });

    const createModel = await handler(new Request("http://localhost/api/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Post", apiKey: "post" }),
    }));
    expect(createModel.status).toBe(201);
    await expect(createModel.json()).resolves.toMatchObject({ apiKey: "post" });
  });
});
