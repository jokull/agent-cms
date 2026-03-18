import { useState, useCallback } from "react";
import { openAssetPicker } from "@agent-cms/visual-edit";
import { useCmsEdit } from "./context.js";
import { useCmsRecord } from "./cms-record.js";

export interface CmsImageProps {
  /** Asset ID in the CMS */
  assetId: string;
  /** Field API key — needed to swap asset reference on the record */
  fieldApiKey?: string;
  /** Called after a successful asset replacement — use to re-fetch/revalidate */
  onReplaced?: () => void;
  /** The rendered image (e.g. <img> element) */
  children: React.ReactNode;
}

/**
 * Wraps an image element. In edit mode, shows a hover overlay.
 * Clicking opens the asset picker modal to browse, search, upload, or select an asset.
 */
export function CmsImage({ assetId, fieldApiKey, onReplaced, children }: CmsImageProps) {
  const edit = useCmsEdit();
  const record = useCmsRecord();
  const [hovering, setHovering] = useState(false);

  const handleClick = useCallback(() => {
    if (!edit?.enabled || !edit.client) return;
    openAssetPicker({
      client: edit.client,
      currentAssetId: assetId,
      onSelect: async (selected) => {
        if (selected.id !== assetId && fieldApiKey && record) {
          // Swap the asset reference on the record
          await edit.client.patchField(
            {
              recordId: record.recordId,
              modelApiKey: record.modelApiKey,
              fieldApiKey,
              locale: record.locale,
            },
            selected.id,
          );
        }
        onReplaced?.();
      },
    });
  }, [edit, assetId, fieldApiKey, record, onReplaced]);

  if (!edit?.enabled) {
    return <>{children}</>;
  }

  return (
    <div
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{ position: "relative", cursor: "pointer", display: "inline-block" }}
      onClick={(e) => { e.stopPropagation(); handleClick(); }}
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
        Change image
      </div>
    </div>
  );
}
