import type { APIRoute } from "astro";

/**
 * Disable draft preview mode.
 *
 * GET /api/draft-mode/disable?redirect=/
 *
 * Clears the preview cookie and redirects.
 */
export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const rawRedirect = url.searchParams.get("redirect") ?? "/";
  const redirectPath = safePath(rawRedirect);

  return new Response(null, {
    status: 307,
    headers: {
      Location: redirectPath,
      "Set-Cookie": "__agentcms_preview=; Path=/; HttpOnly; Max-Age=0",
      "Cache-Control": "no-store",
    },
  });
};

function safePath(raw: string): string {
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  try {
    const parsed = new URL(raw, "https://placeholder.invalid");
    if (parsed.hostname !== "placeholder.invalid") return "/";
    return parsed.pathname + parsed.search;
  } catch {
    return "/";
  }
}
