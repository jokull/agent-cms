import { createContext, useContext, useState, useCallback } from "react";
import { useCmsEdit } from "./context.js";

export type RecordStatus = "draft" | "published" | "updated";

interface CmsRecordContextValue {
  recordId: string;
  modelApiKey: string;
  locale?: string;
}

const CmsRecordContext = createContext<CmsRecordContextValue | null>(null);

/** Read the record context set by a parent <CmsRecord>. */
export function useCmsRecord(): CmsRecordContextValue | null {
  return useContext(CmsRecordContext);
}

export interface CmsRecordProps {
  /** Record ID */
  recordId: string;
  /** Model API key */
  modelApiKey: string;
  /** Locale code — inherited by child CmsField/CmsText components */
  locale?: string;
  /** Current publish status of the record */
  status?: RecordStatus;
  /** Called after a successful publish — use to re-fetch/revalidate */
  onPublished?: () => void;
  children: React.ReactNode;
}

/**
 * Wraps content belonging to a single CMS record.
 *
 * - Provides `recordId`, `modelApiKey`, and `locale` to child
 *   `CmsField`, `CmsText`, and `CmsImage` components via context.
 * - When `status` is "draft" or "updated", renders a publish bar
 *   (only in edit mode).
 *
 * ```tsx
 * <CmsRecord recordId={page.id} modelApiKey="page" status={page._status} locale="en">
 *   <CmsField fieldApiKey="title" value={page.title}>
 *     <h1>{page.title}</h1>
 *   </CmsField>
 * </CmsRecord>
 * ```
 */
export function CmsRecord({
  recordId,
  modelApiKey,
  locale,
  status,
  onPublished,
  children,
}: CmsRecordProps) {
  const edit = useCmsEdit();
  const hasUnpublishedChanges = status === "draft" || status === "updated";

  return (
    <CmsRecordContext value={{ recordId, modelApiKey, locale }}>
      {edit?.enabled && hasUnpublishedChanges && status && (
        <PublishBar
          recordId={recordId}
          modelApiKey={modelApiKey}
          status={status}
          onPublished={onPublished}
        />
      )}
      {children}
    </CmsRecordContext>
  );
}

function PublishBar({
  recordId,
  modelApiKey,
  status,
  onPublished,
}: {
  recordId: string;
  modelApiKey: string;
  status: "draft" | "updated";
  onPublished?: () => void;
}) {
  const edit = useCmsEdit();
  const [publishing, setPublishing] = useState(false);

  const handlePublish = useCallback(async () => {
    if (!edit?.client) return;
    setPublishing(true);
    try {
      await edit.client.publishRecord(recordId, modelApiKey);
      onPublished?.();
    } catch (err) {
      console.error("Publish failed:", err);
    } finally {
      setPublishing(false);
    }
  }, [edit, recordId, modelApiKey, onPublished]);

  const label = status === "draft" ? "New draft" : "Unpublished changes";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 16px",
        marginBottom: "1.5rem",
        background: "#fffbeb",
        border: "1px solid #fbbf24",
        borderRadius: 8,
        fontFamily: "system-ui, sans-serif",
        fontSize: 14,
      }}
    >
      <span
        style={{
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: "#f59e0b",
          flexShrink: 0,
        }}
      />
      <span style={{ flex: 1, color: "#92400e" }}>{label}</span>
      <button
        onClick={handlePublish}
        disabled={publishing}
        style={{
          padding: "6px 16px",
          borderRadius: 6,
          border: "none",
          background: "#059669",
          color: "#fff",
          fontSize: 13,
          fontWeight: 600,
          cursor: publishing ? "wait" : "pointer",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        {publishing ? "Publishing..." : "Publish"}
      </button>
    </div>
  );
}
