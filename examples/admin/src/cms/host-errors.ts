/* Scaffolded by @agent-cms/codegen. YOURS TO EDIT — regeneration will not overwrite it. */
import { error } from "result-rpc";

/**
 * This app's own auth failure. agent-cms declares none (BYO-auth, ADR 0005):
 * it cannot know how you authenticate, so the gate and its error are yours.
 *
 * Listing it here declares it on every CMS mutation, which is what lets
 * result-rpc accept the middleware in worker/index.ts — contract-first means an
 * undeclared middleware error is rejected at build time and again at runtime.
 */
export const Unauthorized = error({ tag: "auth/unauthorized", httpStatus: 401 });

export const mutationErrors = { Unauthorized };
