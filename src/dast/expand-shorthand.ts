/**
 * Expand structured_text shorthand formats into the canonical
 * { value: DastDocument, blocks: Record<string, unknown> } shape.
 *
 * Accepted input formats:
 * 1. String → Agent Text, converted via agentTextToDast
 * 2. Object with "text" key → Agent Text + optional blocks
 * 3. Object with "agentText" key → explicit Agent Text + optional blocks
 * 4. Object with "value" key containing { schema: "dast" } → pass through (internal canonical)
 * 5. Any other object → pass through unchanged
 */

import { agentTextToDast } from "./agent-text.js";
import { markdownToDast } from "./markdown.js";
import type { InlineNode, ListItemNode, ParagraphNode, TableRowNode } from "./types.js";
import { isObjectRecord } from "../dynamic/row-types.js";

/**
 * Parse a text string with inline markdown into DAST inline (span) nodes.
 * Returns the children of the first paragraph, or a single span fallback.
 */
export function parseInlineSpans(text: string): readonly (InlineNode | ListItemNode | ParagraphNode | TableRowNode)[] {
  const doc = markdownToDast(text);
  const first = doc.document.children.at(0);
  if (first != null && "children" in first) {
    return first.children;
  }
  return [{ type: "span", value: text }];
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
    if (!isObjectRecord(b)) continue;
    const entry = b;
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
      const rest = isObjectRecord(data) ? data : {};
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
  if (isObjectRecord(blocks)) return blocks;
  return {};
}

/**
 * Expand a structured_text field value from shorthand formats to canonical form.
 *
 * Returns the value unchanged if it is already in canonical form or unrecognized.
 * For shorthand formats (string, array, or wrapper objects), returns the expanded
 * { value: DastDocument, blocks: Record<string, unknown> } shape.
 */
export function expandStructuredTextShorthand(rawValue: unknown): unknown {
  // 1. String → Agent Text mode
  if (typeof rawValue === "string") {
    const doc = agentTextToDast(rawValue);
    return { value: doc, blocks: {} };
  }

  if (!isObjectRecord(rawValue)) return rawValue;

  // 2 & 3. Object with "text" or "agentText" key → Agent Text + optional blocks wrapper
  const agentText = typeof rawValue.text === "string"
    ? rawValue.text
    : (typeof rawValue.agentText === "string" ? rawValue.agentText : null);
  if (agentText !== null) {
    const doc = agentTextToDast(agentText);
    const blocks = normalizeBlocks(rawValue.blocks);
    return { value: doc, blocks };
  }

  // 4 & 5. Object with "value" key or anything else → pass through
  return rawValue;
}
