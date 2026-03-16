import type { TadaDocumentNode } from "gql.tada";
import { print } from "graphql";

/**
 * Execute a typed GraphQL query against the CMS via service binding.
 *
 * In production: uses the CMS service binding (zero-latency worker-to-worker).
 * In local dev: falls back to HTTP fetch against localhost.
 */
export async function gqlFetch<TResult, TVariables extends Record<string, unknown>>(
  cms: { fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response> },
  document: TadaDocumentNode<TResult, TVariables>,
  ...[variables]: TVariables extends Record<string, never> ? [] : [TVariables]
): Promise<TResult> {
  const response = await cms.fetch("http://cms/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: print(document),
      variables: variables ?? {},
    }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as { data?: TResult; errors?: Array<{ message: string }> };

  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`);
  }

  if (!json.data) {
    throw new Error("GraphQL response missing data");
  }

  return json.data;
}
