const CMS_GRAPHQL_URL = import.meta.env.CMS_GRAPHQL_URL ?? "http://localhost:8787/graphql";

export async function graphqlQuery<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
  options?: { includeDrafts?: boolean },
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options?.includeDrafts) {
    headers["X-Include-Drafts"] = "true";
  }
  const res = await fetch(CMS_GRAPHQL_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`GraphQL request failed: ${res.status}`);
  }

  const json = (await res.json()) as { data: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`);
  }

  return json.data;
}
