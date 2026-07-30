/**
 * The host Worker. Mounts result-rpc at /rpc with the generated CMS fragments
 * merged into the host's own router (ADR 0004); the assets binding serves the
 * SPA for everything else.
 *
 * Imports are static and the contract/router are built at module scope, as the
 * codegen README documents. An earlier version of this file used dynamic
 * imports to dodge a workerd "Disallowed operation called within global scope"
 * crash; that was a stale `link:`ed result-rpc `dist/`, not a real constraint
 * (FRICTION.md #0). The router itself is still built lazily below because it
 * needs the request origin for asset URLs.
 */
import type { CmsD1Database, CmsR2Bucket } from "agent-cms/lib";
import type { HostContext, HostUser } from "../src/contract.js";
import { err, ok } from "result-rpc";
import { createFetchHandler, serverRpc } from "result-rpc/server";
import { cms, contract, inventoryListContract, Unauthorized, whoamiContract } from "../src/contract.js";
import { cmsProcedures } from "../src/cms/procedures.js";

interface Env {
  DB: CmsD1Database;
  ASSETS?: CmsR2Bucket;
  ENVIRONMENT?: string;
}

/**
 * Trivial dev auth. The SPA sends `x-admin-user: <id>`; an absent/unknown
 * header is an anonymous session, which is how the app demonstrates a mutation
 * failing with the HOST's Unauthorized — agent-cms declares no auth tag.
 */
const USERS: Record<string, HostUser> = {
  ada: { id: "ada", name: "Ada (editor)" },
  grace: { id: "grace", name: "Grace (editor)" },
};

function userFrom(request: Request): HostUser | null {
  const header = request.headers.get("x-admin-user");
  if (!header) return null;
  return USERS[header] ?? null;
}

/** Static non-CMS data — deliberately not in the CMS, joined in the UI by slug. */
const INVENTORY: ReadonlyArray<{ slug: string; seatsLeft: number; priceJpy: number }> = [
  { slug: "the-type-sandwich", seatsLeft: 4, priceJpy: 248000 },
  { slug: "dast-is-the-point", seatsLeft: 0, priceJpy: 132000 },
  { slug: "edge-first-content", seatsLeft: 11, priceJpy: 396000 },
];

function buildHandler(env: Env, origin: string): (request: Request) => Promise<Response> {
  void contract;

  // The contract in ../src/contract.ts is declared with `rpc.context` — the
  // browser-safe factory, which by design has no middleware/router/implement.
  // Implementations use `serverRpc.context` over the same HostContext. That
  // split is what makes ADR 0004's client boundary a type error rather than a
  // convention: the browser bundle cannot reach a handler.
  const server = serverRpc.context<HostContext>();

  const authenticated = server
    .middleware<{}>()
    .errors({ Unauthorized })
    .use(async ({ context, errors, next }) =>
      context.user ? next({ context }) : err(errors.Unauthorized()),
    );

  const router = server.router({
    cms: cmsProcedures(server, cms, {
      DB: env.DB,
      // Asset URLs. No ASSET_BASE_URL is configured for this app on purpose:
      // the CMS then resolves `<origin>/assets/<id>/<filename>`, the route
      // served below straight out of R2 — so every asset row and every media
      // field value the SPA reads carries a URL that actually loads.
      assets: { r2Bucket: env.ASSETS, originUrl: origin },
      actor: (context: HostContext) =>
        context.user ? { type: "editor", label: context.user.id } : null,
      mutationMiddleware: authenticated,
    }),
    host: {
      whoami: server.implement(whoamiContract).handler(async ({ context }) =>
        ok(context.user ? { id: context.user.id, name: context.user.name } : { id: null, name: null }),
      ),
      inventory: {
        list: server.implement(inventoryListContract).handler(async ({ input }) =>
          ok(INVENTORY.filter((row) => input.slugs.includes(row.slug))),
        ),
      },
    },
  });

  return createFetchHandler({
    router,
    endpoint: "/rpc",
    createContext: ({ request }: { request: Request }): HostContext => ({ user: userFrom(request) }),
  });
}

/**
 * `GET /assets/:id/:filename` — the asset-serving route the CMS's canonical URL
 * points at when no ASSET_BASE_URL is configured. Mirrors agent-cms's own
 * (`src/http/router.ts`): look the r2_key up in D1, stream the object from R2.
 */
async function serveAsset(env: Env, assetId: string): Promise<Response> {
  if (!env.ASSETS) return new Response("assets not configured", { status: 501 });
  const row = await env.DB.prepare("SELECT r2_key FROM assets WHERE id = ?").bind(assetId).first();
  const r2Key = row === null ? null : Reflect.get(row, "r2_key");
  if (typeof r2Key !== "string") return new Response("not found", { status: 404 });
  const object = await env.ASSETS.get(r2Key);
  if (!object) return new Response("not found", { status: 404 });
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

let cached: ((request: Request) => Promise<Response>) | null = null;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Local stand-in for Cloudflare Image Resizing: `/cdn-cgi/image/<opts>/<src>`
    // is served by the edge in production, but wrangler dev has no such route,
    // so drop the options and serve the original. The UI code is identical in
    // both places — it always composes URLs with `assetUrl()`.
    if (url.pathname.startsWith("/cdn-cgi/image/")) {
      const rest = url.pathname.slice("/cdn-cgi/image/".length);
      const slash = rest.indexOf("/");
      const source = slash === -1 ? "" : rest.slice(slash);
      return this.fetch(new Request(new URL(source, url), request), env);
    }
    if (url.pathname.startsWith("/assets/")) {
      const assetId = url.pathname.slice("/assets/".length).split("/")[0];
      return assetId ? serveAsset(env, assetId) : Promise.resolve(new Response("not found", { status: 404 }));
    }
    if (url.pathname !== "/rpc") return Promise.resolve(new Response("not found", { status: 404 }));
    if (!cached) cached = buildHandler(env, url.origin);
    return cached(request);
  },
};
