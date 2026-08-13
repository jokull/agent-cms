/**
 * The HOST's contract. Browser-safe: imports the generated `contract.ts`
 * fragment (codecs + types) and never the generated `procedures.ts` (which
 * pulls agent-cms's Effect service layer in).
 *
 * One contract holds the CMS fragments AND the host's own procedures — the
 * "one client, one cache, one failure algebra" claim under test.
 */
import { rpc, wire } from "result-rpc";
import { cmsContract } from "./cms/contract.js";

/** Host context. No auth in this demo — a single constant viewer. */
export interface HostContext {
  readonly viewer: { readonly id: string; readonly name: string };
}

export const app = rpc.context<HostContext>();

/**
 * The CMS fragment: `post.*` collection + block payload unions + `assets.*`,
 * all typed from schema.json. Reads its mutation-error set from
 * `cms/host-errors.ts` (empty here — no gate).
 */
export const cms = cmsContract(app);

/** A host-owned procedure alongside the CMS, proving one client covers both. */
export const serverInfoContract = app
  .procedure()
  .output(wire.object({ stack: wire.string, modelCount: wire.integer() }))
  .query();

export const contract = app.contract({
  cms,
  host: { serverInfo: serverInfoContract },
});
