/**
 * Overlay and editor UI primitives.
 * Renders edit affordances and modal editors using imperative DOM manipulation.
 * All styles are inline — no CSS imports required.
 */

import type { CmsFieldContext } from "./types.js";
import type { DastDocument, PreservationMap } from "./markdown.js";
import { CmsClient } from "./client.js";
import { dastToEditableMarkdown, editableMarkdownToDast } from "./markdown.js";

// ---------------------------------------------------------------------------
// Overlay highlight
// ---------------------------------------------------------------------------

const OVERLAY_ATTR = "data-cms-overlay";

const overlayStyles: Partial<CSSStyleDeclaration> = {
  position: "absolute",
  pointerEvents: "none",
  border: "2px solid #3b82f6",
  borderRadius: "4px",
  zIndex: "99999",
  transition: "opacity 120ms ease",
};

const badgeStyles: Partial<CSSStyleDeclaration> = {
  position: "absolute",
  top: "-24px",
  left: "0",
  background: "#3b82f6",
  color: "#fff",
  fontSize: "11px",
  fontFamily: "system-ui, sans-serif",
  padding: "2px 6px",
  borderRadius: "3px 3px 0 0",
  pointerEvents: "auto",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

function applyStyles(el: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
  Object.assign(el.style, styles);
}

export function createOverlay(target: HTMLElement, label: string, onClick: () => void): () => void {
  const overlay = document.createElement("div");
  overlay.setAttribute(OVERLAY_ATTR, "");
  applyStyles(overlay, overlayStyles);

  const badge = document.createElement("div");
  badge.textContent = label;
  applyStyles(badge, badgeStyles);
  badge.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });

  overlay.appendChild(badge);
  document.body.appendChild(overlay);

  function reposition() {
    const rect = target.getBoundingClientRect();
    overlay.style.top = `${rect.top + window.scrollY}px`;
    overlay.style.left = `${rect.left + window.scrollX}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
  }

  reposition();

  return () => overlay.remove();
}

// ---------------------------------------------------------------------------
// Markdown editor modal
// ---------------------------------------------------------------------------

const modalBackdropStyles: Partial<CSSStyleDeclaration> = {
  position: "fixed",
  inset: "0",
  background: "rgba(0,0,0,0.5)",
  zIndex: "100000",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const modalPanelStyles: Partial<CSSStyleDeclaration> = {
  background: "#fff",
  borderRadius: "8px",
  padding: "24px",
  width: "640px",
  maxWidth: "90vw",
  maxHeight: "80vh",
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  fontFamily: "system-ui, sans-serif",
  boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
};

const textareaStyles: Partial<CSSStyleDeclaration> = {
  width: "100%",
  minHeight: "300px",
  fontFamily: "'SF Mono', 'Fira Code', monospace",
  fontSize: "14px",
  lineHeight: "1.6",
  padding: "12px",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  resize: "vertical",
  outline: "none",
  boxSizing: "border-box",
};

const buttonBaseStyles: Partial<CSSStyleDeclaration> = {
  padding: "8px 16px",
  borderRadius: "6px",
  fontSize: "14px",
  fontFamily: "system-ui, sans-serif",
  cursor: "pointer",
  border: "none",
};

export interface MarkdownEditorOptions {
  client: CmsClient;
  ctx: CmsFieldContext;
  dast: DastDocument;
  onSaved?: () => void;
}

export function openMarkdownEditor(opts: MarkdownEditorOptions): () => void {
  const { client, ctx, dast, onSaved } = opts;
  const { markdown, preservation } = dastToEditableMarkdown(dast);

  const backdrop = document.createElement("div");
  applyStyles(backdrop, modalBackdropStyles);

  const panel = document.createElement("div");
  applyStyles(panel, modalPanelStyles);

  const title = document.createElement("div");
  title.textContent = `Edit ${ctx.fieldApiKey}`;
  title.style.fontWeight = "600";
  title.style.fontSize = "16px";

  const textarea = document.createElement("textarea");
  applyStyles(textarea, textareaStyles);
  textarea.value = markdown;
  textarea.addEventListener("focus", () => { textarea.style.borderColor = "#3b82f6"; });
  textarea.addEventListener("blur", () => { textarea.style.borderColor = "#d1d5db"; });

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.justifyContent = "flex-end";
  actions.style.gap = "8px";

  const cancelBtn = document.createElement("button");
  applyStyles(cancelBtn, buttonBaseStyles);
  cancelBtn.style.background = "#f3f4f6";
  cancelBtn.style.color = "#374151";
  cancelBtn.textContent = "Cancel";

  const saveBtn = document.createElement("button");
  applyStyles(saveBtn, buttonBaseStyles);
  saveBtn.style.background = "#3b82f6";
  saveBtn.style.color = "#fff";
  saveBtn.textContent = "Save";

  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  panel.appendChild(title);
  panel.appendChild(textarea);
  panel.appendChild(actions);
  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);

  textarea.focus();

  function close() {
    backdrop.remove();
  }

  cancelBtn.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  saveBtn.addEventListener("click", async () => {
    if (textarea.value === markdown) {
      close();
      return;
    }
    saveBtn.textContent = "Saving…";
    saveBtn.setAttribute("disabled", "");
    const newDast = editableMarkdownToDast(textarea.value, preservation);
    const value = { value: newDast, blocks: {} };
    await client.patchField(ctx, value);
    close();
    onSaved?.();
  });

  return close;
}

// ---------------------------------------------------------------------------
// Image picker
// ---------------------------------------------------------------------------

export interface ImagePickerOptions {
  client: CmsClient;
  assetId: string;
  onReplaced?: () => void;
}

export function openImagePicker(opts: ImagePickerOptions): void {
  const { client, assetId, onReplaced } = opts;

  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.style.display = "none";

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;

    // Read dimensions
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = async () => {
      URL.revokeObjectURL(url);
      await client.replaceAsset(assetId, file, {
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
      onReplaced?.();
    };

    img.src = url;
  });

  document.body.appendChild(input);
  input.click();
  input.remove();
}
