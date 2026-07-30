/**
 * The browser client. ONE client for CMS procedures and the host's own.
 */
import { batchFetchTransport, createBrowserClient } from "result-rpc/client";
import { boundaryShells, defineShell } from "result-rpc/react";
import { cmsShellClaims } from "@agent-cms/codegen/errors";
import { contract } from "./contract.js";

/** Dev "session": which user the transport claims to be. `null` = anonymous. */
let currentUser: string | null = "ada";

export function getCurrentUser(): string | null {
  return currentUser;
}

export function setCurrentUser(next: string | null): void {
  currentUser = next;
}

export const client = createBrowserClient({
  contract,
  transport: batchFetchTransport({
    url: "/rpc",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (currentUser) request.headers.set("x-admin-user", currentUser);
      return fetch(request);
    },
  }),
});

export type AdminClient = typeof client;

export const { TransportShell, StaleShell, DefectShell, BoundaryProvider, useConnectivity } =
  boundaryShells({ name: "admin" });

/**
 * ADR 0005's shell recipe: `cms/schema-drift` means "stale build — regenerate",
 * so a boundary shell owns it and it disappears from every component's union.
 */
export const CmsShell = defineShell({
  name: "cms",
  from: StaleShell,
  claims: cmsShellClaims,
  onError: (error) => {
    // A real app reloads to pick up a regenerated client. The proof just says
    // so out loud, so the drift path stays observable in the demo.
    console.error("[admin] schema drift — regenerate src/cms", error.data);
  },
});
