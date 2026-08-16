import type { ParsedFieldRow } from "../db/row-types.js";
import { isBoolean, isNumber, isObjectRecord, isString, type DynamicRow, type StoredFieldValue } from "../dynamic/row-types.js";
import { isSearchable } from "../db/validators.js";

/**
 * Extract plain text from a DAST document.
 * Walks the tree collecting span.value strings.
 */
export function extractDastText(dast: DynamicRow | null | undefined): string {
  if (!isObjectRecord(dast)) return "";
  const doc = isObjectRecord(dast.document) ? dast.document : dast;
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
export function extractDastSections(dast: DynamicRow | null | undefined): TextSection[] {
  if (!isObjectRecord(dast)) return [];
  const doc = isObjectRecord(dast.document) ? dast.document : dast;
  const children = getArray(doc, "children");
  if (!children) return [];

  const sections: TextSection[] = [];
  let currentHeading: string | undefined;
  let currentParts: string[] = [];

  for (const node of children) {
    if (!isObjectRecord(node)) continue;
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
  record: DynamicRow,
  fields: ParsedFieldRow[]
) {
  let title = "";
  const bodyParts: string[] = [];

  // Find title field: prefer "title", then "name", then first string field
  const titleField = fields.find((f) => f.api_key === "title")
    ?? fields.find((f) => f.api_key === "name")
    ?? fields.find((f) => f.field_type === "string");

  for (const field of fields) {
    if (!isSearchable(field.validators)) continue;
    // SAFETY: DynamicRow cells are StoredFieldValue by the dynamic-zone contract
    // (the Record<string, unknown> window hides the union).
    const value = record[field.api_key] as StoredFieldValue;
    if (value == null) continue;

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

function extractFieldText(field: ParsedFieldRow, value: StoredFieldValue): string[] {
  // Localized fields: extract all locale values
  if (field.localized && isObjectRecord(value)) {
    const texts: string[] = [];
    for (const localeValue of Object.values(value)) {
      // SAFETY: locale-map values are content-table cells (StoredFieldValue).
      texts.push(...extractFieldText({ ...field, localized: 0 }, localeValue as StoredFieldValue));
    }
    return texts;
  }

  switch (field.field_type) {
    case "structured_text": {
      const parsed = isString(value) ? safeParse(value) : value;
      if (!isObjectRecord(parsed)) return [];
      const dast = isObjectRecord(parsed.value) ? parsed.value : parsed;
      const parts: string[] = [];
      const text = extractDastText(dast);
      if (text) parts.push(text);
      if (isObjectRecord(parsed.blocks)) {
        parts.push(...extractGenericText(parsed.blocks));
      }
      return parts;
    }

    case "rich_text": {
      // Rich text stores a JSON array of block IDs — block content is in block tables.
      // At this point, the record may be materialized (array of block objects) or raw (array of IDs).
      const parsed = isString(value) ? safeParse(value) : value;
      if (!Array.isArray(parsed)) return [];
      const parts: string[] = [];
      for (const item of parsed) {
        if (isString(item)) continue; // raw block ID — no text to extract
        if (isObjectRecord(item)) {
          parts.push(...extractGenericText(item));
        }
      }
      return parts;
    }

    case "seo": {
      const parsed = isString(value) ? safeParse(value) : value;
      if (!isObjectRecord(parsed)) return [];
      const parts: string[] = [];
      if (isString(parsed.title)) parts.push(parsed.title);
      if (isString(parsed.description)) parts.push(parsed.description);
      return parts;
    }

    default:
      // Generic: extract text from any value
      return extractGenericText(value);
  }
}

/** Extract text from any value — strings directly, JSON objects recursively. */
function extractGenericText(value: StoredFieldValue): string[] {
  if (isString(value)) {
    // Skip values that look like IDs (ULIDs, UUIDs)
    if (/^[0-9a-z]{10}$/.test(value)) return []; // nanoid (lowercase alphanumeric, 10 chars)
    if (/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(value)) return []; // legacy ULID (Crockford base32)
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return []; // UUID
    return value.length > 0 ? [value] : [];
  }
  if (isNumber(value) || isBoolean(value)) return [];
  if (Array.isArray(value)) {
    // Arrays of strings (e.g. tags) — extract each
    // Arrays of IDs (links) — skip
    const texts: string[] = [];
    for (const item of value) {
      // SAFETY: array cells are content-table cells (StoredFieldValue); the
      // Array.isArray narrow goes through any, so the union is recovered here.
      texts.push(...extractGenericText(item as StoredFieldValue));
    }
    return texts;
  }
  if (isObjectRecord(value)) {
    // JSON objects — extract string values recursively
    const texts: string[] = [];
    for (const [key, v] of Object.entries(value)) {
      if (key.startsWith("_")) continue;
      // SAFETY: record cells are content-table cells (StoredFieldValue).
      texts.push(...extractGenericText(v as StoredFieldValue));
    }
    return texts;
  }
  return [];
}

// --- Helpers ---

function getArray(obj: DynamicRow, key: string): unknown[] | undefined {
  const v = obj[key];
  return Array.isArray(v) ? v : undefined;
}

function collectText(nodes: unknown[], parts: string[]) {
  for (const node of nodes) {
    if (!isObjectRecord(node)) continue;
    // Span nodes contain the actual text
    if (node.type === "span" && isString(node.value)) {
      parts.push(node.value);
    }
    // Code blocks
    if (node.type === "code" && isString(node.code)) {
      parts.push(node.code);
    }
    // Recurse into children
    const children = getArray(node, "children");
    if (children) collectText(children, parts);
  }
}

function safeParse(json: string): StoredFieldValue {
  try {
    // SAFETY: JSON.parse yields well-formed JSON, which is the stored-field-value
    // universe (scalars, records, arrays); the union's DynamicRow member carries
    // the object/array forms at the type level.
    return JSON.parse(json) as StoredFieldValue;
  } catch {
    return null;
  }
}
