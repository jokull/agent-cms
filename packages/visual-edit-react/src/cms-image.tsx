import { useState, useCallback } from "react";
import { openImagePicker } from "@agent-cms/visual-edit";
import { useCmsEdit } from "./context.js";

export interface CmsImageProps {
  /** Asset ID in the CMS */
  assetId: string;
  /** Called after a successful asset replacement — use to re-fetch/revalidate */
  onReplaced?: () => void;
  /** The rendered image (e.g. <img> element) */
  children: React.ReactNode;
}

/**
 * Wraps an image element. In edit mode, shows a hover overlay.
 * Clicking opens a file picker to replace the asset.
 */
export function CmsImage({ assetId, onReplaced, children }: CmsImageProps) {
  const edit = useCmsEdit();
  const [hovering, setHovering] = useState(false);

  const handleClick = useCallback(() => {
    if (!edit?.enabled || !edit.client) return;
    openImagePicker({
      client: edit.client,
      assetId,
      onReplaced,
    });
  }, [edit, assetId, onReplaced]);

  if (!edit?.enabled) {
    return <>{children}</>;
  }

  return (
    <div
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{ position: "relative", cursor: "pointer", display: "inline-block" }}
      onClick={handleClick}
    >
      {children}
      {hovering && <ImageOverlayBadge />}
    </div>
  );
}

function ImageOverlayBadge() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        border: "2px solid #3b82f6",
        borderRadius: "4px",
        pointerEvents: "none",
        zIndex: 99999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: -24,
          left: 0,
          background: "#3b82f6",
          color: "#fff",
          fontSize: 11,
          fontFamily: "system-ui, sans-serif",
          padding: "2px 6px",
          borderRadius: "3px 3px 0 0",
          whiteSpace: "nowrap",
          pointerEvents: "none",
        }}
      >
        Replace image
      </div>
    </div>
  );
}
