import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("Unique validation", () => {
  let handler: (req: Request) => Promise<Response>;
  let modelId: string;

  beforeEach(async () => {
    ({ handler } = createTestApp());
    const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Article", apiKey: "article" });
    const model = await modelRes.json();
    modelId = model.id;
    await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
      label: "External ID", apiKey: "external_id", fieldType: "string", validators: { unique: true },
    });
  });

  it("rejects create when a unique field duplicates an existing record", async () => {
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: { title: "One", external_id: "dato-1" },
    });

    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: { title: "Two", external_id: "dato-1" },
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("external_id");
    expect(body.error).toContain("Unique constraint");
  });

  it("rejects patch when changing a unique field to a duplicate value", async () => {
    const one = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: { title: "One", external_id: "dato-1" },
    }).then((res) => res.json());
    const two = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "article",
      data: { title: "Two", external_id: "dato-2" },
    }).then((res) => res.json());

    const res = await jsonRequest(handler, "PATCH", `/api/records/${two.id}`, {
      modelApiKey: "article",
      data: { external_id: "dato-1" },
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("external_id");
    expect(one.external_id).toBe("dato-1");
  });

  it("_isValid becomes false when unique is added after duplicate records already exist", async () => {
    const dupModelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Place", apiKey: "place" });
    const dupModel = await dupModelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${dupModel.id}/fields`, {
      label: "Code", apiKey: "code", fieldType: "string",
    });

    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "place", data: { code: "dup" },
    });
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "place", data: { code: "dup" },
    });

    const fieldsRes = await handler(new Request(`http://localhost/api/models/${dupModel.id}/fields`));
    const fields = await fieldsRes.json();
    const codeField = fields.find((f: { api_key: string }) => f.api_key === "code");

    const updateRes = await jsonRequest(handler, "PATCH", `/api/models/${dupModel.id}/fields/${codeField.id}`, {
      validators: { unique: true },
    });
    expect(updateRes.status).toBe(200);

    const result = await gqlQuery(handler, `{ allPlaces { code _isValid } }`);
    expect(result.data.allPlaces).toHaveLength(2);
    expect(result.data.allPlaces.every((record: { _isValid: boolean }) => record._isValid === false)).toBe(true);
  });

  it("publish rejects duplicate unique values", async () => {
    const dupModelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Place", apiKey: "place" });
    const dupModel = await dupModelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${dupModel.id}/fields`, {
      label: "Code", apiKey: "code", fieldType: "string",
    });

    const a = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "place",
      data: { code: "dup" },
    }).then((res) => res.json());
    const b = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "place",
      data: { code: "dup" },
    }).then((res) => res.json());

    const fieldsRes = await handler(new Request(`http://localhost/api/models/${dupModel.id}/fields`));
    const fields = await fieldsRes.json();
    const codeField = fields.find((f: { api_key: string }) => f.api_key === "code");
    await jsonRequest(handler, "PATCH", `/api/models/${dupModel.id}/fields/${codeField.id}`, {
      validators: { unique: true },
    });

    const publishRes = await handler(
      new Request(`http://localhost/api/records/${a.id}/publish?modelApiKey=place`, { method: "POST" })
    );
    expect(publishRes.status).toBe(400);
    const body = await publishRes.json();
    expect(body.error).toContain("code");
    expect(body.error).toContain("unique");

    const result = await gqlQuery(handler, `{ allPlaces { code _isValid } }`);
    expect(result.data.allPlaces).toHaveLength(2);
    expect(result.data.allPlaces.every((record: { _isValid: boolean }) => record._isValid === false)).toBe(true);
    expect(b.id).toBeTruthy();
  });

  it("rejects unique validator on unsupported field types", async () => {
    const res = await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, {
      label: "Metadata", apiKey: "metadata", fieldType: "json", validators: { unique: true },
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("unique validator is not supported");
  });
});
