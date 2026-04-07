/**
 * Generic field value transformers for converting DatoCMS record field values
 * to agent-cms format. Reusable across all DatoCMS import adapters.
 */

// ---------------------------------------------------------------------------
// Locale helpers
// ---------------------------------------------------------------------------

/** Normalize a DatoCMS locale code to agent-cms format ("zh-CN" -> "zh_CN"). */
export function normalizeDatoLocale(locale) {
  if (!locale) return locale;
  return locale.replace(/-/g, "_");
}

/** Convert an agent-cms locale back to DatoCMS format ("zh_CN" -> "zh-CN"). */
export function denormalizeCmsLocale(locale) {
  if (!locale) return locale;
  return locale.replace(/_/g, "-");
}

/** Wrap a value as a single-locale input object: `{ [locale]: value }`. */
export function localizedInput(value, locale) {
  return value == null ? undefined : { [locale]: value };
}

/**
 * Extract the value for a given locale from a possibly-localized field value.
 * If the value is a plain scalar (not an object / array) it is returned as-is.
 * Tries the CMS-style locale first, then falls back to the dato-style locale.
 */
export function localizedValue(value, locale) {
  if (value == null) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value[denormalizeCmsLocale(locale)] ?? value[locale] ?? null;
  }
  return value;
}

/**
 * Normalize all locale keys in a localized map (replace "-" with "_"),
 * stripping null/undefined/empty-string entries.
 */
