import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { NotFoundError, UnauthorizedError, ValidationError } from "../errors.js";
import type { EditorTokenRow, StoredEditorTokenRow } from "../db/row-types.js";

function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("");
  return `etk_${chars}`;
}

function generateTokenId(): string {
  return `etid_${crypto.randomUUID()}`;
}

function getTokenPrefix(token: string): string {
  return token.slice(0, 12);
}

function isLegacyStoredToken(row: StoredEditorTokenRow): boolean {
  return row.secret_hash === null;
}

function hashToken(token: string) {
  return Effect.tryPromise({
    try: async () => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    },
    catch: (cause) => new ValidationError({
      message: `Failed to hash editor token: ${cause instanceof Error ? cause.message : String(cause)}`,
    }),
  });
}

export function createEditorToken(input: { name: string; expiresIn?: number }) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const token = generateToken();
    const id = generateTokenId();
    const now = new Date().toISOString();
    const expiresIn = input.expiresIn;
    if (expiresIn !== undefined && expiresIn <= 0) {
      return yield* new ValidationError({ message: "expiresIn must be a positive integer" });
    }
    const expiresAt = expiresIn !== undefined
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : null;
    const tokenPrefix = getTokenPrefix(token);
    const secretHash = yield* hashToken(token);

    yield* sql.unsafe(
      `INSERT INTO editor_tokens (id, name, token_prefix, secret_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, input.name, tokenPrefix, secretHash, now, expiresAt]
    );

    return { id, token, tokenPrefix, name: input.name, createdAt: now, expiresAt };
  });
}

export function listEditorTokens() {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = new Date().toISOString();
    return yield* sql.unsafe<EditorTokenRow>(
      `SELECT id, name, token_prefix, created_at, last_used_at, expires_at
       FROM editor_tokens
       WHERE expires_at IS NULL OR expires_at > ?
       ORDER BY created_at DESC`,
      [now]
    );
  });
}

export function revokeEditorToken(id: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const existing = yield* sql.unsafe<{ id: string }>(
      "SELECT id FROM editor_tokens WHERE id = ?", [id]
    );
    if (existing.length === 0) {
      return yield* new NotFoundError({ entity: "EditorToken", id });
    }
    yield* sql.unsafe("DELETE FROM editor_tokens WHERE id = ?", [id]);
    return { ok: true };
  });
}

export function validateEditorToken(token: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const secretHash = yield* hashToken(token);
    const hashedRows = yield* sql.unsafe<StoredEditorTokenRow>(
      "SELECT * FROM editor_tokens WHERE secret_hash = ?",
      [secretHash]
    );
    const legacyRows = hashedRows.length === 0
      ? yield* sql.unsafe<StoredEditorTokenRow>(
        "SELECT * FROM editor_tokens WHERE id = ?",
        [token]
      )
      : [];
    if (hashedRows.length === 0 && legacyRows.length === 0) {
      return yield* new UnauthorizedError({ message: "Invalid editor token" });
    }
    const row = hashedRows[0] ?? legacyRows[0];
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return yield* new UnauthorizedError({ message: "Editor token has expired" });
    }
    const now = new Date().toISOString();
    yield* sql.unsafe(
      "UPDATE editor_tokens SET last_used_at = ? WHERE id = ?",
      [now, row.id]
    );
    if (isLegacyStoredToken(row)) {
      return {
        id: row.id,
        name: row.name,
        token_prefix: getTokenPrefix(token),
        created_at: row.created_at,
        last_used_at: now,
        expires_at: row.expires_at,
      } satisfies EditorTokenRow;
    }
    return row;
  });
}

export const EditorTokenHelpers = {
  generateTokenId,
  getTokenPrefix,
  hashToken,
};
