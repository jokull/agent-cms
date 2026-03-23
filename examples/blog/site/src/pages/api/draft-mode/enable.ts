import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

/**
 * Enable draft preview mode.
 *
 * GET /api/draft-mode/enable?token=pvt_...&redirect=/posts/my-draft
 *
 * Validates the preview token against the CMS, sets a cookie, and redirects
 * to the content page. The cookie tells the middleware to pass the token
 * as X-Preview-Token on GraphQL requests, which makes the CMS serve drafts.
 */
export const GET: APIRoute = async ({ request, redirect }) => {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const rawRedirect = url.searchParams.get("redirect") ?? "/";

  if (!token) {
    return new Response("Missing token parameter", { status: 400 });
  }

  // Validate redirect is a safe relative path
  const redirectPath = safePath(rawRedirect);

  // Validate token against CMS
  const cms = env.CMS;
  const res = await cms.fetch(
    `http://cms/api/preview-tokens/validate?token=${encodeURIComponent(token)}`,
  );
  const body = (await res.json()) as { valid: boolean; expiresAt?: string };

  if (!body.valid) {
    return new Response("Invalid or expired preview token", { status: 401 });
  }

  // Calculate cookie max-age from token expiry
  const maxAge = body.expiresAt
    ? Math.max(0, Math.floor((new Date(body.expiresAt).getTime() - Date.now()) / 1000))
    : 86400;

  return new Response(null, {
    status: 307,
    headers: {
      Location: redirectPath,
      "Set-Cookie": `__agentcms_preview=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`,
      "Cache-Control": "no-store",
    },
  });
};

/** Reject absolute URLs, protocol-relative URLs, and other redirect tricks. */
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