export function localizedMap(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== null && entry !== undefined && entry !== "")
    .map(([locale, entry]) => [normalizeDatoLocale(locale), entry]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

// ---------------------------------------------------------------------------
// Field value transforms
// ---------------------------------------------------------------------------

/**
 * Transform an SEO metadata object, stripping null-valued keys.
 * Returns `null` when there is nothing useful to keep.
 */
export function seoValue(seo) {
  if (!seo) return null;
  return {
    ...(seo.title == null ? {} : { title: seo.title }),
    ...(seo.description == null ? {} : { description: seo.description }),
    ...(seo.image == null ? {} : { image: seo.image }),
  };
}

/** Pass-through for lat/lon values. Returns `null` when the input is falsy. */
export function latLonValue(value) {
  if (!value) return null;
  return {
    latitude: value.latitude,
    longitude: value.longitude,
  };
}

/** Pass-through for color values. Returns `null` when the input is falsy. */
export function colorValue(color) {
  if (!color) return null;
  return {
    red: color.red,
    green: color.green,
    blue: color.blue,
    alpha: color.alpha,
  };
}

// ---------------------------------------------------------------------------
// Block type mapping
// ---------------------------------------------------------------------------

/**
 * Convert a DatoCMS block __typename (PascalCase + "Record" suffix) to
 * an agent-cms api_key (snake_case, no suffix).
 *
 *   "ImageRecord"    -> "image"
 *   "TourCardRecord" -> "tour_card"
 */
export function datoBlockTypeToApiKey(datoTypeName) {
  return datoTypeName
    .replace(/Record$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Structured text helpers
// ---------------------------------------------------------------------------

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

/**
 * Recursively collect block and inlineBlock item IDs from a DAST tree.
 * Returns a `Set<string>`.
 */
export function collectBlockRefs(node, refs = new Set()) {
  if (!node || typeof node !== "object") return refs;
  if (Array.isArray(node)) {
    for (const entry of node) collectBlockRefs(entry, refs);
    return refs;
  }
  if ((node.type === "block" || node.type === "inlineBlock") && typeof node.item === "string") {
    refs.add(node.item);
  }
  for (const value of Object.values(node)) {
    collectBlockRefs(value, refs);
  }
  return refs;
}

/**
 * Deep-clone a DAST tree and rewrite block/inlineBlock item references using
 * `idMap` (old ID -> new ID). References whose old ID is not present in the
 * map are filtered out (the node is dropped).
 *
 * @param {object}           dastNode  Root DAST node (or sub-tree).
 * @param {Map<string,string>} idMap   Mapping from original IDs to new IDs.
 * @param {string}           [context] Human-readable context for logging.
 * @param {function}         [onDropped] Optional callback `(droppedNode, context) => void`.
 */
export function rewriteBlockRefs(dastNode, idMap, context, onDropped) {
  const node = deepClone(dastNode);
  return _rewriteRefs(node, idMap, context, onDropped);
}

function _rewriteRefs(node, idMap, context, onDropped) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    return node
      .map((entry) => _rewriteRefs(entry, idMap, context, onDropped))
      .filter((entry) => entry != null);
  }

  const copy = {};
  for (const [key, value] of Object.entries(node)) {
    copy[key] = key === "item" ? value : _rewriteRefs(value, idMap, context, onDropped);
  }
  if ((copy.type === "block" || copy.type === "inlineBlock") && typeof copy.item === "string") {
    const mapped = idMap.get(copy.item);
    if (!mapped) {
      if (typeof onDropped === "function") {
        onDropped(copy, context);
      }
      return null;
    }
    copy.item = mapped;
  }
  return copy;
}

// ---------------------------------------------------------------------------
// Generic structured text transformation
// ---------------------------------------------------------------------------

/**
 * Transform a raw DatoCMS structured text value into the agent-cms envelope
 * format `{ value, blocks }`.
 *
 * @param {object}   options
 * @param {object}   options.dastValue       The raw DAST document node.
 * @param {object[]} options.blockItems      Array of raw CMA block items referenced by the DAST.
 * @param {string}   options.parentRecordId  Scope prefix for block IDs (e.g. "recId__fieldName").
 * @param {object}   options.blockFieldMap   Map of block api_key -> field definitions.
 *   Each entry: `{ [fieldApiKey]: { type: string } }`.
 *   Supported field types in blocks: "media" (calls ensureAssetFn), "link" (ID passthrough),
 *   "structured_text" (recursive), and everything else passes through.
 * @param {function} options.ensureAssetFn   `async (uploadRef) => result` — imports an asset.
 * @param {string}   [options.locale]        Current import locale.
 * @param {function} [options.onDroppedRef]  Optional callback for unmapped block refs.
 *
 * @returns {{ value: object, blocks: object }} Rewritten DAST + blocks map.
 */
export async function transformStructuredTextRaw({
  dastValue,
  blockItems,
  parentRecordId,
  blockFieldMap,
  ensureAssetFn,
  locale,
  onDroppedRef,
}) {
  if (!dastValue) return null;

  const blocks = {};
  const idMap = new Map();

  for (const block of blockItems) {
    const blockTypeId = block.relationships?.item_type?.data?.id;
    const blockApiKey = block._apiKey ?? block._blockApiKey ?? null;
    const scopedId = `${parentRecordId}__${block.id}`;
    idMap.set(block.id, scopedId);

    const fieldDefs = blockApiKey ? blockFieldMap[blockApiKey] : null;

    if (!fieldDefs) {
      // No field mapping — store the block type marker only
      blocks[scopedId] = { _type: blockApiKey ?? blockTypeId ?? "unknown" };
      continue;
    }

    const blockData = { _type: blockApiKey };

    for (const [fieldKey, fieldDef] of Object.entries(fieldDefs)) {
      const rawValue = block.attributes?.[fieldKey] ?? null;

      if (fieldDef.type === "media") {
        if (rawValue && ensureAssetFn) {
          await ensureAssetFn(rawValue);
        }
        // Extract upload ID from DatoCMS upload ref shape
        blockData[fieldKey] = rawValue?.upload_id ?? rawValue?.id ?? rawValue ?? null;
        continue;
      }

      if (fieldDef.type === "link") {
        blockData[fieldKey] = rawValue ?? null;
        continue;
      }

      if (fieldDef.type === "structured_text" && rawValue) {
        // Recursive structured text within a block
        const nested = await transformStructuredTextRaw({
          dastValue: rawValue,
          blockItems: [],
          parentRecordId: `${parentRecordId}__${block.id}__${fieldKey}`,
          blockFieldMap,
          ensureAssetFn,
          locale,
          onDroppedRef,
        });
        blockData[fieldKey] = nested;
        continue;
      }

      // Default: pass through
      blockData[fieldKey] = rawValue;
    }

    blocks[scopedId] = blockData;
  }

  return {
    value: rewriteBlockRefs(dastValue, idMap, parentRecordId, onDroppedRef),
    blocks,
  };
}

// ---------------------------------------------------------------------------
// Generic record field value transformer
// ---------------------------------------------------------------------------

/**
 * Transform a single DatoCMS field value based on its declared type.
 *
 * @param {object}   options
 * @param {string}   options.fieldType       The agent-cms field type name.
 * @param {*}        options.value           The raw DatoCMS value.
 * @param {string}   options.locale          Current import locale.
 * @param {function} [options.ensureAssetFn] `async (uploadRef) => result`.
 * @param {function} [options.importRecordFn] `async (id) => void` — import a linked record.
 * @param {boolean}  [options.isLocalized]   Whether the field is localized.
 *
 * @returns {*} Transformed value ready for agent-cms upsert.
 */
export async function transformFieldValue({
  fieldType,
  value,
  locale,
  ensureAssetFn,
  importRecordFn,
  isLocalized,
}) {
  if (value == null) return undefined;

  switch (fieldType) {
    // Scalar pass-through types
    case "string":
    case "text":
    case "slug":
    case "date":
    case "date_time":
    case "integer":
    case "float":
    case "boolean":
    case "json":
      return isLocalized ? localizedInput(value, locale) : value;

    case "color":
      return isLocalized ? localizedInput(colorValue(value), locale) : colorValue(value);

    case "media": {
      if (!value) return undefined;
      const assetRef = value?.upload_id ? value : (value?.id ? value : null);
      if (!assetRef) return undefined;
      if (ensureAssetFn) {
        await ensureAssetFn(assetRef);
      }
      const assetId = assetRef.upload_id ?? assetRef.id ?? null;
      return isLocalized ? localizedInput(assetId, locale) : assetId;
    }

    case "media_gallery": {
      if (!Array.isArray(value) || value.length === 0) return undefined;
      const ids = [];
      for (const item of value) {
        const ref = item?.upload_id ? item : (item?.id ? item : null);
        if (!ref) continue;
        if (ensureAssetFn) {
          await ensureAssetFn(ref);
        }
        const id = ref.upload_id ?? ref.id ?? null;
        if (id) ids.push(id);
      }
      return ids.length > 0 ? (isLocalized ? localizedInput(ids, locale) : ids) : undefined;
    }

    case "link": {
      const id = typeof value === "string" ? value : (value?.id ?? value ?? null);
      if (id && importRecordFn) {
        await importRecordFn(id);
      }
      return isLocalized ? localizedInput(id, locale) : id;
    }

    case "links": {
      const ids = Array.isArray(value) ? value.map((v) => (typeof v === "string" ? v : v?.id ?? v)).filter(Boolean) : [];
      if (ids.length === 0) return undefined;
      if (importRecordFn) {
        for (const id of ids) {
          await importRecordFn(id);
        }
      }
      return isLocalized ? localizedInput(ids, locale) : ids;
    }

    case "seo":
      return isLocalized ? localizedInput(seoValue(value), locale) : seoValue(value);

    case "lat_lon":
      return isLocalized ? localizedInput(latLonValue(value), locale) : latLonValue(value);

    case "video": {
      const url = typeof value === "string" ? value : (value?.url ?? null);
      return isLocalized ? localizedInput(url, locale) : url;
    }

    case "structured_text":
      // Structured text requires additional context (block items, field map, etc.)
      // and should be handled by the caller using transformStructuredTextRaw.
      // Return the raw value here so the caller can process it.
      return value;

    default:
      // Unknown field type — pass through
      return isLocalized ? localizedInput(value, locale) : value;
  }
}
