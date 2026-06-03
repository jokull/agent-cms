import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { runMigrations } from "./migrate.js";
import { createWebHandler } from "../src/http/router.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function createApp(options?: Parameters<typeof createWebHandler>[1]) {
  const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-visual-edit-"));
  const dbPath = join(tmpDir, "test.db");
  const sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });
  Effect.runSync(runMigrations().pipe(Effect.provide(sqlLayer)));
  return createWebHandler(sqlLayer, options).fetch;
}

describe("visual edit routes", () => {
  it("returns 501 for presigned uploads when R2 credentials are not configured", async () => {
    const handler = createApp({ writeKey: "write-key" });
    const res = await handler(new Request("http://localhost/api/assets/upload-url", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer write-key",
      },
      body: JSON.stringify({ filename: "photo.jpg", mimeType: "image/jpeg" }),
    }));

    expect(res.status).toBe(501);
    await expect(res.json()).resolves.toEqual({ error: "Presigned uploads not configured" });
  });

  it("creates presigned R2 upload URLs when credentials are configured", async () => {
    const handler = createApp({
      writeKey: "write-key",
      r2Credentials: {
        accessKeyId: "test-access-key",
        secretAccessKey: "test-secret-key",
        bucketName: "test-bucket",
        accountId: "test-account",
      },
    });
    const res = await handler(new Request("http://localhost/api/assets/upload-url", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer write-key",
      },
      body: JSON.stringify({ filename: "photo.jpg", mimeType: "image/jpeg" }),
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.assetId).toEqual(expect.any(String));
    expect(body.r2Key).toBe(`uploads/${body.assetId}/photo.jpg`);
    expect(body.uploadUrl).toEqual(expect.stringContaining("https://test-bucket.test-account.r2.cloudflarestorage.com/"));
    expect(body.uploadUrl).toEqual(expect.stringContaining("X-Amz-Signature="));
  });

  it("returns 501 for direct binary upload when R2 bucket is not configured", async () => {
    const handler = createApp({ writeKey: "write-key" });
    const res = await handler(new Request("http://localhost/api/assets/test-asset/file", {
      method: "PUT",
      headers: {
        Authorization: "Bearer write-key",
        "Content-Type": "image/jpeg",
        "X-Filename": "photo.jpg",
      },
      body: new Uint8Array([1, 2, 3]),
    }));

    expect(res.status).toBe(501);
    await expect(res.json()).resolves.toEqual({ error: "R2 bucket not configured" });
  });

  it("writes binary uploads into the configured R2 bucket", async () => {
    const put = vi.fn(async (_key: string, _value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null, _options?: R2PutOptions) => null);
    const bucket = { put } as R2Bucket;
    const handler = createApp({ writeKey: "write-key", r2Bucket: bucket });

    const res = await handler(new Request("http://localhost/api/assets/test-asset/file", {
      method: "PUT",
      headers: {
        Authorization: "Bearer write-key",
        "Content-Type": "image/png",
        "X-Filename": "photo.png",
      },
      body: new Uint8Array([1, 2, 3, 4]),
    }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      assetId: "test-asset",
      r2Key: "uploads/test-asset/photo.png",
    });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(
      "uploads/test-asset/photo.png",
      expect.any(ArrayBuffer),
      { httpMetadata: { contentType: "image/png" } },
    );
  });
});
