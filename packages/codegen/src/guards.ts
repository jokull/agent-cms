/**
 * Runtime guards for the rich values agent-cms carries as `wire.serializable`.
 *
 * result-rpc's `wire.serializable(guard, { id })` requires a runtime guard: an
 * unvalidated escape hatch would let a drifted server payload reach the client
 * typed as something it isn't. That is exactly the hole ADR 0005's drift
 * guarantee assumed was closed — before, `wire.serializable<T>()` asserted `T`
 * without checking anything.
 *
 * Browser-safe and dependency-free: the generated `contract.ts` imports this,
 * and that file must stay loadable in a client bundle.
 *
 * ## How strict are these?
 *
 * Deliberately structural, not exhaustive:
 *
 * - Fixed-shape records (assets, media, seo) validate every required field and
 *   the type of every optional field that is present.
 * - Structured text validates the envelope and each block's `_type`
 *   discriminant, but **not** the whole DAST tree. agent-cms validates the tree
 *   against its schema on write; re-walking every node on every read would put
 *   a deep traversal on the delivery hot path to re-prove something already
 *   proven. The drift that actually matters here — a block type the client's
 *   generated union does not know about — is caught by the discriminant check.
 * - Filters are inputs the client builds from generated types, and the server
 *   re-validates them in `RecordService.queryRecords`, so the guard only
 *   confirms they are plain objects.
 */

export type Guard<T> = (value: unknown) => value is T;

/**
 * A guard whose asserted type is supplied by the caller.
 *
 * The shapes these validate — `PostContentEnvelope`, `AssetRecord`, per-model
 * filters — are generated per project and cannot be named here, so the public
 * guards asserts the caller's `T` while performing a real structural check. The
 * type-level claim is codegen's (it emits the guard next to the type it
 * generated); the runtime check is what actually catches drift.
 */
export type OpaqueGuard = <T>(value: unknown) => value is T;

// --- combinators -------------------------------------------------------------

const isUnknownCheck: (value: unknown) => boolean = (_value): _value is unknown => true;
export function isUnknown<T>(value: unknown): value is T {
  return isUnknownCheck(value);
}

export const isString: Guard<string> = (value): value is string => typeof value === "string";
export const isNumber: Guard<number> = (value): value is number =>
  typeof value === "number" && Number.isFinite(value);
export const isBoolean: Guard<boolean> = (value): value is boolean => typeof value === "boolean";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nullable<T>(guard: Guard<T>): Guard<T | null> {
  return (value): value is T | null => value === null || guard(value);
}

/** Absent and explicitly-undefined both pass; a present value must match. */
export function optional<T>(guard: Guard<T>): Guard<T | undefined> {
  return (value): value is T | undefined => value === undefined || guard(value);
}

export function arrayOf<T>(guard: Guard<T>): Guard<readonly T[]> {
  return (value): value is readonly T[] => Array.isArray(value) && value.every(guard);
}

export function recordOf<T>(guard: Guard<T>): Guard<Readonly<Record<string, T>>> {
  return (value): value is Readonly<Record<string, T>> =>
    isRecord(value) && Object.values(value).every(guard);
}

export function union<T>(...guards: ReadonlyArray<Guard<unknown>>): Guard<T> {
  return (value): value is T => guards.some((guard) => guard(value));
}

/**
 * Structural object guard. Required keys must be present and match; optional
 * keys are checked only when present. Unknown extra keys are allowed — the
 * server may add fields, and rejecting them would make every additive server
 * change a breaking client change.
 */
export function shape<T>(
  required: Readonly<Record<string, Guard<unknown>>>,
  optionalFields: Readonly<Record<string, Guard<unknown>>> = {},
): Guard<T> {
  return (value): value is T => {
    if (!isRecord(value)) return false;
    for (const [key, guard] of Object.entries(required)) {
      if (!(key in value) || !guard(value[key])) return false;
    }
    for (const [key, guard] of Object.entries(optionalFields)) {
      if (value[key] !== undefined && !guard(value[key])) return false;
    }
    return true;
  };
}

// --- shared value shapes -----------------------------------------------------

const isFocalPoint = shape<{ x: number; y: number }>({ x: isNumber, y: isNumber });
const isNullableFocalPoint = nullable(isFocalPoint);
const isNullableString = nullable(isString);
const isNullableNumber = nullable(isNumber);

