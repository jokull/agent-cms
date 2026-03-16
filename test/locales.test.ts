import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest } from "./app-helpers.js";

describe("Locale REST API", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(() => {
    ({ handler } = createTestApp());
  });

  it("creates a locale", async () => {
    const res = await jsonRequest(handler, "POST", "/api/locales", { code: "en" });
    expect(res.status).toBe(201);
    const locale = await res.json();
    expect(locale.code).toBe("en");
    expect(locale.position).toBe(0);
  });

  it("creates locales with fallback chain", async () => {
    const enRes = await jsonRequest(handler, "POST", "/api/locales", { code: "en" });
    const en = await enRes.json();

    const isRes = await jsonRequest(handler, "POST", "/api/locales", {
      code: "is", fallbackLocaleId: en.id,
    });
    expect(isRes.status).toBe(201);
    const is = await isRes.json();
    expect(is.fallbackLocaleId).toBe(en.id);
  });

  it("rejects duplicate locale code", async () => {
    await jsonRequest(handler, "POST", "/api/locales", { code: "en" });
    const res = await jsonRequest(handler, "POST", "/api/locales", { code: "en" });
    expect(res.status).toBe(409);
  });

  it("lists locales in order", async () => {
    await jsonRequest(handler, "POST", "/api/locales", { code: "en", position: 0 });
    await jsonRequest(handler, "POST", "/api/locales", { code: "is", position: 1 });
    await jsonRequest(handler, "POST", "/api/locales", { code: "de", position: 2 });

    const res = await handler(new Request("http://localhost/api/locales"));
    expect(res.status).toBe(200);
    const locales = await res.json();
    expect(locales).toHaveLength(3);
    expect(locales.map((l: any) => l.code)).toEqual(["en", "is", "de"]);
  });

  it("deletes a locale", async () => {
    const createRes = await jsonRequest(handler, "POST", "/api/locales", { code: "fr" });
    const locale = await createRes.json();

    const deleteRes = await handler(new Request(`http://localhost/api/locales/${locale.id}`, { method: "DELETE" }));
    expect(deleteRes.status).toBe(200);

    const listRes = await handler(new Request("http://localhost/api/locales"));
    const locales = await listRes.json();
    expect(locales).toHaveLength(0);
  });

  it("returns 404 for deleting nonexistent locale", async () => {
    const res = await handler(new Request("http://localhost/api/locales/nonexistent", { method: "DELETE" }));
    expect(res.status).toBe(404);
  });
});
