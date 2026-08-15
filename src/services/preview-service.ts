/**
 * Preview token service — short-lived tokens for draft preview access.
 * Follows the same SHA-256 hashing pattern as token-service.ts.
 */
import { DateTime, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { generateId } from "../id.js";
import { ValidationError } from "../errors.js";
import { stringifyTemplateValue } from "../dynamic/row-types.js";

function hashToken(token: string) {
  return Effect.tryPromise({
    try: async () => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    },
    catch: (cause) => new ValidationError({
      message: `Failed to hash preview token: ${cause instanceof Error ? cause.message : String(cause)}`,
    }),
  });
}

function generatePreviewToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // base64url encode
  const base64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return `pvt_${base64}`;
}

const DEFAULT_EXPIRY_SECONDS = 24 * 60 * 60; // 24 hours

export const createPreviewToken = Effect.fn("createPreviewToken")(function* (expiresIn?: number) {
  const sql = yield* SqlClient.SqlClient;
  const seconds = expiresIn ?? DEFAULT_EXPIRY_SECONDS;
  if (seconds <= 0) {
    return yield* new ValidationError({ message: "expiresIn must be a positive number" });
  }
  const id = generateId();
  const token = generatePreviewToken();
  const tokenHash = yield* hashToken(token);
  const expiresAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { seconds }));

  yield* sql.unsafe(
    `INSERT INTO preview_tokens (id, token_hash, expires_at) VALUES (?, ?, ?)`,
    [id, tokenHash, expiresAt]
  );

  return { id, token, expiresAt };
});

export const validatePreviewToken = Effect.fn("validatePreviewToken")(function* (token: string) {
  const sql = yield* SqlClient.SqlClient;
  const tokenHash = yield* hashToken(token);
  const rows = yield* sql.unsafe<{ id: string; expires_at: string }>(
    "SELECT id, expires_at FROM preview_tokens WHERE token_hash = ?",
    [tokenHash]
  );

  if (rows.length === 0) {
    return { valid: false as const };
  }

  const row = rows[0];
  if (new Date(row.expires_at) < new Date()) {
    return { valid: false as const };
  }

  // Fire-and-forget cleanup of expired tokens.
  // Bind the comparison value from JS (ISO 8601, e.g. "2026-07-29T12:00:00.000Z")
  // instead of comparing against SQLite's datetime('now') (e.g. "2026-07-29 12:00:00").
  // Both columns are TEXT, so this was a lexicographic comparison that disagreed at the
  // date/time separator (`T` vs space) — expired tokens were never reaped on the day
  // they expired. Note: the `datetime('now')` DEFAULT clauses in src/migrations.ts are
  // never compared against anything, so that space-separated format is cosmetic only;
  // left untouched there because versioned migration SQL must stay byte-stable.
  yield* Effect.forkChild(
    sql.unsafe(
      `DELETE FROM preview_tokens WHERE id IN (SELECT id FROM preview_tokens WHERE expires_at < ? LIMIT 100)`,
      [DateTime.formatIso(yield* DateTime.now)]
    ).pipe(Effect.ignore)
  );

  return { valid: true as const, expiresAt: row.expires_at };
});

export function resolvePreviewPath(
  canonicalPathTemplate: string,
  recordData: Record<string, unknown>,
): string {
  return canonicalPathTemplate.replace(/\{([^}]+)\}/g, (_match, fieldName: string) => {
    const value = stringifyTemplateValue(recordData[fieldName]);
    return value === null ? "" : encodeURIComponent(value);
  });
}
