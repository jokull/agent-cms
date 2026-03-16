import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest } from "./app-helpers.js";

describe("Bulk create validation", () => {
  let handler: (req: Request) => Promise<Response>;
  let modelId: string;

  beforeEach(async () => {
    ({ handler } = createTestApp());
    const res = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
    const model = await res.json();
    modelId = model.id;
    await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string", validators: { required: true },
    });
    await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
      label: "Body", apiKey: "body", fieldType: "text",
    });
  });

  it("rejects bulk create when required field is missing", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records/bulk", {
      modelApiKey: "post",
      records: [
        { title: "Good", body: "ok" },
        { body: "missing title" },
      ],
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("title");
    expect(body.error).toContain("Record 1");
  });

  it("rejects bulk create with invalid composite field", async () => {
    // Add a color field
    await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
      label: "Color", apiKey: "color", fieldType: "color",
    });

    const res = await jsonRequest(handler, "POST", "/api/records/bulk", {
      modelApiKey: "post",
      records: [
        { title: "Good", color: { red: 999, green: 0, blue: 0 } },
      ],
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("color");
  });

  it("succeeds with valid bulk records including composite fields", async () => {
    await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
      label: "Color", apiKey: "color", fieldType: "color",
    });

    const res = await jsonRequest(handler, "POST", "/api/records/bulk", {
      modelApiKey: "post",
      records: [
        { title: "One", color: { red: 255, green: 0, blue: 0 } },
        { title: "Two", color: { red: 0, green: 255, blue: 0 } },
      ],
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.created).toBe(2);
  });

  it("validates all records — first failing record index is reported", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records/bulk", {
      modelApiKey: "post",
      records: [
        { title: "Good" },
        { title: "Also good" },
        { title: null },
      ],
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Record 2");
  });
});
