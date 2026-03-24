/**
 * Expand structured_text shorthand formats into the canonical
 * { value: DastDocument, blocks: Record<string, unknown> } shape.
 *
 * Accepted input formats:
 * 1. String → markdown, converted via markdownToDast
 * 2. Array → typed nodes, converted to DAST children
 * 3. Object with "markdown" key → markdown + optional blocks
 * 4. Object with "nodes" key → typed nodes + optional blocks
 * 5. Object with "value" key containing { schema: "dast" } → pass through (canonical)
 * 6. Any other object → pass through unchanged
 */

import { markdownToDast } from "./markdown.js";

/**
 * Parse a text string with inline markdown into DAST inline (span) nodes.
 * Returns the children of the first paragraph, or a single span fallback.
 */
export function parseInlineSpans(text: string): readonly unknown[] {
  const doc = markdownToDast(text);
  const first = doc.document.children.at(0);
  if (first != null && "children" in first) {
    return first.children as readonly unknown[];
  }
  return [{ type: "span", value: text }];
}

/**
 * Convert an array of typed node objects to DAST block-level children.
 */
function typedNodesToDastChildren(nodes: readonly unknown[]): unknown[] {
  const children: unknown[] = [];
  for (const node of nodes) {
    if (node == null || typeof node !== "object") continue;
    const n = node as Record<string, unknown>;
    const type = n.type;
    switch (type) {
      case "paragraph":
        children.push({
          type: "paragraph",
          children: parseInlineSpans(String(n.text ?? "")),
        });
        break;
      case "heading":
        children.push({
          type: "heading",
          level: n.level,
          children: parseInlineSpans(String(n.text ?? "")),
        });
        break;
      case "code":
        children.push({
          type: "code",
          code: n.code,
          ...(n.language ? { language: n.language } : {}),
        });
        break;
      case "blockquote":
        children.push({
          type: "blockquote",
          children: [{ type: "paragraph", children: parseInlineSpans(String(n.text ?? "")) }],
        });
        break;
      case "list":
        children.push({
          type: "list",
          style: n.style ?? "bulleted",
          children: (Array.isArray(n.items) ? n.items : []).map((item: unknown) => ({
            type: "listItem",
            children: [{ type: "paragraph", children: parseInlineSpans(String(item ?? "")) }],
          })),
        });
        break;
      case "thematicBreak":
        children.push({ type: "thematicBreak" });
        break;
      case "block":
        children.push({ type: "block", item: n.ref });
        break;
      default:
        break;
    }
  }
  return children;
}

/**
 * Build a block map from an array of block entries.
 *
 * Accepts two entry formats:
 * - { id, type, data: { ...fields } }  — shorthand (type becomes _type)
 * - { id, _type, ...fields }           — canonical (matches get_record output)
 */
function buildBlockMapFromArray(blocks: readonly unknown[]): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const b of blocks) {
    if (b == null || typeof b !== "object") continue;
    const entry = b as Record<string, unknown>;
    const id = entry.id;
    if (typeof id !== "string") continue;

    // Canonical format: { id, _type, ...fields }
    if (typeof entry._type === "string") {
      const { id: _, ...rest } = entry;
      map[id] = rest;
      continue;
    }

    // Shorthand format: { id, type, data: { ...fields } }
    const type = entry.type;
    if (typeof type === "string") {
      const data = entry.data;
      const rest = (data != null && typeof data === "object" && !Array.isArray(data))
        ? data as Record<string, unknown>
        : {};
      map[id] = { _type: type, ...rest };
    }
  }
  return map;
}

/**
 * Normalize a blocks value to a canonical map.
 *
 * Accepts:
 * - Array of block entries (shorthand or canonical format)
 * - Object/map keyed by block ID (canonical DAST format, passed through)
 */
function normalizeBlocks(blocks: unknown): Record<string, unknown> {
  if (Array.isArray(blocks)) return buildBlockMapFromArray(blocks);
  if (blocks != null && typeof blocks === "object" && !Array.isArray(blocks)) {
    return blocks as Record<string, unknown>;
  }
  return {};
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Expand a structured_text field value from shorthand formats to canonical form.
 *
 * Returns the value unchanged if it is already in canonical form or unrecognized.
 * For shorthand formats (string, array, or wrapper objects), returns the expanded
 * { value: DastDocument, blocks: Record<string, unknown> } shape.
 */
export function expandStructuredTextShorthand(rawValue: unknown): unknown {
  // 1. String → markdown mode
  if (typeof rawValue === "string") {
    const doc = markdownToDast(rawValue);
    return { value: doc, blocks: {} };
  }

  // 2. Array → typed nodes mode
  if (Array.isArray(rawValue)) {
    const children = typedNodesToDastChildren(rawValue);
    return {
      value: { schema: "dast", document: { type: "root", children } },
      blocks: {},
    };
  }

  if (!isRecord(rawValue)) return rawValue;

  // 3. Object with "markdown" key → markdown + optional blocks wrapper
  if ("markdown" in rawValue && typeof rawValue.markdown === "string") {
    const doc = markdownToDast(rawValue.markdown);
    const blocks = normalizeBlocks(rawValue.blocks);
    return { value: doc, blocks };
  }

  // 4. Object with "nodes" key → typed nodes + optional blocks wrapper
  if ("nodes" in rawValue && Array.isArray(rawValue.nodes)) {
    const children = typedNodesToDastChildren(rawValue.nodes);
    const blocks = normalizeBlocks(rawValue.blocks);
    return {
      value: { schema: "dast", document: { type: "root", children } },
      blocks,
    };
  }

  // 5 & 6. Object with "value" key or anything else → pass through
  return rawValue;
}
