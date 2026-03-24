import { cookies } from "next/headers";

/**
 * Fixed bar at the bottom of the page when draft mode is active.
 * Server component — reads the __agentcms_preview cookie directly.
 */
export async function PreviewBar() {
  const cookieStore = await cookies();
  const previewCookie = cookieStore.get("__agentcms_preview");
  if (!previewCookie?.value) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "1rem",
        padding: "0.5rem 1rem",
        background: "#1e293b",
        color: "#f8fafc",
        fontSize: "0.8rem",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <span style={{ fontWeight: 600 }}>Draft Preview</span>
      <a
        href="/api/draft-mode/disable?redirect=/"
        style={{ color: "#93c5fd", textDecoration: "underline" }}
      >
        Exit preview
      </a>
    </div>
  );
}