const isSeoValueCheck: (value: unknown) => boolean = shape(
  {},
  {
    title: isString,
    description: isString,
    image: isString,
    twitterCard: isString,
    image_url: isNullableString,
  },
);
export function isSeoValue<T>(value: unknown): value is T {
  return isSeoValueCheck(value);
}

/** The enriched read shape: the stored reference merged with its asset row. */
const isMediaReadCheck: (value: unknown) => boolean = shape(
  {
    upload_id: isString,
    url: isString,
    filename: isString,
    mime_type: isString,
    size: isNumber,
    width: isNullableNumber,
    height: isNullableNumber,
    alt: isNullableString,
    title: isNullableString,
    focal_point: isNullableFocalPoint,
    custom_data: nullable(isRecord),
    blurhash: isNullableString,
  },
);
export function isMediaRead<T>(value: unknown): value is T {
  return isMediaReadCheck(value);
}

/** The write shape: a bare asset id, or a reference object. */
const isMediaValueCheck: (value: unknown) => boolean = union(
  isString,
  shape(
    { upload_id: isString },
    {
      alt: isNullableString,
      title: isNullableString,
      focal_point: isNullableFocalPoint,
      custom_data: nullable(isRecord),
    },
  ),
);
export function isMediaValue<T>(value: unknown): value is T {
  return isMediaValueCheck(value);
}

const isMediaReadArrayCheck: (value: unknown) => boolean = arrayOf(isMediaRead);
export function isMediaReadArray<T>(value: unknown): value is T {
  return isMediaReadArrayCheck(value);
}
const isMediaValueArrayCheck: (value: unknown) => boolean = arrayOf(isMediaValue);
export function isMediaValueArray<T>(value: unknown): value is T {
  return isMediaValueArrayCheck(value);
}

// --- structured text ---------------------------------------------------------

const isDastDocument: Guard<unknown> = (value): value is unknown =>
  isRecord(value) && isRecord(value.document) && Array.isArray(value.document.children);

/** Every block payload carries the `_type` discriminant the client unions on. */
const isBlockPayload: Guard<unknown> = (value): value is unknown =>
  isRecord(value) && typeof value._type === "string";

/**
 * Read envelope: `{ value, blocks? }`. The document is checked shallowly (see
 * the strictness note above); block payloads are checked for their `_type`
 * discriminant, which is what the generated block union keys on.
 */
const isStructuredTextEnvelopeCheck: (value: unknown) => boolean = shape(
  { value: isDastDocument },
  { blocks: recordOf(isBlockPayload) },
);
export function isStructuredTextEnvelope<T>(value: unknown): value is T {
  return isStructuredTextEnvelopeCheck(value);
}

/** Write envelope has the same shape; blocks may be partial payloads. */
const isStructuredTextWriteCheck: (value: unknown) => boolean = shape(
  { value: isDastDocument },
  { blocks: recordOf(isRecord) },
);
export function isStructuredTextWrite<T>(value: unknown): value is T {
  return isStructuredTextWriteCheck(value);
}

/** rich_text: an array of block payloads. */
const isBlockArrayCheck: (value: unknown) => boolean = arrayOf(isBlockPayload);
export function isBlockArray<T>(value: unknown): value is T {
  return isBlockArrayCheck(value);
}

// --- filters -----------------------------------------------------------------

/** Server re-validates in RecordService.queryRecords; shape check only. */
const isFilterCheck: (value: unknown) => boolean = isRecord;
export function isFilter<T>(value: unknown): value is T {
  return isFilterCheck(value);
}

// --- asset shapes ------------------------------------------------------------

const isAssetRecordCheck: (value: unknown) => boolean = shape({
  id: isString,
  filename: isString,
  basename: isNullableString,
  format: isNullableString,
  mime_type: isString,
  size: isNumber,
  width: isNullableNumber,
  height: isNullableNumber,
  alt: isNullableString,
  title: isNullableString,
  r2_key: isString,
  blurhash: isNullableString,
  url: isString,
  colors: isNullableString,
  focal_point: isNullableString,
  tags: isString,
  custom_data: isNullableString,
  created_at: isString,
  updated_at: isString,
  created_by: isNullableString,
  updated_by: isNullableString,
});
export function isAssetRecord<T>(value: unknown): value is T {
  return isAssetRecordCheck(value);
}

