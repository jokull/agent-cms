/**
 * The HOST's contract. Browser-safe: it imports the generated `contract.ts`
 * fragment (codecs + types) and never the generated `procedures.ts` (which
 * pulls agent-cms's Effect service layer in).
 *
 * ADR 0004's claim under test: "one client, one cache, one failure algebra"
 * — the CMS fragments and this app's OWN procedures live in one contract.
 */
import { error, rpc, wire } from "result-rpc";
import { cmsContract } from "./cms/contract.js";

/** The host's own auth failure. agent-cms declares none (BYO-auth, ADR 0005). */
export const Unauthorized = error({ tag: "auth/unauthorized", httpStatus: 401 });

export interface HostUser {
  id: string;
  name: string;
}

export interface HostContext {
  user: HostUser | null;
}

export const app = rpc.context<HostContext>();

/**
 * Declared once and shared by contract + router. `mutationErrors` is required:
 * result-rpc is contract-first, so the middleware's error must be declared on
 * every CMS mutation before a middleware may contribute it.
 */
export const cms = cmsContract(app, { mutationErrors: { Unauthorized } });

export const whoamiContract = app
  .procedure()
  .output(
    wire.object({
      id: wire.union([wire.string, wire.null] as const),
      name: wire.union([wire.string, wire.null] as const),
    }),
  )
  .query();

/** Non-CMS data, in the same client — the Trip To Japan motivating case. */
export const inventoryListContract = app
  .procedure()
  .input(wire.object({ slugs: wire.array(wire.string) }))
  .output(
    wire.array(
      wire.object({
        slug: wire.string,
        seatsLeft: wire.integer(),
        priceJpy: wire.integer(),
      }),
    ),
  )
  .query();

export const contract = app.contract({
  cms,
  host: {
    whoami: whoamiContract,
    inventory: { list: inventoryListContract },
  },
});
