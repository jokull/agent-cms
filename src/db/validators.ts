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
