import { createCmsAdminClient, type CmsAdminClientConfig } from "./admin-client.js";

export interface EditorMcpPrincipal {
  readonly id: string;
  readonly name: string;
}

export interface EditorMcpProxyConfig {
  readonly appBaseUrl: string;
  readonly cmsBaseUrl: string;
  readonly cmsWriteKey: string;
  readonly oauthSecret: string;
  readonly getEditor: (request: Request) => Promise<EditorMcpPrincipal | null>;
  readonly getLoginUrl: (request: Request) => string | URL;
  readonly mountPath?: string;
  readonly oauthTokenTtlSeconds?: number;
  readonly cmsTokenTtlSeconds?: number;
  readonly resourceName?: string;
  readonly fetch?: typeof globalThis.fetch;
}

interface OAuthClientRegistration {
  readonly client_id: string;
  readonly redirect_uris?: readonly string[];
  readonly client_name?: string;
}

interface AuthorizationCodeClaims {
  readonly sub: string;
  readonly name: string;
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly code_challenge: string;
  readonly code_challenge_method: "S256";
  readonly resource: string;
  readonly scope: string;
  readonly cms_token: string;
  readonly exp: number;
}

interface AccessTokenClaims {
  readonly sub: string;
  readonly name: string;
  readonly resource: string;
  readonly scope: string;
  readonly cms_token: string;
  readonly exp: number;
}

export interface EditorMcpProxyPaths {
  readonly mountPath: string;
  readonly issuer: string;
  readonly mcpPath: string;
  readonly authorizationPath: string;
  readonly tokenPath: string;
  readonly registrationPath: string;
  readonly oauthAuthorizationServerMetadataPath: string;
  readonly protectedResourceMetadataPath: string;
}

export interface EditorMcpProxy {
  readonly paths: EditorMcpProxyPaths;
  fetch(request: Request): Promise<Response>;
}

function trimTrailingSlash(input: string): string {
  return input.replace(/\/$/, "");
}

function ensureLeadingSlash(input: string): string {
  return input.startsWith("/") ? input : `/${input}`;
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlEncodeText(input: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(input));
}

