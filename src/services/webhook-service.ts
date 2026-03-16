/**
 * Webhook service — fires HTTP POST to registered URLs on CMS events.
 *
 * Events: record.create, record.update, record.delete, record.publish,
 *         record.unpublish, model.create, model.delete
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { ulid } from "ulidx";
import { NotFoundError, ValidationError } from "../errors.js";

export type WebhookEvent =
  | "record.create" | "record.update" | "record.delete"
  | "record.publish" | "record.unpublish"
  | "model.create" | "model.delete";

const VALID_EVENTS: readonly string[] = [
  "record.create", "record.update", "record.delete",
  "record.publish", "record.unpublish",
  "model.create", "model.delete",
];

/** Ensure the webhooks table exists (idempotent) */
export function ensureWebhooksTable() {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        events TEXT NOT NULL,
        name TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      )
    `);
  });
}

export function createWebhook(body: { url: string; events: string[]; name?: string }) {
  return Effect.gen(function* () {
    yield* ensureWebhooksTable();
    const sql = yield* SqlClient.SqlClient;

    if (!body.url || typeof body.url !== "string")
      return yield* new ValidationError({ message: "url is required" });

    for (const event of body.events) {
      if (!VALID_EVENTS.includes(event))
        return yield* new ValidationError({ message: `Invalid event: ${event}. Valid: ${VALID_EVENTS.join(", ")}` });
    }

    const id = ulid();
    const now = new Date().toISOString();

    yield* sql.unsafe(
      "INSERT INTO webhooks (id, url, events, name, active, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, body.url, JSON.stringify(body.events), body.name ?? null, 1, now]
    );

    return { id, url: body.url, events: body.events, name: body.name ?? null, active: true, createdAt: now };
  });
}

export function listWebhooks() {
  return Effect.gen(function* () {
    yield* ensureWebhooksTable();
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<Record<string, any>>("SELECT * FROM webhooks ORDER BY created_at");
    return rows.map((r) => ({
      id: r.id, url: r.url, events: JSON.parse(r.events || "[]"),
      name: r.name, active: !!r.active, createdAt: r.created_at,
    }));
  });
}

export function deleteWebhook(id: string) {
  return Effect.gen(function* () {
    yield* ensureWebhooksTable();
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<{ id: string }>("SELECT id FROM webhooks WHERE id = ?", [id]);
    if (rows.length === 0) return yield* new NotFoundError({ entity: "Webhook", id });
    yield* sql.unsafe("DELETE FROM webhooks WHERE id = ?", [id]);
    return { deleted: true };
  });
}

/**
 * Fire webhooks for a given event. Non-blocking — failures are logged, not thrown.
 * In production this would use a queue; for now, fire-and-forget fetch.
 */
export function fireWebhooks(event: WebhookEvent, payload: Record<string, unknown>) {
  return Effect.gen(function* () {
    yield* ensureWebhooksTable();
    const sql = yield* SqlClient.SqlClient;

    const webhooks = yield* sql.unsafe<{ url: string; events: string; active: number }>(
      "SELECT url, events, active FROM webhooks WHERE active = 1"
    );

    const fired: string[] = [];

    for (const wh of webhooks) {
      const events: string[] = JSON.parse(wh.events || "[]");
      if (!events.includes(event)) continue;

      // Fire-and-forget — don't block on response
      try {
        fetch(wh.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event, timestamp: new Date().toISOString(), ...payload }),
        }).catch(() => {}); // Swallow errors
        fired.push(wh.url);
      } catch {
        // Ignore fetch failures
      }
    }

    return fired;
  });
}
