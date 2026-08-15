import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { createTestApp } from "./app-helpers.js";
import { createPreviewToken, validatePreviewToken } from "../src/services/preview-service.js";

describe("preview token reaping (#57)", () => {
  it("deletes a just-expired token instead of waiting for the UTC date to roll over", async () => {
    const { sqlLayer } = createTestApp();

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        // Insert an already-expired token (expired a few seconds ago) and a valid one,
        // written in the same ISO format createPreviewToken uses.
        const expiredAt = new Date(Date.now() - 5_000).toISOString();
        const validAt = new Date(Date.now() + 60_000).toISOString();
        yield* sql.unsafe(
          `INSERT INTO preview_tokens (id, token_hash, expires_at) VALUES (?, ?, ?)`,
          ["expired_1", "hash_expired", expiredAt]
        );
        yield* sql.unsafe(
          `INSERT INTO preview_tokens (id, token_hash, expires_at) VALUES (?, ?, ?)`,
          ["valid_1", "hash_valid", validAt]
        );

        // Trigger the fire-and-forget cleanup path: it only fires once a token has been
        // successfully validated, so create and validate a genuinely valid token first.
        const created = yield* createPreviewToken(60);
        const result = yield* validatePreviewToken(created.token);
        expect(result.valid).toBe(true);

        // The cleanup is forked; give it a tick to run before asserting.
        yield* Effect.sleep("50 millis");

        const remaining = yield* sql.unsafe<{ id: string }>(
          "SELECT id FROM preview_tokens ORDER BY id"
        );
        const remainingIds = remaining.map((r) => r.id);
        expect(remainingIds).not.toContain("expired_1");
        expect(remainingIds).toContain("valid_1");
      }).pipe(Effect.provide(sqlLayer))
    );
  });
});
