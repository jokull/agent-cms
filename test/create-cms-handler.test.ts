import { describe, expect, it } from "vitest";
import { createCMSHandler } from "../src/index.js";

// Shape-valid binding stubs: config-schema's guards duck-check the methods
// the CMS calls (D1 prepare/batch, R2 get/put), so bare `{} as D1Database`
// no longer passes validation.
const makeDb = () =>
  ({ prepare: () => {}, batch: () => {} }) as unknown as D1Database;
const makeBucket = () =>
  ({ get: () => {}, put: () => {} }) as unknown as R2Bucket;

describe("createCMSHandler", () => {
  it("reuses the same isolate-scoped handler for identical bindings", () => {
    const db = makeDb();
    const assets = makeBucket();

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
      bindings: { db: makeDb() },
    });

    const second = createCMSHandler({
      bindings: { db: makeDb() },
    });

    expect(second).not.toBe(first);
  });

  it("fails fast when only some R2 credentials are provided", () => {
    expect(() => createCMSHandler({
      bindings: {
        db: makeDb(),
        r2AccessKeyId: "key",
        r2BucketName: "bucket",
      },
    })).toThrow(/R2 credentials must include/);
  });

  it("fails fast when ai and vectorize are not configured together", () => {
    expect(() => createCMSHandler({
      bindings: {
        db: makeDb(),
        ai: {} as never,
      },
    })).toThrow(/ai and vectorize bindings must be configured together/);
  });

  it("fails fast on invalid environment values", () => {
    expect(() => createCMSHandler({
      bindings: {
        db: makeDb(),
        environment: "staging" as never,
      },
    })).toThrow(/environment/);
  });

  it("fails fast on invalid assetBaseUrl values", () => {
    expect(() => createCMSHandler({
      bindings: {
        db: makeDb(),
        assetBaseUrl: "not-a-url",
      },
    })).toThrow(/assetBaseUrl must be a valid URL/);
  });

  it("fails fast with a descriptive error when a binding lacks the expected surface", () => {
    expect(() => createCMSHandler({
      bindings: {
        // SAFETY: test-only — deliberately shape-invalid to exercise the guard.
        db: {} as unknown as D1Database,
      },
    })).toThrow(/binding "db" failed validation\. Expected D1 database binding with prepare\(\) and batch\(\)/);
  });
});
