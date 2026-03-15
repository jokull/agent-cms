import { describe, it, expect } from "vitest";
import app from "../src/index.js";

describe("Health check", () => {
  it("returns ok", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "ok" });
  });
});
