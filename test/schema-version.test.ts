import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";
import { getSchemaVersion, bumpSchemaVersion } from "../src/services/schema-version.js";

async function readVersion(sqlLayer: ReturnType<typeof createTestApp>["sqlLayer"]): Promise<number> {
  return Effect.runPromise(getSchemaVersion().pipe(Effect.provide(sqlLayer)));
}

describe("shared schema_version counter", () => {
  it("increments in D1 on every schema DDL op", async () => {
    const { handler, sqlLayer } = createTestApp();

    const start = await readVersion(sqlLayer);

    // create model
    const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
    const model = await modelRes.json();
    const afterModel = await readVersion(sqlLayer);
    expect(afterModel).toBeGreaterThan(start);

    // create field
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Title",
      apiKey: "title",
      fieldType: "string",
    });
    const afterField = await readVersion(sqlLayer);
    expect(afterField).toBeGreaterThan(afterModel);

    // delete model
    await jsonRequest(handler, "DELETE", `/api/models/${model.id}`);
    const afterDelete = await readVersion(sqlLayer);
    expect(afterDelete).toBeGreaterThan(afterField);
  });

  it("bumpSchemaVersion increments the stored value", async () => {
    const { sqlLayer } = createTestApp();
    const before = await readVersion(sqlLayer);
    await Effect.runPromise(bumpSchemaVersion().pipe(Effect.provide(sqlLayer)));
    const after = await readVersion(sqlLayer);
    expect(after).toBe(before + 1);
  });

  it("rebuilds a cached schema when the shared version changes underneath it (cross-isolate simulation)", async () => {
    // Two handlers over the SAME database simulate two isolates. Handler A never
    // sees the mutation locally; it must converge via the shared schema_version.
    const { handler: handlerA, sqlLayer } = createTestApp();

    // Seed one model directly so handler A builds+caches a schema without it.
    const seed = await jsonRequest(handlerA, "POST", "/api/models", { name: "Post", apiKey: "post" });
    const post = await seed.json();
    await jsonRequest(handlerA, "POST", `/api/models/${post.id}/fields`, {
      label: "Title",
      apiKey: "title",
      fieldType: "string",
    });

    // Prime handler A's schema cache.
    const primed = await gqlQuery(handlerA, "{ allPosts { title } }");
    expect(primed.errors).toBeUndefined();

    // Simulate another isolate mutating schema: insert a new model row + table
    // directly in D1 and bump the shared version — handler A's local cache is
    // NOT invalidated, mirroring a mutation handled by a different isolate.
    await Effect.runPromise(
      Effect.gen(function* () {
        const { SqlClient } = yield* Effect.promise(() => import("@effect/sql"));
        const sql = yield* SqlClient.SqlClient;
        const now = new Date().toISOString();
        yield* sql.unsafe(
          `INSERT INTO models (id, name, api_key, is_block, singleton, sortable, tree, has_draft, all_locales_required, ordering, canonical_path_template, created_at, updated_at)
           VALUES ('m_author', 'Author', 'author', 0, 0, 0, 0, 1, 0, NULL, NULL, ?, ?)`,
          [now, now],
        );
        yield* sql.unsafe(
          `CREATE TABLE IF NOT EXISTS "content_author" ("id" TEXT PRIMARY KEY, "_status" TEXT NOT NULL DEFAULT 'draft', "_created_at" TEXT NOT NULL, "_updated_at" TEXT NOT NULL)`,
        );
        yield* bumpSchemaVersion();
      }).pipe(Effect.provide(sqlLayer)),
    );

    // Within TTL the stale schema may still be served, so poll until convergence.
    // The version check must flip handler A onto the new schema within ~TTL.
    let sawAuthor = false;
    for (let i = 0; i < 40; i++) {
      const res = await gqlQuery(handlerA, "{ allAuthors { id } }");
      if (!res.errors) {
        sawAuthor = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(sawAuthor).toBe(true);
  });
});
