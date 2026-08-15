/**
 * The dynamic row layer — `src/dynamic/` is the ONLY place that touches
 * inherently-untyped content-table shape.
 *
 * Agency CMS models are runtime-defined and runtime-migrated: the set of
 * fields on `content_<model>` tables is not knowable at compile time, so
 * there is no Drizzle/Kysely-style typed query root for them. Everything
 * extracted from those tables is a `DynamicRow` — a string-keyed record of
 * `unknown` — and the shape of a value at any given key is only knowable by
 * duck-typing at runtime.
 *
 * The contract of this zone: raw content-table SQL and raw stored strings
 * enter here, and decoded, validated rows leave here. Code outside
 * `src/dynamic/` never sees a raw string from a content table. The oxlint
 * override in `.oxlintrc.json` relaxes the strict type-aware rules inside
 * this directory only.
 */

/** A dynamic row from a content/block table. */
export type DynamicRow = Record<string, unknown>;

/** Narrow `unknown` to a plain object record. Arrays and null are excluded. */
export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract the string entries of an unknown array, if it is one. */
export function stringArrayFrom(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** Coerce a stored value to its string form for canonical-path templates. */
export function stringifyTemplateValue(value: unknown): string | null {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    default:
      return value instanceof Date ? value.toISOString() : null;
  }
}
