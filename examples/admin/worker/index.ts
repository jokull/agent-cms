/**
 * The host Worker. Mounts result-rpc at /rpc with the generated CMS fragments
 * merged into the host's own router (ADR 0004); the assets binding serves the
 * SPA for everything else.
 *
 * ⚠️ Everything is behind a DYNAMIC import inside `fetch`. The documented
 * pattern — build the contract and router at module scope — does not boot on
 * workerd: `result-rpc/server`'s `contract.js` evaluates
 * `new AbortController().signal` at module scope, and workerd rejects that with
 * "Disallowed operation called within global scope". `wrangler deploy
 * --dry-run` bundles it happily; only `wrangler dev` / a real isolate fails.
 * FRICTION.md #0 — the only thing that outright blocked this app.
 */
import type { CmsD1Database, CmsR2Bucket } from "agent-cms/lib";
import type { HostContext, HostUser } from "../src/contract.js";
import { err, ok } from "result-rpc";
import { createFetchHandler } from "result-rpc/server";
import { app, cms, contract, inventoryListContract, Unauthorized, whoamiContract } from "../src/contract.js";
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

  const authenticated = app
    .middleware<{}>()
    .errors({ Unauthorized })
    .use(async ({ context, errors, next }) =>
      context.user ? next({ context }) : err(errors.Unauthorized()),
    );

  const router = app.router({
    cms: cmsProcedures(app, cms, {
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
      whoami: app.implement(whoamiContract).handler(async ({ context }) =>
        ok(context.user ? { id: context.user.id, name: context.user.name } : { id: null, name: null }),
      ),
      inventory: {
        list: app.implement(inventoryListContract).handler(async ({ input }) =>
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
