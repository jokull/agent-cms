import { describe, expect, it } from "vitest";
import { createCMSHandler } from "../src/index.js";

describe("createCMSHandler", () => {
  it("reuses the same isolate-scoped handler for identical bindings", () => {
    const db = {} as D1Database;
    const assets = {} as R2Bucket;

    const first = createCMSHandler({
      bindings: {
        db,
        assets,
        environment: "production",
        assetBaseUrl: "https://cms.example.com",
        readKey: "read",
        writeKey: "write",
      },
    });

    const second = createCMSHandler({
      bindings: {
        db,
        assets,
        environment: "production",
        assetBaseUrl: "https://cms.example.com",
        readKey: "read",
        writeKey: "write",
      },
    });

    expect(second).toBe(first);
  });

  it("creates distinct handlers when the database binding differs", () => {
    const first = createCMSHandler({
      bindings: { db: {} as D1Database },
    });

    const second = createCMSHandler({
      bindings: { db: {} as D1Database },
    });

    expect(second).not.toBe(first);
  });
});
