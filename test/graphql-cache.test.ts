import { beforeEach, describe, expect, it } from "vitest";
import { createTestApp, jsonRequest } from "./app-helpers.js";

describe("GraphQL schema cache", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    ({ handler } = createTestApp());
    const modelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Post",
      apiKey: "post",
    });
    const model = await modelRes.json();
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Title",
      apiKey: "title",
      fieldType: "string",
    });
  });

  it("reports miss, hit, then miss after schema invalidation", async () => {
    const first = await handler(new Request("http://localhost/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bench-Trace": "1",
      },
      body: JSON.stringify({ query: "{ allPosts { title } }" }),
    }));
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Cms-Schema-Cache")).toBe("miss");
    expect(first.headers.get("X-Cms-Schema-Build-Count")).toBe("1");

    const second = await handler(new Request("http://localhost/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bench-Trace": "1",
      },
      body: JSON.stringify({ query: "{ allPosts { title } }" }),
    }));
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Cms-Schema-Cache")).toBe("hit");
    expect(second.headers.get("X-Cms-Schema-Build-Count")).toBe("1");

    const newModelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Author",
      apiKey: "author",
    });
    expect(newModelRes.status).toBe(201);

    const third = await handler(new Request("http://localhost/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bench-Trace": "1",
      },
      body: JSON.stringify({ query: "{ allPosts { title } }" }),
    }));
    expect(third.status).toBe(200);
    expect(third.headers.get("X-Cms-Schema-Cache")).toBe("miss");
    expect(third.headers.get("X-Cms-Schema-Build-Count")).toBe("2");
  });
});
