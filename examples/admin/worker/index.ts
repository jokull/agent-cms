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
import type { CmsD1Database } from "agent-cms/lib";
import type { HostContext, HostUser } from "../src/contract.js";
import { err, ok } from "result-rpc";
import { createFetchHandler } from "result-rpc/server";
import { app, cms, contract, inventoryListContract, Unauthorized, whoamiContract } from "../src/contract.js";
import { cmsProcedures } from "../src/cms/procedures.js";

interface Env {
  DB: CmsD1Database;
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

function buildHandler(env: Env): (request: Request) => Promise<Response> {
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

let cached: ((request: Request) => Promise<Response>) | null = null;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/rpc") return Promise.resolve(new Response("not found", { status: 404 }));
    if (!cached) cached = buildHandler(env);
    return cached(request);
  },
};