function base64UrlDecodeText(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const decoded = atob(padded);
  const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function importHmacKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signJwt(secret: string, claims: object): Promise<string> {
  const key = await importHmacKey(secret);
  const header = base64UrlEncodeText(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncodeText(JSON.stringify(claims));
  const message = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return `${message}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}

async function verifyJwt<T extends { exp: number }>(secret: string, token: string): Promise<T | null> {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return null;
  const key = await importHmacKey(secret);
  const message = `${header}.${payload}`;
  const signatureBytes = Uint8Array.from(
    atob(signature.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (signature.length % 4)) % 4)),
    (char) => char.charCodeAt(0),
  );
  const valid = await crypto.subtle.verify("HMAC", key, signatureBytes, new TextEncoder().encode(message));
  if (!valid) return null;
  const claims = JSON.parse(base64UrlDecodeText(payload)) as T;
  if (claims.exp <= Math.floor(Date.now() / 1000)) return null;
  return claims;
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return base64UrlEncodeBytes(new Uint8Array(digest));
}

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function redirectResponse(url: URL): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: url.toString() },
  });
}

function unauthorizedForMcp(resourceMetadataUrl: string): Response {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
    },
  });
}

function cloneHeadersWithoutAuthorization(headers: Headers): Headers {
  const cloned = new Headers(headers);
  cloned.delete("authorization");
  return cloned;
}

function parseBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  return header.startsWith("Bearer ") ? header.slice(7) : header;
}

function appendPathToUrl(base: string, path: string): string {
  return `${trimTrailingSlash(base)}${ensureLeadingSlash(path)}`;
}

function getPathname(request: Request): string {
  return new URL(request.url).pathname;
}

export function createEditorMcpProxy(config: EditorMcpProxyConfig): EditorMcpProxy {
  const appBaseUrl = trimTrailingSlash(config.appBaseUrl);
  const cmsBaseUrl = trimTrailingSlash(config.cmsBaseUrl);
  const mountPath = ensureLeadingSlash(config.mountPath ?? "/editor-access");
  const fetchFn = config.fetch ?? globalThis.fetch;
  const oauthTokenTtlSeconds = config.oauthTokenTtlSeconds ?? 3600;
  const cmsTokenTtlSeconds = config.cmsTokenTtlSeconds ?? 3600;
  const issuer = appendPathToUrl(appBaseUrl, mountPath);
  const paths: EditorMcpProxyPaths = {
    mountPath,
    issuer,
    mcpPath: `${mountPath}/mcp`,
    authorizationPath: `${mountPath}/authorize`,
    tokenPath: `${mountPath}/token`,
    registrationPath: `${mountPath}/register`,
    oauthAuthorizationServerMetadataPath: `/.well-known/oauth-authorization-server${mountPath}`,
    protectedResourceMetadataPath: `/.well-known/oauth-protected-resource${mountPath}/mcp`,
  };
  const resourceUrl = appendPathToUrl(appBaseUrl, paths.mcpPath);
  const protectedResourceMetadataUrl = appendPathToUrl(appBaseUrl, paths.protectedResourceMetadataPath);
  const cmsAdmin = createCmsAdminClient({
    endpoint: cmsBaseUrl,
    writeKey: config.cmsWriteKey,
    fetch: fetchFn,
  } satisfies CmsAdminClientConfig);

  async function handleAuthorize(request: Request): Promise<Response> {
    const editor = await config.getEditor(request);
    if (!editor) {
      const loginUrl = new URL(config.getLoginUrl(request), appBaseUrl);
      loginUrl.searchParams.set("returnTo", request.url);
      return redirectResponse(loginUrl);
    }

    const url = new URL(request.url);
    const responseType = url.searchParams.get("response_type");
    const clientId = url.searchParams.get("client_id");
    const redirectUri = url.searchParams.get("redirect_uri");
    const codeChallenge = url.searchParams.get("code_challenge");
    const codeChallengeMethod = url.searchParams.get("code_challenge_method");
    const state = url.searchParams.get("state");
    const resource = url.searchParams.get("resource") ?? resourceUrl;
    const scope = url.searchParams.get("scope") ?? "editor:mcp";

    if (
      responseType !== "code"
      || !clientId
      || !redirectUri
      || !codeChallenge
      || codeChallengeMethod !== "S256"
    ) {
      return jsonResponse({ error: "Invalid authorization request" }, 400);
    }

    const cmsToken = await cmsAdmin.createEditorToken({
      name: editor.name,
      expiresIn: cmsTokenTtlSeconds,
    });

    const code = await signJwt(config.oauthSecret, {
      sub: editor.id,
      name: editor.name,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      resource,
      scope,
      cms_token: cmsToken.token,
      exp: Math.floor(Date.now() / 1000) + 120,
    } satisfies AuthorizationCodeClaims);

    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (state) redirectUrl.searchParams.set("state", state);
    return redirectResponse(redirectUrl);
  }

  async function handleToken(request: Request): Promise<Response> {
    const body = await request.formData();
    const grantType = body.get("grant_type");
    const code = body.get("code");
    const clientId = body.get("client_id");
    const redirectUri = body.get("redirect_uri");
    const codeVerifier = body.get("code_verifier");

    if (
      grantType !== "authorization_code"
      || typeof code !== "string"
      || typeof clientId !== "string"
      || typeof redirectUri !== "string"
      || typeof codeVerifier !== "string"
    ) {
      return jsonResponse({ error: "invalid_request" }, 400);
    }

    const claims = await verifyJwt<AuthorizationCodeClaims>(config.oauthSecret, code);
    if (
      !claims
      || claims.client_id !== clientId
      || claims.redirect_uri !== redirectUri
      || await sha256Base64Url(codeVerifier) !== claims.code_challenge
    ) {
      return jsonResponse({ error: "invalid_grant" }, 400);
    }

    const accessToken = await signJwt(config.oauthSecret, {
      sub: claims.sub,
      name: claims.name,
      resource: claims.resource,
      scope: claims.scope,
      cms_token: claims.cms_token,
      exp: Math.floor(Date.now() / 1000) + oauthTokenTtlSeconds,
    } satisfies AccessTokenClaims);

    return jsonResponse({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: oauthTokenTtlSeconds,
      scope: claims.scope,
    });
  }

  async function handleRegister(request: Request): Promise<Response> {
    const metadata = await request.json<OAuthClientRegistration>();
    const clientId = metadata.client_id || `editor-mcp-${crypto.randomUUID()}`;
    return jsonResponse({
      ...metadata,
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    });
  }

  async function handleMcp(request: Request): Promise<Response> {
    const accessToken = parseBearerToken(request);
    if (!accessToken) return unauthorizedForMcp(protectedResourceMetadataUrl);

    const claims = await verifyJwt<AccessTokenClaims>(config.oauthSecret, accessToken);
    if (!claims || claims.resource !== resourceUrl) {
      return unauthorizedForMcp(protectedResourceMetadataUrl);
    }

    const upstreamUrl = new URL("/mcp/editor", cmsBaseUrl);
    const upstreamRequest = new Request(upstreamUrl, {
      method: request.method,
      headers: cloneHeadersWithoutAuthorization(request.headers),
      body: request.body,
      duplex: "half",
      redirect: "manual",
    } as RequestInit & { duplex: "half" });
    upstreamRequest.headers.set("Authorization", `Bearer ${claims.cms_token}`);
    return fetchFn(upstreamRequest);
  }

  async function handle(request: Request): Promise<Response> {
    const pathname = getPathname(request);
    if (pathname === paths.oauthAuthorizationServerMetadataPath) {
      return jsonResponse({
        issuer,
        authorization_endpoint: appendPathToUrl(appBaseUrl, paths.authorizationPath),
        token_endpoint: appendPathToUrl(appBaseUrl, paths.tokenPath),
        registration_endpoint: appendPathToUrl(appBaseUrl, paths.registrationPath),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["editor:mcp"],
      });
    }

    if (pathname === paths.protectedResourceMetadataPath) {
      return jsonResponse({
        resource: resourceUrl,
        authorization_servers: [issuer],
        bearer_methods_supported: ["header"],
        scopes_supported: ["editor:mcp"],
        resource_name: config.resourceName ?? "agent-cms editor MCP proxy",
      });
    }

    if (pathname === paths.authorizationPath) {
      return handleAuthorize(request);
    }

    if (pathname === paths.tokenPath && request.method === "POST") {
      return handleToken(request);
    }

    if (pathname === paths.registrationPath && request.method === "POST") {
      return handleRegister(request);
    }

    if (pathname === paths.mcpPath) {
      return handleMcp(request);
    }

    return new Response("Not found", { status: 404 });
  }

  return {
    paths,
    fetch: handle,
  };
}
