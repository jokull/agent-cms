import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest } from "./app-helpers.js";

// W1: record write paths accumulate ALL field failures per write (Dato-style),
// so a form can mark every invalid field in one submit. Failures surface as
// AggregateValidationError → 400 { error, issues: [{ field?, message }] }.
describe("Validation aggregation (whole-form error mapping)", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(() => {
    ({ handler } = createTestApp());
  });

  async function makeModelWithThreeColors(apiKey: string) {
    const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: apiKey, apiKey });
    const model = await modelRes.json();
    for (const key of ["c1", "c2", "c3"]) {
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
        label: key, apiKey: key, fieldType: "color",
      });
    }
    return model;
  }

  it("create with three invalid fields returns 400 with three issues, each carrying its field", async () => {
    await makeModelWithThreeColors("swatch");

    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "swatch",
      data: {
        c1: { red: 999, green: 0, blue: 0 },
        c2: { red: 0, green: 999, blue: 0 },
        c3: { red: 0, green: 0, blue: 999 },
      },
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues).toHaveLength(3);
    const fields = body.issues.map((i: { field?: string }) => i.field).sort();
    expect(fields).toEqual(["c1", "c2", "c3"]);
    for (const issue of body.issues) {
      expect(typeof issue.message).toBe("string");
      expect(issue.message.length).toBeGreaterThan(0);
    }
    // Summary describes the count when more than one field fails.
    expect(body.error).toContain("3 fields");
  });

  it("patch with three invalid fields returns 400 with three issues", async () => {
    await makeModelWithThreeColors("palette");

    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "palette",
      data: {
        c1: { red: 1, green: 2, blue: 3 },
        c2: { red: 4, green: 5, blue: 6 },
        c3: { red: 7, green: 8, blue: 9 },
      },
    });
    const record = await createRes.json();

    const res = await jsonRequest(handler, "PATCH", `/api/records/${record.id}`, {
      modelApiKey: "palette",
      data: {
        c1: { red: 999, green: 0, blue: 0 },
        c2: { red: 0, green: 999, blue: 0 },
        c3: { red: 0, green: 0, blue: 999 },
      },
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues).toHaveLength(3);
    expect(body.issues.map((i: { field?: string }) => i.field).sort()).toEqual(["c1", "c2", "c3"]);
  });

  it("publish with two missing required fields returns two issues", async () => {
    const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Doc", apiKey: "doc" });
    const model = await modelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string", validators: { required: true },
    });
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Body", apiKey: "body", fieldType: "text", validators: { required: true },
    });

    // Draft model: create empty draft is allowed, publish enforces required.
    const createRes = await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "doc", data: {} });
    const record = await createRes.json();

    const res = await handler(
      new Request(`http://localhost/api/records/${record.id}/publish?modelApiKey=doc`, { method: "POST" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues).toHaveLength(2);
    expect(body.issues.map((i: { field?: string }) => i.field).sort()).toEqual(["body", "title"]);
  });

  it("single bad field yields an issues array of one (array always honest)", async () => {
    const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "One", apiKey: "one" });
    const model = await modelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Color", apiKey: "color", fieldType: "color",
    });

    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "one",
      data: { color: { red: 999, green: 0, blue: 0 } },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0].field).toBe("color");
    // With one issue the summary is that issue's own message.
    expect(body.error).toBe(body.issues[0].message);
  });

  it("create accumulates all missing required fields on a non-draft model", async () => {
    const modelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Landing", apiKey: "landing", hasDraft: false,
    });
    const model = await modelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string", validators: { required: true },
    });
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Slug", apiKey: "slug", fieldType: "string", validators: { required: true },
    });

    const res = await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "landing", data: {} });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues).toHaveLength(2);
    expect(body.issues.map((i: { field?: string }) => i.field).sort()).toEqual(["slug", "title"]);
  });
});
