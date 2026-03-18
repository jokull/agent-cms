/**
 * Overlay and editor UI primitives.
 * Renders edit affordances and modal editors using imperative DOM manipulation.
 * All styles are inline — no CSS imports required.
 */

import type { CmsFieldContext } from "./types.js";
import type { DastDocument, PreservationMap } from "./markdown.js";
import { CmsClient } from "./client.js";
import type { Asset } from "./client.js";
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

/** @deprecated Use `openAssetPicker` instead. */
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

// ---------------------------------------------------------------------------
// Asset picker modal
// ---------------------------------------------------------------------------

export interface AssetPickerOptions {
  client: CmsClient;
  currentAssetId?: string;
  onSelect?: (asset: { id: string; alt: string | null; title: string | null }) => void;
}

export function openAssetPicker(opts: AssetPickerOptions): () => void {
  const { client, currentAssetId, onSelect } = opts;
  const endpoint = client.getEndpoint();

  let selectedAsset: Asset | null = null;
  let assets: Asset[] = [];
  let total = 0;
  let currentPage = 1;
  let searchQuery = "";
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // --- DOM structure ---
  const backdrop = document.createElement("div");
  applyStyles(backdrop, {
    ...modalBackdropStyles,
    alignItems: "flex-start",
    paddingTop: "10vh",
  });

  const panel = document.createElement("div");
  applyStyles(panel, {
    background: "#fff",
    borderRadius: "8px",
    width: "900px",
    maxWidth: "95vw",
    maxHeight: "80vh",
    display: "flex",
    flexDirection: "column",
    fontFamily: "system-ui, sans-serif",
    boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
    overflow: "hidden",
  });

  // --- Header ---
  const header = document.createElement("div");
  applyStyles(header, {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "16px 20px",
    borderBottom: "1px solid #e5e7eb",
    flexShrink: "0",
  });

  const titleEl = document.createElement("div");
  titleEl.textContent = "Select asset";
  applyStyles(titleEl, { fontWeight: "600", fontSize: "16px", flexShrink: "0" });

  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.placeholder = "Search assets…";
  applyStyles(searchInput, {
    flex: "1",
    padding: "6px 10px",
    border: "1px solid #d1d5db",
    borderRadius: "6px",
    fontSize: "14px",
    outline: "none",
    fontFamily: "system-ui, sans-serif",
  });

  const uploadBtn = document.createElement("button");
  applyStyles(uploadBtn, { ...buttonBaseStyles, background: "#f3f4f6", color: "#374151" });
  uploadBtn.textContent = "Upload new";

  header.appendChild(titleEl);
  header.appendChild(searchInput);
  header.appendChild(uploadBtn);

  // --- Content area ---
  const content = document.createElement("div");
  applyStyles(content, {
    display: "flex",
    flex: "1",
    overflow: "hidden",
    minHeight: "0",
  });

  // Thumbnail grid wrapper
  const gridWrapper = document.createElement("div");
  applyStyles(gridWrapper, {
    flex: "1",
    overflowY: "auto",
    padding: "16px",
  });

  const grid = document.createElement("div");
  applyStyles(grid, {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: "12px",
  });
  gridWrapper.appendChild(grid);

  const loadMoreBtn = document.createElement("button");
  applyStyles(loadMoreBtn, {
    ...buttonBaseStyles,
    background: "#f3f4f6",
    color: "#374151",
    width: "100%",
    marginTop: "12px",
    display: "none",
  });
  loadMoreBtn.textContent = "Load more";
  gridWrapper.appendChild(loadMoreBtn);

  // Detail sidebar
  const sidebar = document.createElement("div");
  applyStyles(sidebar, {
    width: "280px",
    borderLeft: "1px solid #e5e7eb",
    padding: "16px",
    overflowY: "auto",
    display: "none",
    flexDirection: "column",
    gap: "12px",
    flexShrink: "0",
  });

  content.appendChild(gridWrapper);
  content.appendChild(sidebar);

  // --- Footer ---
  const footer = document.createElement("div");
  applyStyles(footer, {
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
    padding: "12px 20px",
    borderTop: "1px solid #e5e7eb",
    flexShrink: "0",
  });

  const cancelBtn = document.createElement("button");
  applyStyles(cancelBtn, { ...buttonBaseStyles, background: "#f3f4f6", color: "#374151" });
  cancelBtn.textContent = "Cancel";

  const selectBtn = document.createElement("button");
  applyStyles(selectBtn, { ...buttonBaseStyles, background: "#3b82f6", color: "#fff", opacity: "0.5" });
  selectBtn.textContent = "Select";
  selectBtn.disabled = true;

  footer.appendChild(cancelBtn);
  footer.appendChild(selectBtn);

  panel.appendChild(header);
  panel.appendChild(content);
  panel.appendChild(footer);
  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);

  searchInput.focus();

  // --- Rendering helpers ---
  function thumbnailUrl(asset: Asset): string {
    return `${endpoint}/assets/${asset.id}/${encodeURIComponent(asset.filename)}`;
  }

  function renderCard(asset: Asset): HTMLElement {
    const card = document.createElement("div");
    applyStyles(card, {
      borderRadius: "6px",
      border: selectedAsset?.id === asset.id ? "2px solid #3b82f6" : "2px solid #e5e7eb",
      overflow: "hidden",
      cursor: "pointer",
      background: "#f9fafb",
    });

    const imgWrap = document.createElement("div");
    applyStyles(imgWrap, {
      width: "100%",
      height: "120px",
      overflow: "hidden",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "#f3f4f6",
    });

    if (asset.mime_type.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = thumbnailUrl(asset);
      img.loading = "lazy";
      applyStyles(img, { width: "100%", height: "100%", objectFit: "cover" });
      imgWrap.appendChild(img);
    } else {
      const icon = document.createElement("div");
      icon.textContent = asset.mime_type.split("/")[1]?.toUpperCase() ?? "FILE";
      applyStyles(icon, { fontSize: "11px", color: "#9ca3af", fontWeight: "600" });
      imgWrap.appendChild(icon);
    }

    const label = document.createElement("div");
    label.textContent = asset.filename;
    applyStyles(label, {
      padding: "4px 6px",
      fontSize: "11px",
      color: "#374151",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
    });

    card.appendChild(imgWrap);
    card.appendChild(label);

    card.addEventListener("click", () => selectAsset(asset));
    card.addEventListener("dblclick", () => {
      selectAsset(asset);
      confirmSelection();
    });

    return card;
  }

  function renderGrid() {
    grid.innerHTML = "";
    for (const asset of assets) {
      grid.appendChild(renderCard(asset));
    }
    loadMoreBtn.style.display = assets.length < total ? "block" : "none";
  }

  function renderSidebar() {
    sidebar.innerHTML = "";
    if (!selectedAsset) {
      sidebar.style.display = "none";
      return;
    }
    sidebar.style.display = "flex";

    const asset = selectedAsset;

    // Preview
    if (asset.mime_type.startsWith("image/")) {
      const preview = document.createElement("img");
      preview.src = thumbnailUrl(asset);
      applyStyles(preview, { width: "100%", borderRadius: "6px", maxHeight: "200px", objectFit: "contain" });
      sidebar.appendChild(preview);
    }

    // Info
    const info = document.createElement("div");
    info.innerHTML = `<div style="font-weight:600;font-size:13px;word-break:break-all">${asset.filename}</div>`;
    if (asset.width && asset.height) {
      info.innerHTML += `<div style="font-size:12px;color:#6b7280">${asset.width} × ${asset.height}px</div>`;
    }
    sidebar.appendChild(info);

    // Alt input
    const altLabel = document.createElement("label");
    altLabel.textContent = "Alt text";
    applyStyles(altLabel, { fontSize: "12px", fontWeight: "600", color: "#374151" });
    const altInput = document.createElement("input");
    altInput.type = "text";
    altInput.value = asset.alt ?? "";
    applyStyles(altInput, {
      width: "100%",
      padding: "6px 8px",
      border: "1px solid #d1d5db",
      borderRadius: "4px",
      fontSize: "13px",
      boxSizing: "border-box",
      fontFamily: "system-ui, sans-serif",
    });
    sidebar.appendChild(altLabel);
    sidebar.appendChild(altInput);

    // Title input
    const titleLabel = document.createElement("label");
    titleLabel.textContent = "Title / caption";
    applyStyles(titleLabel, { fontSize: "12px", fontWeight: "600", color: "#374151" });
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.value = asset.title ?? "";
    applyStyles(titleInput, {
      width: "100%",
      padding: "6px 8px",
      border: "1px solid #d1d5db",
      borderRadius: "4px",
      fontSize: "13px",
      boxSizing: "border-box",
      fontFamily: "system-ui, sans-serif",
    });
    sidebar.appendChild(titleLabel);
    sidebar.appendChild(titleInput);

    // Save metadata button
    const saveMetaBtn = document.createElement("button");
    applyStyles(saveMetaBtn, { ...buttonBaseStyles, background: "#f3f4f6", color: "#374151", width: "100%" });
    saveMetaBtn.textContent = "Save metadata";
    saveMetaBtn.addEventListener("click", async () => {
      saveMetaBtn.textContent = "Saving…";
      saveMetaBtn.disabled = true;
      await client.updateAssetMetadata(asset.id, {
        alt: altInput.value || undefined,
        title: titleInput.value || undefined,
      });
      asset.alt = altInput.value || null;
      asset.title = titleInput.value || null;
      saveMetaBtn.textContent = "Saved!";
      setTimeout(() => {
        saveMetaBtn.textContent = "Save metadata";
        saveMetaBtn.disabled = false;
      }, 1500);
    });
    sidebar.appendChild(saveMetaBtn);
  }

  function selectAsset(asset: Asset) {
    selectedAsset = asset;
    selectBtn.disabled = false;
    selectBtn.style.opacity = "1";
    renderGrid();
    renderSidebar();
  }

  function confirmSelection() {
    if (!selectedAsset) return;
    onSelect?.({ id: selectedAsset.id, alt: selectedAsset.alt, title: selectedAsset.title });
    close();
  }

  // --- Data loading ---
  async function loadAssets(append = false) {
    const result = await client.listAssets({
      query: searchQuery || undefined,
      page: currentPage,
    });
    if (append) {
      assets = assets.concat(result.assets);
    } else {
      assets = result.assets;
    }
    total = result.total;

    // Pre-select current asset if present
    if (currentAssetId && !selectedAsset) {
      const found = assets.find((a) => a.id === currentAssetId);
      if (found) selectedAsset = found;
    }

    if (selectedAsset) {
      selectBtn.disabled = false;
      selectBtn.style.opacity = "1";
    }

    renderGrid();
    renderSidebar();
  }

  // --- Event handlers ---
  searchInput.addEventListener("input", () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      searchQuery = searchInput.value;
      currentPage = 1;
      selectedAsset = null;
      loadAssets();
    }, 300);
  });

  loadMoreBtn.addEventListener("click", () => {
    currentPage++;
    loadAssets(true);
  });

  uploadBtn.addEventListener("click", () => {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.style.display = "none";
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      uploadBtn.textContent = "Uploading…";
      uploadBtn.disabled = true;
      const newAsset = await client.createAsset(file);
      assets.unshift(newAsset);
      total++;
      selectAsset(newAsset);
      uploadBtn.textContent = "Upload new";
      uploadBtn.disabled = false;
    });
    document.body.appendChild(fileInput);
    fileInput.click();
    fileInput.remove();
  });

  selectBtn.addEventListener("click", confirmSelection);
  cancelBtn.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  function close() {
    if (debounceTimer) clearTimeout(debounceTimer);
    backdrop.remove();
  }

  // Initial load
  loadAssets();

  return close;
}
