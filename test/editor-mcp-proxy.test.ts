import { describe, expect, it, vi } from "vitest";
import { createEditorMcpProxy } from "../src/editor-mcp-proxy.js";

describe("editor MCP proxy", () => {
  it("redirects unauthenticated authorize requests to app login", async () => {
    const proxy = createEditorMcpProxy({
      appBaseUrl: "https://app.example.com",
      cmsBaseUrl: "https://cms.example.com",
      cmsWriteKey: "write-key",
      oauthSecret: "super-secret",
      getEditor: async () => null,
      getLoginUrl: () => "https://app.example.com/login",
      fetch: vi.fn(),
    });

    const response = await proxy.fetch(new Request(
      "https://app.example.com/editor-access/authorize?response_type=code&client_id=test-client&redirect_uri=https%3A%2F%2Fclient.example.com%2Fcb&code_challenge=test&code_challenge_method=S256",
    ));

    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toContain("https://app.example.com/login");
    expect(location).toContain("returnTo=");
  });

  it("mints a CMS editor token during token exchange and proxies MCP traffic with it", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url === "https://cms.example.com/api/tokens") {
        return new Response(JSON.stringify({
          id: "etid_123",
          token: "etk_real_editor_token",
          tokenPrefix: "etk_real_edi",
          name: "Sarah Editor",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url === "https://cms.example.com/mcp/editor") {
        const request = input as Request;
        return new Response(JSON.stringify({
          authorization: request.headers.get("authorization"),
          contentType: request.headers.get("content-type"),
        }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    });

    const proxy = createEditorMcpProxy({
      appBaseUrl: "https://app.example.com",
      cmsBaseUrl: "https://cms.example.com",
      cmsWriteKey: "write-key",
      oauthSecret: "super-secret",
      getEditor: async () => ({ id: "user-1", name: "Sarah Editor" }),
      getLoginUrl: () => "https://app.example.com/login",
      fetch: fetchMock as typeof fetch,
    });

    const verifier = "verifier-123";
    const challengeBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(challengeBuffer)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");

    const authorizeResponse = await proxy.fetch(new Request(
      `https://app.example.com${proxy.paths.authorizationPath}?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent("https://client.example.com/callback")}&code_challenge=${challenge}&code_challenge_method=S256&state=abc`,
    ));
    expect(authorizeResponse.status).toBe(302);
    const authorizeLocation = new URL(authorizeResponse.headers.get("location")!);
    const code = authorizeLocation.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(authorizeLocation.searchParams.get("state")).toBe("abc");

    const formData = new FormData();
    formData.set("grant_type", "authorization_code");
    formData.set("code", code!);
    formData.set("client_id", "test-client");
    formData.set("redirect_uri", "https://client.example.com/callback");
    formData.set("code_verifier", verifier);

    const tokenResponse = await proxy.fetch(new Request(`https://app.example.com${proxy.paths.tokenPath}`, {
      method: "POST",
      body: formData,
    }));
    expect(tokenResponse.status).toBe(200);
    const tokens = await tokenResponse.json() as { access_token: string; token_type: string };
    expect(tokens.token_type).toBe("Bearer");

    const mcpResponse = await proxy.fetch(new Request(`https://app.example.com${proxy.paths.mcpPath}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      duplex: "half",
    } as RequestInit & { duplex: "half" }));

    expect(mcpResponse.status).toBe(200);
    await expect(mcpResponse.json()).resolves.toEqual({
      authorization: "Bearer etk_real_editor_token",
      contentType: "application/json",
    });
  });

  it("exposes MCP OAuth discovery metadata", async () => {
    const proxy = createEditorMcpProxy({
      appBaseUrl: "https://app.example.com",
      cmsBaseUrl: "https://cms.example.com",
      cmsWriteKey: "write-key",
      oauthSecret: "super-secret",
      getEditor: async () => ({ id: "user-1", name: "Sarah Editor" }),
      getLoginUrl: () => "https://app.example.com/login",
      fetch: vi.fn(),
      mountPath: "/app-editor-mcp",
    });

    const authMetadataResponse = await proxy.fetch(new Request(
      `https://app.example.com${proxy.paths.oauthAuthorizationServerMetadataPath}`,
    ));
    expect(authMetadataResponse.status).toBe(200);
    const authMetadata = await authMetadataResponse.json() as { issuer: string; authorization_endpoint: string };
    expect(authMetadata.issuer).toBe("https://app.example.com/app-editor-mcp");
    expect(authMetadata.authorization_endpoint).toBe("https://app.example.com/app-editor-mcp/authorize");

    const resourceMetadataResponse = await proxy.fetch(new Request(
      `https://app.example.com${proxy.paths.protectedResourceMetadataPath}`,
    ));
    expect(resourceMetadataResponse.status).toBe(200);
    const resourceMetadata = await resourceMetadataResponse.json() as { resource: string; authorization_servers: string[] };
    expect(resourceMetadata.resource).toBe("https://app.example.com/app-editor-mcp/mcp");
    expect(resourceMetadata.authorization_servers).toEqual(["https://app.example.com/app-editor-mcp"]);
  });

  it("preserves a path prefix in cmsBaseUrl when proxying MCP traffic", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url === "https://cms.example.com/base/api/tokens") {
        return new Response(JSON.stringify({
          id: "etid_123",
          token: "etk_real_editor_token",
          tokenPrefix: "etk_real_edi",
          name: "Sarah Editor",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url === "https://cms.example.com/base/mcp/editor") {
        return new Response(JSON.stringify({
          proxiedTo: request.url,
          authorization: request.headers.get("authorization"),
        }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    });

    const proxy = createEditorMcpProxy({
      appBaseUrl: "https://app.example.com",
      cmsBaseUrl: "https://cms.example.com/base",
      cmsWriteKey: "write-key",
      oauthSecret: "super-secret",
      getEditor: async () => ({ id: "user-1", name: "Sarah Editor" }),
      getLoginUrl: () => "https://app.example.com/login",
      fetch: fetchMock as typeof fetch,
    });

    const verifier = "verifier-123";
    const challengeBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(challengeBuffer)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");

    const authorizeResponse = await proxy.fetch(new Request(
      `https://app.example.com${proxy.paths.authorizationPath}?response_type=code&client_id=test-client&redirect_uri=${encodeURIComponent("https://client.example.com/callback")}&code_challenge=${challenge}&code_challenge_method=S256`,
    ));
    const authorizeLocation = new URL(authorizeResponse.headers.get("location")!);
    const code = authorizeLocation.searchParams.get("code");

    const formData = new FormData();
    formData.set("grant_type", "authorization_code");
    formData.set("code", code!);
    formData.set("client_id", "test-client");
    formData.set("redirect_uri", "https://client.example.com/callback");
    formData.set("code_verifier", verifier);

    const tokenResponse = await proxy.fetch(new Request(`https://app.example.com${proxy.paths.tokenPath}`, {
      method: "POST",
      body: formData,
    }));
    const tokens = await tokenResponse.json() as { access_token: string };

    const mcpResponse = await proxy.fetch(new Request(`https://app.example.com${proxy.paths.mcpPath}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      duplex: "half",
    } as RequestInit & { duplex: "half" }));

    await expect(mcpResponse.json()).resolves.toEqual({
      proxiedTo: "https://cms.example.com/base/mcp/editor",
      authorization: "Bearer etk_real_editor_token",
    });
  });
});
