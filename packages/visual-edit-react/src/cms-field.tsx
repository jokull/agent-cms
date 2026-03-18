import { useRef, useCallback, useState, useEffect } from "react";
import type { CmsFieldContext } from "@agent-cms/visual-edit";
import { useCmsEdit } from "./context.js";
import { useCmsRecord } from "./cms-record.js";

export interface CmsFieldProps {
  /** Record ID — inherited from CmsRecord if omitted */
  recordId?: string;
  /** Model API key — inherited from CmsRecord if omitted */
  modelApiKey?: string;
  /** Field API key */
  fieldApiKey: string;
  /** Locale code — inherited from CmsRecord if omitted */
  locale?: string;
  /** The current field value */
  value: string;
  /** If true, render a textarea instead of an input */
  multiline?: boolean;
  /** Called after a successful save — use to re-fetch/revalidate */
  onSaved?: () => void;
  /** Rendered content */
  children: React.ReactNode;
}

/**
 * Wraps a simple string/text field. In edit mode, shows a hover overlay.
 * Clicking opens a floating inline editor anchored to the element.
 *
 * When inside a `<CmsRecord>`, inherits `recordId`, `modelApiKey`, and `locale`.
 */
export function CmsField({
  recordId: recordIdProp,
  modelApiKey: modelApiKeyProp,
  fieldApiKey,
  locale: localeProp,
  value,
  multiline = false,
  onSaved,
  children,
}: CmsFieldProps) {
  const edit = useCmsEdit();
  const record = useCmsRecord();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [hovering, setHovering] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const [saving, setSaving] = useState(false);

  const recordId = recordIdProp ?? record?.recordId;
  const modelApiKey = modelApiKeyProp ?? record?.modelApiKey;
  const locale = localeProp ?? record?.locale;

  useEffect(() => {
    setEditValue(value);
  }, [value]);

  const ctx: CmsFieldContext | null =
    recordId && modelApiKey
      ? { recordId, modelApiKey, fieldApiKey, locale }
      : null;

  const handleSave = useCallback(async () => {
    if (!edit?.enabled || !edit.client || !ctx || editValue === value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await edit.client.patchField(ctx, editValue);
      setEditing(false);
      onSaved?.();
    } catch (err) {
      console.error("CmsField save failed:", err);
    } finally {
      setSaving(false);
    }
  }, [edit, ctx, editValue, value, onSaved]);

  const handleCancel = useCallback(() => {
    setEditValue(value);
    setEditing(false);
  }, [value]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        handleCancel();
      } else if (e.key === "Enter" && (!multiline || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSave();
      }
    },
    [handleCancel, handleSave, multiline],
  );

  if (!edit?.enabled) {
    return <>{children}</>;
  }

  return (
    <div
      ref={wrapperRef}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{ position: "relative", cursor: "pointer" }}
      onClick={() => { if (!editing) setEditing(true); }}
    >
      {children}
      {hovering && !editing && <FieldOverlayBadge label={`Edit ${fieldApiKey}`} />}
      {editing && (
        <FloatingEditor
          value={editValue}
          multiline={multiline}
          saving={saving}
          onChange={setEditValue}
          onKeyDown={handleKeyDown}
          onSave={handleSave}
          onCancel={handleCancel}
        />
      )}
    </div>
  );
}

function FieldOverlayBadge({ label }: { label: string }) {
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

function FloatingEditor({
  value,
  multiline,
  saving,
  onChange,
  onKeyDown,
  onSave,
  onCancel,
}: {
  value: string;
  multiline: boolean;
  saving: boolean;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const sharedStyle: React.CSSProperties = {
    width: "100%",
    fontFamily: "system-ui, sans-serif",
    fontSize: 14,
    padding: "8px 12px",
    border: "2px solid #3b82f6",
    borderRadius: 6,
    outline: "none",
    boxSizing: "border-box",
  };

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 100000,
        background: "#fff",
        borderRadius: 8,
        boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
        padding: 8,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {multiline ? (
        <textarea
          ref={inputRef as React.RefObject<HTMLTextAreaElement>}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          rows={4}
          style={{ ...sharedStyle, resize: "vertical" }}
        />
      ) : (
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          style={sharedStyle}
        />
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 6 }}>
        <button
          onClick={onCancel}
          style={{
            padding: "4px 12px",
            borderRadius: 4,
            border: "1px solid #d1d5db",
            background: "#f9fafb",
            fontSize: 13,
            cursor: "pointer",
            fontFamily: "system-ui, sans-serif",
          }}
        >
          Cancel
        </button>
        <button
          onClick={onSave}
          disabled={saving}
          style={{
            padding: "4px 12px",
            borderRadius: 4,
            border: "none",
            background: "#3b82f6",
            color: "#fff",
            fontSize: 13,
            cursor: saving ? "wait" : "pointer",
            fontFamily: "system-ui, sans-serif",
          }}
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}
