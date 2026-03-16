/**
 * Shared utility functions for the GraphQL schema builder.
 */
import { FIELD_TYPE_REGISTRY, type FieldTypeDefinition } from "../field-types.js";
import { isFieldType } from "../types.js";
import { getLinkTargets, getLinksTargets } from "../db/validators.js";
import type { DynamicRow } from "./gql-types.js";

/** Convert snake_case api_key to PascalCase GraphQL type name */
export function toTypeName(apiKey: string): string {
  return apiKey.charAt(0).toUpperCase() +
    apiKey.slice(1).replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Naive English pluralization for GraphQL query names */
export function pluralize(word: string): string {
  if (word.endsWith("y") && !/[aeiou]y$/i.test(word)) {
    return word.slice(0, -1) + "ies";
  }
  if (word.endsWith("s") || word.endsWith("x") || word.endsWith("z") || word.endsWith("ch") || word.endsWith("sh")) {
    return word + "es";
  }
  return word + "s";
}

/** Convert snake_case api_key to camelCase GraphQL field name (like DatoCMS) */
export function toCamelCase(snakeCase: string): string {
  return snakeCase.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Map a field type to its SDL type string */
export function fieldToSDL(
  fieldType: string,
  validators: Record<string, unknown>,
  typeNames: Map<string, string>
): string {
  // Link/links depend on validators for their GraphQL type
  if (fieldType === "link") {
    const targets = getLinkTargets(validators);
    if (targets?.length === 1 && typeNames.has(targets[0])) return typeNames.get(targets[0])!;
    return "JSON";
  }
  if (fieldType === "links") {
    const targets = getLinksTargets(validators);
    if (targets?.length === 1 && typeNames.has(targets[0])) return `[${typeNames.get(targets[0])!}!]`;
    return "JSON";
  }
  // All other field types: look up from registry
  if (isFieldType(fieldType)) {
    return FIELD_TYPE_REGISTRY[fieldType].graphqlType ?? "String";
  }
  return "String";
}

/** Get the registry definition for a field type, or null if unknown */
export function getRegistryDef(fieldType: string): FieldTypeDefinition | null {
  return isFieldType(fieldType) ? FIELD_TYPE_REGISTRY[fieldType] : null;
}

/** In-memory filter for records (fallback/legacy path) */
export function applyFilters(records: DynamicRow[], filter: DynamicRow): DynamicRow[] {
  if (!filter) return records;
  if (filter.AND) {
    const andFilters = filter.AND as DynamicRow[];
    for (const sub of andFilters) records = applyFilters(records, sub);
    return records;
  }
  if (filter.OR) {
    const orFilters = filter.OR as DynamicRow[];
    const r = new Set<DynamicRow>();
    for (const sub of orFilters) for (const x of applyFilters([...records], sub)) r.add(x);
    return [...r];
  }
  return records.filter((rec) => {
    for (const [key, ff] of Object.entries(filter)) {
      if (key === "AND" || key === "OR" || typeof ff !== "object" || ff === null) continue;
      const v = rec[key];
      for (const [op, exp] of Object.entries(ff as Record<string, unknown>)) {
        switch (op) {
          case "eq": {
            // Handle boolean coercion (SQLite stores 0/1)
            const ev = typeof exp === "boolean" ? (exp ? 1 : 0) : exp;
            if (v !== ev && v !== exp) return false;
            break;
          }
          case "neq": {
            const ev = typeof exp === "boolean" ? (exp ? 1 : 0) : exp;
            if (v === ev || v === exp) return false;
            break;
          }
          case "gt": if (!((v as number) > (exp as number))) return false; break;
          case "lt": if (!((v as number) < (exp as number))) return false; break;
          case "gte": if (!((v as number) >= (exp as number))) return false; break;
          case "lte": if (!((v as number) <= (exp as number))) return false; break;
          case "matches": if (typeof v !== "string" || !new RegExp(exp as string, "i").test(v)) return false; break;
          case "isBlank": if (exp && v != null && v !== "") return false; if (!exp && (v == null || v === "")) return false; break;
          case "exists": if (exp && v == null) return false; if (!exp && v != null) return false; break;
        }
      }
    }
    return true;
  });
}

/** In-memory ordering for records (fallback/legacy path) */
export function applyOrdering(records: DynamicRow[], orderBy: string[] | undefined): DynamicRow[] {
  if (!orderBy?.length) return records;
  return [...records].sort((a, b) => {
    for (const spec of orderBy) {
      const m = spec.match(/^(.+)_(ASC|DESC)$/);
      if (!m) continue;
      const [, f, d] = m;
      if (a[f] === b[f]) continue;
      if (a[f] == null) return d === "ASC" ? -1 : 1;
      if (b[f] == null) return d === "ASC" ? 1 : -1;
      return ((a[f] as number) < (b[f] as number) ? -1 : 1) * (d === "ASC" ? 1 : -1);
    }
    return 0;
  });
}

/**
 * Overlay a record's _published_snapshot onto itself, returning the merged DynamicRow.
 * Handles: missing/null snapshot, non-string snapshot already parsed, and malformed JSON.
 * When includeDrafts is true, or the snapshot is absent/unparseable, returns the record unchanged.
 */
export function decodeSnapshot(record: DynamicRow, includeDrafts: boolean): DynamicRow {
  if (includeDrafts || !record._published_snapshot) return record;
  let snapshot: unknown;
  if (typeof record._published_snapshot === "string") {
    try {
      snapshot = JSON.parse(record._published_snapshot);
    } catch {
      return record;
    }
  } else {
    snapshot = record._published_snapshot;
  }
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return record;
  return { ...record, ...(snapshot as DynamicRow) };
}

/** Deserialize JSON string fields in a record */
export function deserializeRecord(record: DynamicRow): DynamicRow {
  const result: DynamicRow = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
      try { result[key] = JSON.parse(value); } catch { result[key] = value; }
    } else {
      result[key] = value;
    }
  }
  return result;
}
