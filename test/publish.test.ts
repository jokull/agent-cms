import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("Draft/Publish Lifecycle", () => {
  let handler: (req: Request) => Promise<Response>;
  let modelId: string;

  beforeEach(async () => {
    ({ handler } = createTestApp());
    const res = await jsonRequest(handler, "POST", "/api/models", { name: "Post", apiKey: "post" });
    const model = await res.json();
    modelId = model.id;
    await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, { label: "Title", apiKey: "title", fieldType: "string" });
    await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, { label: "Body", apiKey: "body", fieldType: "text" });
  });

  it("new records start as draft", async () => {
    const res = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post", data: { title: "Draft Post", body: "Content" },
    });
    const record = await res.json();
    expect(record._status).toBe("draft");
  });

  it("publishes a record", async () => {
    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post", data: { title: "My Post", body: "Content" },
    });
    const record = await createRes.json();

    const pubRes = await handler(
      new Request(`http://localhost/api/records/${record.id}/publish?modelApiKey=post`, { method: "POST" })
    );
    expect(pubRes.status).toBe(200);
    const published = await pubRes.json();
    expect(published._status).toBe("published");
    expect(published._published_at).toBeTruthy();
    expect(published._first_published_at).toBeTruthy();
  });

  it("editing a published record sets status to 'updated'", async () => {
    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post", data: { title: "My Post", body: "Content" },
    });
    const record = await createRes.json();

    // Publish
    await handler(new Request(`http://localhost/api/records/${record.id}/publish?modelApiKey=post`, { method: "POST" }));

    // Edit
    const editRes = await jsonRequest(handler, "PATCH", `/api/records/${record.id}`, {
      modelApiKey: "post", data: { title: "Updated Title" },
    });
    const edited = await editRes.json();
    expect(edited._status).toBe("updated");
    expect(edited.title).toBe("Updated Title");
  });

  it("unpublishes a record back to draft", async () => {
    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post", data: { title: "My Post" },
    });
    const record = await createRes.json();

    await handler(new Request(`http://localhost/api/records/${record.id}/publish?modelApiKey=post`, { method: "POST" }));
    const unpubRes = await handler(
      new Request(`http://localhost/api/records/${record.id}/unpublish?modelApiKey=post`, { method: "POST" })
    );
    const unpublished = await unpubRes.json();
    expect(unpublished._status).toBe("draft");
    expect(unpublished._published_snapshot).toBeNull();
  });

  it("published snapshot preserves old content while draft has new", async () => {
    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post", data: { title: "Original", body: "Original body" },
    });
    const record = await createRes.json();

    // Publish
    await handler(new Request(`http://localhost/api/records/${record.id}/publish?modelApiKey=post`, { method: "POST" }));

    // Edit (creates "updated" state)
    await jsonRequest(handler, "PATCH", `/api/records/${record.id}`, {
      modelApiKey: "post", data: { title: "New Title" },
    });

    // Read the record — it should have both the new title AND the published snapshot
    const getRes = await handler(new Request(`http://localhost/api/records/${record.id}?modelApiKey=post`));
    const full = await getRes.json();
    expect(full.title).toBe("New Title"); // Draft version
    expect(full._status).toBe("updated");
    expect(full._published_snapshot).toBeDefined();
    expect(full._published_snapshot.title).toBe("Original"); // Published version preserved
  });

  it("re-publishing updates the snapshot", async () => {
    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "post", data: { title: "V1" },
    });
    const record = await createRes.json();

    // Publish V1
    await handler(new Request(`http://localhost/api/records/${record.id}/publish?modelApiKey=post`, { method: "POST" }));

    // Edit to V2
    await jsonRequest(handler, "PATCH", `/api/records/${record.id}`, {
      modelApiKey: "post", data: { title: "V2" },
    });

    // Re-publish
    await handler(new Request(`http://localhost/api/records/${record.id}/publish?modelApiKey=post`, { method: "POST" }));

    const getRes = await handler(new Request(`http://localhost/api/records/${record.id}?modelApiKey=post`));
    const full = await getRes.json();
    expect(full._status).toBe("published");
    expect(full._published_snapshot.title).toBe("V2"); // Snapshot updated to V2
  });
});
