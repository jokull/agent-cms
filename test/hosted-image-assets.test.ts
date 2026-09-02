import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runMigrations } from "./migrate.js";
import { createWebHandler } from "../src/http/router.js";
import { fakeImagesBinding } from "./fake-images.js";

function createApp(options?: Parameters<typeof createWebHandler>[1]) {
  const tmpDir = mkdtempSync(join(tmpdir(), "agent-cms-hosted-image-"));
  const dbPath = join(tmpDir, "test.db");
  const sqlLayer = SqliteClient.layer({ filename: dbPath, disableWAL: true });
  Effect.runSync(runMigrations().pipe(Effect.provide(sqlLayer)));
  return { handler: createWebHandler(sqlLayer, options).fetch, sqlLayer };
}

async function jsonRequest(
  handler: (req: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
) {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return handler(new Request(`http://localhost${path}`, init));
}

const IMAGE_ID_1 = "img-hosted-1";
const IMAGE_ID_2 = "img-hosted-2";

function hostedImage(id: string) {
  return {
    filename: "photo.jpg",
    mimeType: "image/jpeg",
    size: 1234,
    width: 1200,
    height: 800,
    imageId: id,
    imageDeliveryBase: "https://imagedelivery.net/testaccounthash",
  };
}

describe("hosted image assets (Cloudflare Images binding)", () => {
  it("registers a hosted image with an imagedelivery URL", async () => {
    const { binding } = fakeImagesBinding();
    const { handler } = createApp({ images: binding });

    const res = await jsonRequest(handler, "POST", "/api/assets", hostedImage(IMAGE_ID_1));
    expect(res.status).toBe(201);
    const asset = await res.json() as Record<string, unknown>;
    expect(asset.url).toBe("https://imagedelivery.net/testaccounthash/img-hosted-1/public");
    expect(asset.r2Key).toBe("");
  });

  it("resolves the hosted delivery URL on read (list + get)", async () => {
    const { binding } = fakeImagesBinding();
    const { handler } = createApp({ images: binding });

    await jsonRequest(handler, "POST", "/api/assets", hostedImage(IMAGE_ID_1));

    const listRes = await jsonRequest(handler, "GET", "/api/assets");
    expect(listRes.status).toBe(200);
    const { assets } = await listRes.json() as { assets: Array<{ url: string }> };
    expect(assets[0]?.url).toBe("https://imagedelivery.net/testaccounthash/img-hosted-1/public");
  });

  it("replaces a hosted image with a new image and deletes the superseded one", async () => {
    const { binding, log } = fakeImagesBinding();
    const { handler } = createApp({ images: binding });

    const created = await (await jsonRequest(handler, "POST", "/api/assets", hostedImage(IMAGE_ID_1))).json() as { id: string };

    const replaceRes = await jsonRequest(handler, "PUT", `/api/assets/${created.id}`, hostedImage(IMAGE_ID_2));
    expect(replaceRes.status).toBe(200);
    const replaced = await replaceRes.json() as { url: string };
    expect(replaced.url).toBe("https://imagedelivery.net/testaccounthash/img-hosted-2/public");
    expect(log.deletes).toContain(IMAGE_ID_1);
  });

  it("deletes the hosted image when the asset row is deleted (force)", async () => {
    const { binding, log } = fakeImagesBinding();
    const { handler } = createApp({ images: binding });

    const created = await (await jsonRequest(handler, "POST", "/api/assets", hostedImage(IMAGE_ID_1))).json() as { id: string };
    const delRes = await jsonRequest(handler, "DELETE", `/api/assets/${created.id}?force=true`);
    expect(delRes.status).toBe(200);
    expect(log.deletes).toContain(IMAGE_ID_1);
  });

  it("imports a remote image into hosted storage when the binding is present", async () => {
    const { binding, log } = fakeImagesBinding();
    const fetchStub = vi.fn(async () => new Response(Uint8Array.from([137, 80, 78, 71]), {
      status: 200,
      headers: { "Content-Type": "image/png" },
    }));
    const { handler } = createApp({ images: binding, fetch: fetchStub });

    const res = await jsonRequest(handler, "POST", "/api/assets/import-from-url", {
      url: "https://example.com/hero.png",
    });
    expect(res.status).toBe(201);
    const asset = await res.json() as { url: string };
    expect(log.uploads.length).toBe(1);
    expect(asset.url).toMatch(/^https:\/\/imagedelivery\.net\/testaccounthash\/img-/);
  });

  it("requires an R2 bucket to import non-image files (no images fallback)", async () => {
    const { binding } = fakeImagesBinding();
    const fetchStub = vi.fn(async () => new Response("plain text", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    }));
    const { handler } = createApp({ images: binding, fetch: fetchStub });

    const res = await jsonRequest(handler, "POST", "/api/assets/import-from-url", {
      url: "https://example.com/notes.txt",
      filename: "notes.txt",
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toMatch(/R2 bucket binding/);
  });
});
