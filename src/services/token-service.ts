import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { NotFoundError, UnauthorizedError } from "../errors.js";
import type { EditorTokenRow } from "../db/row-types.js";

function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("");
  return `etk_${chars}`;
}

export function createEditorToken(input: { name: string; expiresIn?: number }) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const token = generateToken();
    const now = new Date().toISOString();
    const expiresAt = input.expiresIn
      ? new Date(Date.now() + input.expiresIn * 1000).toISOString()
      : null;

    yield* sql.unsafe(
      `INSERT INTO editor_tokens (id, name, created_at, expires_at) VALUES (?, ?, ?, ?)`,
      [token, input.name, now, expiresAt]
    );

    return { id: token, name: input.name, createdAt: now, expiresAt };
  });
}

export function listEditorTokens() {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = new Date().toISOString();
    return yield* sql.unsafe<EditorTokenRow>(
      `SELECT * FROM editor_tokens WHERE expires_at IS NULL OR expires_at > ? ORDER BY created_at DESC`,
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
    const rows = yield* sql.unsafe<EditorTokenRow>(
      "SELECT * FROM editor_tokens WHERE id = ?", [token]
    );
    if (rows.length === 0) {
      return yield* new UnauthorizedError({ message: "Invalid editor token" });
    }
    const row = rows[0];
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return yield* new UnauthorizedError({ message: "Editor token has expired" });
    }
    const now = new Date().toISOString();
    yield* sql.unsafe(
      "UPDATE editor_tokens SET last_used_at = ? WHERE id = ?",
      [now, token]
    );
    return row;
  });
}
