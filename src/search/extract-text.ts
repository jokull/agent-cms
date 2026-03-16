import type { ParsedFieldRow } from "../db/row-types.js";

/**
 * Extract plain text from a DAST document.
 * Walks the tree collecting span.value strings.
 */
export function extractDastText(dast: unknown): string {
  if (!isRecord(dast)) return "";
  const doc = isRecord(dast.document) ? dast.document : dast;
  const children = getArray(doc, "children");
  if (!children) return "";
  const parts: string[] = [];
  collectText(children, parts);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Extract text sections from DAST, splitting at heading boundaries.
 * Useful for Phase 2 chunking.
 */
export function extractDastSections(dast: unknown): TextSection[] {
  if (!isRecord(dast)) return [];
  const doc = isRecord(dast.document) ? dast.document : dast;
  const children = getArray(doc, "children");
  if (!children) return [];

  const sections: TextSection[] = [];
  let currentHeading: string | undefined;
  let currentParts: string[] = [];

  for (const node of children) {
    if (!isRecord(node)) continue;
    if (node.type === "heading") {
      // Flush previous section
      if (currentParts.length > 0) {
        sections.push({ heading: currentHeading, text: currentParts.join(" ").replace(/\s+/g, " ").trim() });
      }
      const headingParts: string[] = [];
      const headingChildren = getArray(node, "children");
      if (headingChildren) collectText(headingChildren, headingParts);
      currentHeading = headingParts.join(" ").trim();
      currentParts = [];
    } else {
      const parts: string[] = [];
      collectText([node], parts);
      currentParts.push(...parts);
    }
  }

  // Flush remaining
  if (currentParts.length > 0 || currentHeading) {
    sections.push({ heading: currentHeading, text: currentParts.join(" ").replace(/\s+/g, " ").trim() });
  }

  return sections;
}

export interface TextSection {
  heading?: string;
  text: string;
}

/**
 * Extract searchable text from all fields of a record.
 * Returns title (for higher BM25 weight) and body (concatenated text).
 */
export function extractRecordText(
  record: Record<string, unknown>,
  fields: ParsedFieldRow[]
): { title: string; body: string } {
  let title = "";
  const bodyParts: string[] = [];

  // Find title field: prefer "title", then "name", then first string field
  const titleField = fields.find((f) => f.api_key === "title")
    ?? fields.find((f) => f.api_key === "name")
    ?? fields.find((f) => f.field_type === "string");

  for (const field of fields) {
    const value = record[field.api_key];
    if (value === undefined || value === null) continue;

    const texts = extractFieldText(field, value);
    if (texts.length === 0) continue;

    const joined = texts.join(" ");
    if (titleField && field.api_key === titleField.api_key) {
      title = joined;
    } else {
      bodyParts.push(joined);
    }
  }

  return {
    title: title.replace(/\s+/g, " ").trim(),
    body: bodyParts.join(" ").replace(/\s+/g, " ").trim(),
  };
}

function extractFieldText(field: ParsedFieldRow, value: unknown): string[] {
  switch (field.field_type) {
    case "string":
    case "text":
      if (field.localized && isRecord(value)) {
        return Object.values(value).filter((v): v is string => typeof v === "string" && v.length > 0);
      }
      return typeof value === "string" ? [value] : [];

    case "structured_text": {
      // Value may be a string (JSON) or already parsed object
      const parsed = typeof value === "string" ? safeParse(value) : value;
      if (!isRecord(parsed)) return [];
      // DAST is in the "value" property of structured_text
      const dast = isRecord(parsed.value) ? parsed.value : parsed;
      const text = extractDastText(dast);
      return text ? [text] : [];
    }

    case "seo": {
      const parsed = typeof value === "string" ? safeParse(value) : value;
      if (!isRecord(parsed)) return [];
      const parts: string[] = [];
      if (typeof parsed.title === "string") parts.push(parsed.title);
      if (typeof parsed.description === "string") parts.push(parsed.description);
      return parts;
    }

    default:
      return [];
  }
}

// --- Helpers ---

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function getArray(obj: Record<string, unknown>, key: string): unknown[] | undefined {
  const v = obj[key];
  return Array.isArray(v) ? v : undefined;
}

function collectText(nodes: unknown[], parts: string[]) {
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    // Span nodes contain the actual text
    if (node.type === "span" && typeof node.value === "string") {
      parts.push(node.value);
    }
    // Code blocks
    if (node.type === "code" && typeof node.code === "string") {
      parts.push(node.code);
    }
    // Recurse into children
    const children = getArray(node, "children");
    if (children) collectText(children, parts);
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
