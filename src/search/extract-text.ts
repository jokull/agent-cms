import type { ParsedFieldRow } from "../db/row-types.js";
import { isSearchable } from "../db/validators.js";

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
    if (!isSearchable(field.validators)) continue;
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
  // Localized fields: extract all locale values
  if (field.localized && isRecord(value)) {
    const texts: string[] = [];
    for (const localeValue of Object.values(value)) {
      texts.push(...extractFieldText({ ...field, localized: 0 } as ParsedFieldRow, localeValue));
    }
    return texts;
  }

  switch (field.field_type) {
    case "structured_text": {
      const parsed = typeof value === "string" ? safeParse(value) : value;
      if (!isRecord(parsed)) return [];
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
      // Generic: extract text from any value
      return extractGenericText(value);
  }
}

/** Extract text from any value — strings directly, JSON objects recursively. */
function extractGenericText(value: unknown): string[] {
  if (typeof value === "string") {
    // Skip values that look like IDs (ULIDs, UUIDs)
    if (/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(value)) return []; // ULID (Crockford base32)
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return []; // UUID
    return value.length > 0 ? [value] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") return [];
  if (Array.isArray(value)) {
    // Arrays of strings (e.g. tags) — extract each
    // Arrays of IDs (links) — skip
    const texts: string[] = [];
    for (const item of value) {
      texts.push(...extractGenericText(item));
    }
    return texts;
  }
  if (isRecord(value)) {
    // JSON objects — extract string values recursively
    const texts: string[] = [];
    for (const v of Object.values(value)) {
      texts.push(...extractGenericText(v));
    }
    return texts;
  }
  return [];
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
