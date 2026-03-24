const CMS_URL = process.env.CMS_URL ?? "http://localhost:8787";

/**
 * Enable draft preview mode.
 *
 * GET /api/draft-mode/enable?token=pvt_...&redirect=/posts/my-draft
 *
 * Validates the preview token against the CMS, sets the __agentcms_preview
 * cookie, and redirects to the content page.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const rawRedirect = url.searchParams.get("redirect") ?? "/";

  if (!token) {
    return new Response("Missing token parameter", { status: 400 });
  }

  const redirectPath = safePath(rawRedirect);

  // Validate token against CMS
  const res = await fetch(
    `${CMS_URL}/api/preview-tokens/validate?token=${encodeURIComponent(token)}`,
  );
  const body = (await res.json()) as { valid: boolean; expiresAt?: string };

  if (!body.valid) {
    return new Response("Invalid or expired preview token", { status: 401 });
  }

  const maxAge = body.expiresAt
    ? Math.max(
        0,
        Math.floor(
          (new Date(body.expiresAt).getTime() - Date.now()) / 1000,
        ),
      )
    : 86400;

  // Redirect with the CMS preview cookie
  return new Response(null, {
    status: 307,
    headers: {
      Location: redirectPath,
      // SameSite=None for iframe compatibility (DatoCMS-style preview panels)
      "Set-Cookie": `__agentcms_preview=${token}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${maxAge}`,
    },
  });
}

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
