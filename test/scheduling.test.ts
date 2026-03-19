import { beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "./migrate.js";
import { createWebHandler } from "../src/http/router.js";
import { jsonRequest, gqlQuery } from "./app-helpers.js";

describe("scheduled publishing and unpublishing", () => {
  let handler: (req: Request) => Promise<Response>;
  let runScheduledTransitions: (now?: Date) => Promise<{
    now: string;
    published: Array<{ modelApiKey: string; recordId: string }>;
    unpublished: Array<{ modelApiKey: string; recordId: string }>;
  }>;

  beforeEach(async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-scheduling-"));
    const dbPath = join(tmpDir, "test.db");
    const sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });
    Effect.runSync(runMigrations().pipe(Effect.provide(sqlLayer)));
    const webHandler = createWebHandler(sqlLayer);
    handler = webHandler.fetch;
    runScheduledTransitions = webHandler.runScheduledTransitions;

    const res = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
    const model = await res.json();
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
  });

  it("schedules publish, exposes GraphQL fields, and executes via cron helper", async () => {
    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: { title: "Scheduled post" },
    });
    const record = await createRes.json();
    const publishAt = "2026-04-01T09:00:00.000Z";

    const scheduleRes = await jsonRequest(handler, "POST", `/api/records/${record.id}/schedule-publish`, {
      modelApiKey: "post",
      at: publishAt,
    });
    expect(scheduleRes.status).toBe(200);
    const scheduled = await scheduleRes.json();
    expect(scheduled._scheduled_publish_at).toBe(publishAt);

    const before = await gqlQuery(handler, `{
      allPosts(filter: { _publicationScheduledAt: { eq: "${publishAt}" } }) {
        title
        _publicationScheduledAt
        _status
      }
    }`, undefined, { includeDrafts: true });
    expect(before.errors).toBeUndefined();
    expect(before.data.allPosts[0]._publicationScheduledAt).toBe(publishAt);
    expect(before.data.allPosts[0]._status).toBe("draft");

    const executed = await runScheduledTransitions(new Date("2026-04-01T09:00:01.000Z"));
    expect(executed.published).toEqual([{ modelApiKey: "post", recordId: record.id }]);

    const getRes = await handler(new Request(`http://localhost/api/records/${record.id}?modelApiKey=post`));
    const after = await getRes.json();
    expect(after._status).toBe("published");
    expect(after._scheduled_publish_at).toBeNull();
  });

  it("schedules unpublish and clears it after execution", async () => {
    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post",
      data: { title: "Temporary post" },
    });
    const record = await createRes.json();
    await handler(new Request(`http://localhost/api/records/${record.id}/publish?modelApiKey=post`, { method: "POST" }));

    const unpublishAt = "2026-04-15T00:00:00.000Z";
    const scheduleRes = await jsonRequest(handler, "POST", `/api/records/${record.id}/schedule-unpublish`, {
      modelApiKey: "post",
      at: unpublishAt,
    });
    expect(scheduleRes.status).toBe(200);

    const executed = await runScheduledTransitions(new Date("2026-04-15T00:00:01.000Z"));
    expect(executed.unpublished).toEqual([{ modelApiKey: "post", recordId: record.id }]);

    const getRes = await handler(new Request(`http://localhost/api/records/${record.id}?modelApiKey=post`));
    const after = await getRes.json();
    expect(after._status).toBe("draft");
    expect(after._scheduled_unpublish_at).toBeNull();
  });
});
