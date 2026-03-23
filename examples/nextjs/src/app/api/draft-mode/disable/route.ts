import { draftMode } from "next/headers";
import { NextRequest } from "next/server";

/**
 * Disable draft preview mode.
 *
 * GET /api/draft-mode/disable?redirect=/
 */
export async function GET(request: NextRequest) {
  const rawRedirect = request.nextUrl.searchParams.get("redirect") ?? "/";
  const redirectPath = safePath(rawRedirect);

  const draft = await draftMode();
  draft.disable();

  return new Response(null, {
    status: 307,
    headers: {
      Location: redirectPath,
      "Set-Cookie": "__agentcms_preview=; Path=/; HttpOnly; Max-Age=0",
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
