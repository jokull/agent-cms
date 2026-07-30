/* Scaffolded by @agent-cms/codegen. YOURS TO EDIT — regeneration will not overwrite it. */

/**
 * Errors your mutation middleware can return.
 *
 * agent-cms declares no auth errors of its own (BYO-auth): it does not know how
 * you authenticate, so the gate — and the error it fails with — is yours. Every
 * error you list here is declared on every CMS mutation, which is what lets
 * result-rpc accept your middleware; a middleware error that is not declared is
 * rejected, at build time and again at runtime.
 *
 * Leave it empty if CMS mutations need no gate:
 *
 *   export const mutationErrors = {};
 *
 * Or declare your own, and return it from the middleware you pass as
 * `deps.mutationMiddleware`:
 *
 *   import { error } from "result-rpc";
 *   export const Unauthorized = error({ tag: "auth/unauthorized", httpStatus: 401 });
 *   export const mutationErrors = { Unauthorized };
 */
export const mutationErrors = {};
