import type { TadaDocumentNode } from "gql.tada";
import { print } from "graphql";
import type { CmsRequestTrace } from "../lib/cms-trace";

interface GqlFetchOptions {
  trace?: CmsRequestTrace;
}

function inferOperationName(query: string): string | null {
  const match = query.match(/\b(query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  return match?.[2] ?? null;
}

/**
 * Execute a typed GraphQL query against the CMS via service binding.
 *
 * In production: uses the CMS service binding (zero-latency worker-to-worker).
 * In local dev: falls back to HTTP fetch against localhost.
 */
export async function gqlFetch<TResult, TVariables extends Record<string, unknown>>(
  cms: { fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response> },
  document: TadaDocumentNode<TResult, TVariables>,
  ...args: TVariables extends Record<string, never> ? [options?: GqlFetchOptions] : [variables: TVariables, options?: GqlFetchOptions]
): Promise<TResult> {
  const variables = (args.length > 0 ? args[0] : undefined) as TVariables | undefined;
  const options = (args.length > 1 ? args[1] : args[0]) as GqlFetchOptions | undefined;
  const trace = options?.trace;

  const printed = print(document);
  const operationName = inferOperationName(printed);
  const printMs = 0;
  const fetchStartedAt = performance.now();
  const response = await cms.fetch("http://cms/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(trace ? { "X-Trace-Id": trace.traceId } : {}),
      ...(trace?.enabled ? { "X-Bench-Trace": "1" } : {}),
    },
    body: JSON.stringify({
      query: printed,
      variables: variables ?? {},
    }),
  });
  const fetchMs = performance.now() - fetchStartedAt;

  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
  }

  const parseStartedAt = performance.now();
  const json = (await response.json()) as { data?: TResult; errors?: Array<{ message: string }> };
  const parseMs = performance.now() - parseStartedAt;

  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`);
  }

  if (!json.data) {
    throw new Error("GraphQL response missing data");
  }

  if (trace) {
    const entry = {
      operationName,
      printMs: Number(printMs.toFixed(3)),
      fetchMs: Number(fetchMs.toFixed(3)),
      parseMs: Number(parseMs.toFixed(3)),
      totalMs: Number((printMs + fetchMs + parseMs).toFixed(3)),
      responseStatus: response.status,
      responseBytes: Number(response.headers.get("content-length") ?? "0"),
      cmsRequestMs: Number(response.headers.get("X-Cms-Request-Ms") ?? "0"),
      cmsYogaMs: Number(response.headers.get("X-Cms-Yoga-Ms") ?? "0"),
      cmsSchemaWaitMs: Number(response.headers.get("X-Cms-Schema-Wait-Ms") ?? "0"),
      cmsSchemaBuildMs: Number(response.headers.get("X-Cms-Schema-Build-Ms") ?? "0"),
      cmsSchemaCache: response.headers.get("X-Cms-Schema-Cache"),
      sqlStatementCount: Number(response.headers.get("X-Sql-Statement-Count") ?? "0"),
      sqlTotalMs: Number(response.headers.get("X-Sql-Total-Ms") ?? "0"),
      sqlSlowestSamplesMs: (response.headers.get("X-Sql-Slowest-Ms") ?? "")
        .split(",")
        .filter(Boolean)
        .map((value) => Number(value)),
    };
    trace.queries.push(entry);
    if (trace.enabled) {
      console.info(JSON.stringify({
        scope: "site.cms",
        traceId: trace.traceId,
        ...entry,
      }));
    }
  }

  return json.data;
}
