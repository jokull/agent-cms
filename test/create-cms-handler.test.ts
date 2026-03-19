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
        writeKey: "write",
      },
    });

    const second = createCMSHandler({
      bindings: {
        db,
        assets,
        environment: "production",
        assetBaseUrl: "https://cms.example.com",
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

  it("fails fast when only some R2 credentials are provided", () => {
    expect(() => createCMSHandler({
      bindings: {
        db: {} as D1Database,
        r2AccessKeyId: "key",
        r2BucketName: "bucket",
      },
    })).toThrow(/R2 credentials must include/);
  });

  it("fails fast when ai and vectorize are not configured together", () => {
    expect(() => createCMSHandler({
      bindings: {
        db: {} as D1Database,
        ai: {} as never,
      },
    })).toThrow(/ai and vectorize bindings must be configured together/);
  });

  it("fails fast on invalid environment values", () => {
    expect(() => createCMSHandler({
      bindings: {
        db: {} as D1Database,
        environment: "staging" as never,
      },
    })).toThrow(/environment/);
  });

  it("fails fast on invalid assetBaseUrl values", () => {
    expect(() => createCMSHandler({
      bindings: {
        db: {} as D1Database,
        assetBaseUrl: "not-a-url",
      },
    })).toThrow(/assetBaseUrl must be a valid URL/);
  });
});
