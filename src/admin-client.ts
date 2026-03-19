export interface CmsAdminClientConfig {
  readonly endpoint: string;
  readonly writeKey: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface CreateEditorTokenRequest {
  readonly name: string;
  readonly expiresIn?: number;
}

export interface CreateEditorTokenResponse {
  readonly id: string;
  readonly token: string;
  readonly tokenPrefix: string;
  readonly name: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

export interface EditorTokenListItem {
  readonly id: string;
  readonly name: string;
  readonly token_prefix: string;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly expires_at: string | null;
}

function trimTrailingSlash(input: string): string {
  return input.replace(/\/$/, "");
}

async function readJsonOrError(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return { error: await response.text() };
}

export function createCmsAdminClient(config: CmsAdminClientConfig) {
  const endpoint = trimTrailingSlash(config.endpoint);
  const fetchFn = config.fetch ?? globalThis.fetch;

  async function request(path: string, init?: RequestInit) {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${config.writeKey}`);
    if (init?.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const response = await fetchFn(`${endpoint}${path}`, {
      ...init,
      headers,
    });

    if (!response.ok) {
      const errorPayload = await readJsonOrError(response);
      const message = typeof errorPayload === "object" && errorPayload !== null && "error" in errorPayload
        ? String(errorPayload.error)
        : `Request failed with status ${response.status}`;
      throw new Error(message);
    }

    return response;
  }

  return {
    async createEditorToken(input: CreateEditorTokenRequest): Promise<CreateEditorTokenResponse> {
      const response = await request("/api/tokens", {
        method: "POST",
        body: JSON.stringify(input),
      });
      return response.json<CreateEditorTokenResponse>();
    },

    async listEditorTokens(): Promise<EditorTokenListItem[]> {
      const response = await request("/api/tokens");
      return response.json<EditorTokenListItem[]>();
    },

    async revokeEditorToken(id: string): Promise<{ ok: true }> {
      const response = await request(`/api/tokens/${id}`, {
        method: "DELETE",
      });
      return response.json<{ ok: true }>();
    },
  };
}