const isAssetCreateResultCheck: (value: unknown) => boolean = shape(
  {
    id: isString,
    filename: isString,
    mimeType: isString,
    size: isNumber,
    r2Key: isString,
    url: isString,
    createdAt: isString,
    updatedAt: isString,
    createdBy: isNullableString,
    updatedBy: isNullableString,
  },
  { width: isNumber, height: isNumber, alt: isString, title: isString },
);
export function isAssetCreateResult<T>(value: unknown): value is T {
  return isAssetCreateResultCheck(value);
}

const isAssetReplaceResultCheck: (value: unknown) => boolean = shape(
  {
    id: isString,
    filename: isString,
    mimeType: isString,
    size: isNumber,
    alt: isNullableString,
    title: isNullableString,
    r2Key: isString,
    url: isString,
    replaced: isBoolean,
    updatedAt: isString,
    updatedBy: isNullableString,
  },
  { width: isNumber, height: isNumber },
);
export function isAssetReplaceResult<T>(value: unknown): value is T {
  return isAssetReplaceResultCheck(value);
}

const isAssetUpdateResultCheck: (value: unknown) => boolean = shape({
  id: isString,
  alt: isNullableString,
  title: isNullableString,
  width: isNullableNumber,
  height: isNullableNumber,
  url: isString,
  updatedAt: isString,
  updatedBy: isNullableString,
});
export function isAssetUpdateResult<T>(value: unknown): value is T {
  return isAssetUpdateResultCheck(value);
}

const isUploadUrlResultCheck: (value: unknown) => boolean = shape({
  uploadUrl: isString,
  r2Key: isString,
  assetId: isString,
});
export function isUploadUrlResult<T>(value: unknown): value is T {
  return isUploadUrlResultCheck(value);
}

/**
 * A version row. `snapshot` is a partial record whose field types vary per
 * model, so it is checked as an object only — the record's own codecs validate
 * its fields wherever it is read back as a record.
 */
const isVersionOfCheck: (value: unknown) => boolean = shape({
  id: isString,
  model_api_key: isString,
  record_id: isString,
  version_number: isNumber,
  action: isString,
  actor_type: isNullableString,
  actor_label: isNullableString,
  actor_token_id: isNullableString,
  created_at: isString,
  snapshot: isRecord,
});
export function isVersionOf<T>(value: unknown): value is T {
  return isVersionOfCheck(value);
}

// --- client inputs -----------------------------------------------------------
//
// Inputs are authored by the client from generated types and fully re-validated
// server-side (AssetService / RecordService), so these guards confirm the
// required fields and leave deep validation to the server that owns the rules.

const isStringArray = arrayOf(isString);

const isAssetCreateInputCheck: (value: unknown) => boolean = shape(
  { filename: isString, mimeType: isString },
  {
    id: isString, size: isNumber, width: isNumber, height: isNumber,
    alt: isString, title: isString, r2Key: isString, blurhash: isString,
    colors: isStringArray, focalPoint: isFocalPoint, tags: isStringArray,
  },
);
export function isAssetCreateInput<T>(value: unknown): value is T {
  return isAssetCreateInputCheck(value);
}

const isAssetImportInputCheck: (value: unknown) => boolean = shape(
  { url: isString },
  {
    id: isString, filename: isString, mimeType: isString,
    width: isNumber, height: isNumber, alt: isString, title: isString,
    r2Key: isString, blurhash: isString,
    colors: isStringArray, focalPoint: isFocalPoint, tags: isStringArray,
  },
);
export function isAssetImportInput<T>(value: unknown): value is T {
  return isAssetImportInputCheck(value);
}

const isAssetUpdateInputCheck: (value: unknown) => boolean = shape(
  {},
  { alt: isString, title: isString, width: isNumber, height: isNumber },
);
export function isAssetUpdateInput<T>(value: unknown): value is T {
  return isAssetUpdateInputCheck(value);
}

/** Partial record data for `validate` — per-field rules live on the server. */
const isRecordDataCheck: (value: unknown) => boolean = isRecord;
export function isRecordData<T>(value: unknown): value is T {
  return isRecordDataCheck(value);
}

/**
 * An orderBy token (`"title_ASC"`). The asserted type is a per-model literal
 * union, so this checks that it is a string and leaves the vocabulary to the
 * server, which rejects unknown columns in RecordService.
 */
export function isOrderBy<T>(value: unknown): value is T {
  return typeof value === "string";
}
