/**
 * The browser client. ONE client for the CMS procedures and the host's own.
 */
import { batchFetchTransport, createBrowserClient } from "result-rpc/client";
import { contract } from "./contract.js";

export const client = createBrowserClient({
  contract,
  transport: batchFetchTransport({ url: "/rpc" }),
});

export type BlocksClient = typeof client;
