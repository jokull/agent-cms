/**
 * Preview token service — short-lived tokens for draft preview access.
 * Follows the same SHA-256 hashing pattern as token-service.ts.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { generateId } from "../id.js";
import { ValidationError } from "../errors.js";

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

export function createPreviewToken(expiresIn?: number) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const seconds = expiresIn ?? DEFAULT_EXPIRY_SECONDS;
    if (seconds <= 0) {
      return yield* new ValidationError({ message: "expiresIn must be a positive number" });
    }
    const id = generateId();
    const token = generatePreviewToken();
    const tokenHash = yield* hashToken(token);
    const expiresAt = new Date(Date.now() + seconds * 1000).toISOString();

    yield* sql.unsafe(
      `INSERT INTO preview_tokens (id, token_hash, expires_at) VALUES (?, ?, ?)`,
      [id, tokenHash, expiresAt]
    );

    return { id, token, expiresAt };
  });
}

export function validatePreviewToken(token: string) {
  return Effect.gen(function* () {
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

    // Fire-and-forget cleanup of expired tokens
    yield* Effect.fork(
      sql.unsafe(
        `DELETE FROM preview_tokens WHERE id IN (SELECT id FROM preview_tokens WHERE expires_at < datetime('now') LIMIT 100)`
      ).pipe(Effect.ignore)
    );

    return { valid: true as const, expiresAt: row.expires_at };
  });
}

export function resolvePreviewPath(
  canonicalPathTemplate: string,
  recordData: Record<string, unknown>,
): string {
  return canonicalPathTemplate.replace(/\{([^}]+)\}/g, (_match, fieldName: string) => {
    const value = recordData[fieldName];
    if (value === undefined || value === null) return "";
    return encodeURIComponent(String(value));
  });
}
