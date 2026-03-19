import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createCmsAdminClient, createEditorMcpProxy } from "agent-cms";

const app = new Hono<{ Bindings: Env }>();

function getCookieFromRequest(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  const pairs = header.split(";").map((part) => part.trim());
  for (const pair of pairs) {
    const [key, ...rest] = pair.split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function createCmsBindingFetch(env: Env): typeof globalThis.fetch {
  const cmsOrigin = new URL(env.CMS_BASE_URL).origin;
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string"
      ? new URL(input)
      : input instanceof URL
        ? input
        : new URL(input.url);

    if (url.origin === cmsOrigin) {
      const request = input instanceof Request ? input : new Request(url, init);
      return env.CMS.fetch(request);
    }

    return fetch(input, init);
  };
}

function getEditorProxy(env: Env) {
  const cmsFetch = createCmsBindingFetch(env);
  return createEditorMcpProxy({
    appBaseUrl: env.APP_BASE_URL,
    cmsBaseUrl: env.CMS_BASE_URL,
    cmsWriteKey: env.CMS_WRITE_KEY,
    oauthSecret: env.OAUTH_SECRET,
    fetch: cmsFetch,
    mountPath: "/editor-access",
    getEditor: async (request: Request) => {
      const token = getCookieFromRequest(request, "editor_session");
      if (token !== "demo-editor") return null;
      return { id: "demo-editor", name: "Demo Editor" };
    },
    getLoginUrl: () => new URL("/login", env.APP_BASE_URL),
    cmsTokenTtlSeconds: 3600,
    oauthTokenTtlSeconds: 3600,
    resourceName: "Example app-land editor MCP gateway",
  });
}

app.get("/", (c) => {
  const proxy = getEditorProxy(c.env);
  return c.json({
    loginUrl: "/login",
    logoutUrl: "/logout",
    visualEditTokenUrl: "/api/editor-token",
    editorMcpUrl: `${c.env.APP_BASE_URL}${proxy.paths.mcpPath}`,
    cmsDirectMcpUrl: `${c.env.CMS_BASE_URL}/mcp`,
  });
});

app.get("/login", (c) => {
  const returnTo = c.req.query("returnTo") ?? "/";
  setCookie(c, "editor_session", "demo-editor", {
    httpOnly: true,
    sameSite: "Lax",
    secure: c.req.url.startsWith("https://"),
    path: "/",
    maxAge: 60 * 60,
  });
  return c.redirect(returnTo);
});

app.get("/logout", (c) => {
  deleteCookie(c, "editor_session", { path: "/" });
  return c.redirect("/");
});

app.get("/api/editor-token", async (c) => {
  const session = getCookie(c, "editor_session");
  if (session !== "demo-editor") {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const cmsAdmin = createCmsAdminClient({
    endpoint: c.env.CMS_BASE_URL,
    writeKey: c.env.CMS_WRITE_KEY,
    fetch: createCmsBindingFetch(c.env),
  });

  const token = await cmsAdmin.createEditorToken({
    name: "Demo Editor",
    expiresIn: 3600,
  });

  return c.json({
    endpoint: c.env.CMS_BASE_URL,
    token: token.token,
    expiresAt: token.expiresAt,
    cmsEditorMcpUrl: `${c.env.CMS_BASE_URL}/mcp/editor`,
    appEditorMcpUrl: `${c.env.APP_BASE_URL}/editor-access/mcp`,
  });
});

app.all("*", async (c, next) => {
  const proxy = getEditorProxy(c.env);
  const path = new URL(c.req.url).pathname;
  const handledPaths = new Set([
    proxy.paths.oauthAuthorizationServerMetadataPath,
    proxy.paths.protectedResourceMetadataPath,
    proxy.paths.authorizationPath,
    proxy.paths.tokenPath,
    proxy.paths.registrationPath,
    proxy.paths.mcpPath,
  ]);

  if (!handledPaths.has(path)) {
    return next();
  }

  return proxy.fetch(c.req.raw);
});

export default app;

interface Env {
  APP_BASE_URL: string;
  CMS_BASE_URL: string;
  CMS: Fetcher;
  CMS_WRITE_KEY: string;
  OAUTH_SECRET: string;
}
