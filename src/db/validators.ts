/**
 * Typed access to field validator properties.
 * Instead of casting with `as`, these functions safely extract
 * known validator properties with runtime checks.
 */

/** Safely get the slug source field from validators */
export function getSlugSource(validators: Record<string, unknown>): string | undefined {
  const v = validators.slug_source;
  return typeof v === "string" ? v : undefined;
}

/** Safely get the structured_text_blocks whitelist */
export function getBlockWhitelist(validators: Record<string, unknown>): string[] | undefined {
  const v = validators.structured_text_blocks;
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined;
}

/** Safely get the blocks_only flag */
export function getBlocksOnly(validators: Record<string, unknown>): boolean {
  return validators.blocks_only === true;
}

/** Safely check if field is required */
export function isRequired(validators: Record<string, unknown>): boolean {
  return validators.required === true;
}

/** Safely get link target model types (for `link` fields) */
export function getLinkTargets(validators: Record<string, unknown>): string[] | undefined {
  const v = validators.item_item_type;
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined;
}

/** Safely get links target model types (for `links` fields) */
export function getLinksTargets(validators: Record<string, unknown>): string[] | undefined {
  const v = validators.items_item_type;
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined;
}

/** Check if field is searchable (default: true — opt out with {"searchable": false}) */
export function isSearchable(validators: Record<string, unknown>): boolean {
  return validators.searchable !== false;
}

/**
 * Compute whether a record is valid (all required fields have values).
 * For localized required fields, checks the default locale key in the JSON map.
 * Returns { valid, missingFields } where missingFields lists api_keys that are missing.
 */
export function computeIsValid(
  record: Record<string, unknown>,
  fields: ReadonlyArray<{ api_key: string; localized: number; validators: Record<string, unknown> }>,
  defaultLocale: string | null
): { valid: boolean; missingFields: string[] } {
  const missingFields: string[] = [];
  for (const field of fields) {
    if (!isRequired(field.validators)) continue;
    const value = record[field.api_key];
    if (field.localized && defaultLocale) {
      // Localized field: check default locale key in JSON map
      let localeMap = value;
      if (typeof localeMap === "string") {
        try { localeMap = JSON.parse(localeMap); } catch { missingFields.push(field.api_key); continue; }
      }
      if (typeof localeMap !== "object" || localeMap === null) {
        missingFields.push(field.api_key);
        continue;
      }
      const locValue = (localeMap as Record<string, unknown>)[defaultLocale];
      if (locValue === null || locValue === undefined || locValue === "") {
        missingFields.push(field.api_key);
      }
    } else {
      if (value === null || value === undefined || value === "") {
        missingFields.push(field.api_key);
      }
    }
  }
  return { valid: missingFields.length === 0, missingFields };
}
