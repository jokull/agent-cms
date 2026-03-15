import { describe, it, expect } from "vitest";
import { createTestApp } from "./app-helpers.js";

describe("Health check", () => {
  it("returns ok", async () => {
    const { handler } = createTestApp();
    const response = await handler(new Request("http://localhost/health"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "ok" });
  });
});
