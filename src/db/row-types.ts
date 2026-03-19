/**
 * Row types for system tables as returned by @effect/sql.
 * These are the snake_case column names from SQLite, not camelCase.
 */

export interface ModelRow {
  readonly id: string;
  readonly name: string;
  readonly api_key: string;
  readonly is_block: number; // SQLite boolean: 0 | 1
  readonly singleton: number;
  readonly sortable: number;
  readonly tree: number;
  readonly has_draft: number;
  readonly all_locales_required: number;
  readonly ordering: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface FieldRow {
  readonly id: string;
  readonly model_id: string;
  readonly label: string;
  readonly api_key: string;
  readonly field_type: string;
  readonly position: number;
  readonly localized: number; // SQLite boolean
  readonly validators: string; // JSON string
  readonly default_value: string | null;
  readonly appearance: string | null;
  readonly hint: string | null;
  readonly fieldset_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** FieldRow with validators parsed from JSON */
export interface ParsedFieldRow extends Omit<FieldRow, "validators"> {
  readonly validators: Record<string, unknown>;
}

export interface LocaleRow {
  readonly id: string;
  readonly code: string;
  readonly position: number;
  readonly fallback_locale_id: string | null;
}

export interface AssetRow {
  readonly id: string;
  readonly filename: string;
  readonly mime_type: string;
  readonly size: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly alt: string | null;
  readonly title: string | null;
  readonly r2_key: string;
  readonly blurhash: string | null;
  readonly colors: string | null; // JSON string
  readonly focal_point: string | null; // JSON string
  readonly tags: string; // JSON string
  readonly custom_data: string | null; // JSON string
  readonly created_at: string;
  readonly updated_at: string;
  readonly created_by: string | null;
  readonly updated_by: string | null;
}

/** A dynamic content table row — system columns are known, field columns are unknown */
export interface ContentRow {
  readonly id: string;
  readonly _status: string;
  readonly _published_at: string | null;
  readonly _first_published_at: string | null;
  readonly _published_snapshot: string | null; // JSON string
  readonly _created_at: string;
  readonly _updated_at: string;
  readonly _created_by: string | null;
  readonly _updated_by: string | null;
  readonly _published_by: string | null;
  readonly [fieldKey: string]: unknown;
}

export interface VersionRow {
  readonly id: string;
  readonly model_api_key: string;
  readonly record_id: string;
  readonly version_number: number;
  readonly snapshot: string;
  readonly action: string;
  readonly actor_type: string | null;
  readonly actor_label: string | null;
  readonly actor_token_id: string | null;
  readonly created_at: string;
}

export interface EditorTokenRow {
  readonly id: string;
  readonly name: string;
  readonly token_prefix: string;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly expires_at: string | null;
}

export interface StoredEditorTokenRow extends EditorTokenRow {
  readonly secret_hash: string | null;
}

/** A dynamic block table row */
export interface BlockRow {
  readonly id: string;
  readonly _root_record_id: string;
  readonly _root_field_api_key: string;
  readonly _parent_container_model_api_key: string;
  readonly _parent_block_id: string | null;
  readonly _parent_field_api_key: string;
  readonly _depth: number;
  readonly [fieldKey: string]: unknown;
}

// --- Type guards ---

export function isModelRow(row: unknown): row is ModelRow {
  return typeof row === "object" && row !== null && "api_key" in row && "is_block" in row;
}

export function isContentRow(row: unknown): row is ContentRow {
  return typeof row === "object" && row !== null && "id" in row && "_status" in row;
}

// --- Helpers ---

/** Runtime check that a value is a plain object record */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Safely parse JSON to a Record, returning empty object on failure */
function parseJsonRecord(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (isRecord(parsed)) return parsed;
  } catch { /* invalid JSON */ }
  return {};
}

/** Parse a FieldRow's validators from JSON string to object */
export function parseFieldValidators(field: FieldRow): ParsedFieldRow {
  return { ...field, validators: parseJsonRecord(field.validators) };
}

/** Check if a content row's status indicates it's published */
export function isPublished(row: ContentRow): boolean {
  return row._status === "published" || row._status === "updated";
}

/** Parse a published snapshot from JSON string */
export function parseSnapshot(row: ContentRow): Record<string, unknown> | null {
  if (!row._published_snapshot) return null;
  const result = parseJsonRecord(row._published_snapshot);
  return Object.keys(result).length > 0 ? result : null;
}
