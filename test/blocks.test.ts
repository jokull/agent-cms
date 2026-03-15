import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { createTestApp, jsonRequest } from "./app-helpers.js";

describe("Block types", () => {
  let handler: (req: Request) => Promise<Response>;
  let sqlLayer: any;

  beforeEach(() => {
    ({ handler, sqlLayer } = createTestApp());
  });

  it("creates a block type model with block_ table prefix", async () => {
    const res = await jsonRequest(handler, "POST", "/api/models", {
      name: "Hero Section",
      apiKey: "hero_section",
      isBlock: true,
    });
    expect(res.status).toBe(201);
    const model = await res.json();
    expect(model.isBlock).toBe(true);

    // Verify block table exists with ownership columns
    const cols = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe<{ name: string }>('PRAGMA table_info("block_hero_section")');
      }).pipe(Effect.provide(sqlLayer))
    );
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("_root_record_id");
    expect(colNames).toContain("_root_field_api_key");
    // Should NOT have content table columns
    expect(colNames).not.toContain("_status");
    expect(colNames).not.toContain("_published_snapshot");
  });

  it("adds fields to a block type", async () => {
    const modelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Hero Section",
      apiKey: "hero_section",
      isBlock: true,
    });
    const model = await modelRes.json();

    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Headline", apiKey: "headline", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "CTA URL", apiKey: "cta_url", fieldType: "string",
    });

    const cols = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe<{ name: string }>('PRAGMA table_info("block_hero_section")');
      }).pipe(Effect.provide(sqlLayer))
    );
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("headline");
    expect(colNames).toContain("cta_url");
  });

  it("prevents creating records directly for block types", async () => {
    const modelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Hero Section",
      apiKey: "hero_section",
      isBlock: true,
    });

    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "hero_section",
      data: { headline: "Welcome" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("block");
  });
});
