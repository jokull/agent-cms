import { useRef, useCallback, useState } from "react";
import { openMarkdownEditor } from "@agent-cms/visual-edit";
import type { DastDocument, CmsFieldContext } from "@agent-cms/visual-edit";
import { useCmsEdit } from "./context.js";
import { useCmsRecord } from "./cms-record.js";

export interface CmsTextProps {
  /** Record ID — inherited from CmsRecord if omitted */
  recordId?: string;
  /** Model API key — inherited from CmsRecord if omitted */
  modelApiKey?: string;
  /** Field API key */
  fieldApiKey: string;
  /** Locale code — inherited from CmsRecord if omitted */
  locale?: string;
  /** The current DAST document value */
  value: DastDocument;
  /** Called after a successful save — use to re-fetch/revalidate */
  onSaved?: () => void;
  /** Rendered content */
  children: React.ReactNode;
}

/**
 * Wraps structured text content. In edit mode, shows a hover overlay.
 * Clicking opens a markdown editor modal.
 *
 * When inside a `<CmsRecord>`, inherits `recordId`, `modelApiKey`, and `locale`.
 */
export function CmsText({
  recordId: recordIdProp,
  modelApiKey: modelApiKeyProp,
  fieldApiKey,
  locale: localeProp,
  value,
  onSaved,
  children,
}: CmsTextProps) {
  const edit = useCmsEdit();
  const record = useCmsRecord();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [hovering, setHovering] = useState(false);

  const recordId = recordIdProp ?? record?.recordId;
  const modelApiKey = modelApiKeyProp ?? record?.modelApiKey;
  const locale = localeProp ?? record?.locale;

  const ctx: CmsFieldContext | null =
    recordId && modelApiKey
      ? { recordId, modelApiKey, fieldApiKey, locale }
      : null;

  const handleClick = useCallback(() => {
    if (!edit?.enabled || !edit.client || !ctx) return;
    openMarkdownEditor({
      client: edit.client,
      ctx,
      dast: value,
      onSaved,
    });
  }, [edit, ctx, value, onSaved]);

  if (!edit?.enabled) {
    return <>{children}</>;
  }

  return (
    <div
      ref={wrapperRef}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{ position: "relative", cursor: "pointer" }}
      onClick={handleClick}
    >
      {children}
      {hovering && <EditOverlayBadge label={`Edit ${fieldApiKey}`} />}
    </div>
  );
}

function EditOverlayBadge({ label }: { label: string }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        border: "2px solid #3b82f6",
        borderRadius: "4px",
        pointerEvents: "none",
        zIndex: 99999,
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
        {label}
      </div>
    </div>
  );
}
