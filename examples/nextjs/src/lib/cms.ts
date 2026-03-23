/**
 * GraphQL client for agent-cms with draft preview support.
 *
 * When a preview token is provided, it's sent as X-Preview-Token
 * and the response bypasses all caches.
 */

const CMS_URL = process.env.CMS_URL ?? "http://localhost:8787";

interface QueryOptions {
  previewToken?: string;
}

export async function cmsQuery<T>(
  query: string,
  variables?: Record<string, unknown>,
  options?: QueryOptions,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (options?.previewToken) {
    headers["X-Preview-Token"] = options.previewToken;
  }

  const res = await fetch(`${CMS_URL}/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
    // Bypass Next.js data cache in preview mode
    cache: options?.previewToken ? "no-store" : "force-cache",
    next: options?.previewToken ? { revalidate: 0 } : { revalidate: 60 },
  });

  if (!res.ok) {
    throw new Error(`GraphQL request failed: ${res.status}`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${json.errors.map((e: { message: string }) => e.message).join(", ")}`);
  }

  return json.data;
}
