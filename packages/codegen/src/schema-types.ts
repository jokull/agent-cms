/**
 * The agent-cms schema export shape (`GET /schema`), mirrored from
 * `src/services/schema-io.ts` (SchemaExport, v1). Codegen's only input.
 */

export interface SchemaExportLocale {
  code: string;
  position: number;
  fallbackLocale: string | null;
}

export interface SchemaExportField {
  label: string;
  apiKey: string;
  fieldType: string;
  position: number;
  localized: boolean;
  validators: Record<string, unknown>;
  hint: string | null;
}

export interface SchemaExportModel {
  name: string;
  apiKey: string;
  isBlock: boolean;
  singleton: boolean;
  sortable: boolean;
  tree: boolean;
  hasDraft: boolean;
  ordering: string | null;
  canonicalPathTemplate: string | null;
  /** Presentation hint: the field api_key that titles a row (null = guess). */
  titleField?: string | null;
  /** Presentation hint: the media field api_key previewing a row (null = guess). */
  imagePreviewField?: string | null;
  fields: SchemaExportField[];
}

export interface SchemaExport {
  version: 1;
  locales: SchemaExportLocale[];
  models: SchemaExportModel[];
}

export function parseSchemaExport(input: unknown): SchemaExport {
  if (typeof input !== "object" || input === null) {
    throw new Error("Schema export must be an object");
  }
  const version = Reflect.get(input, "version");
  if (version !== 1) throw new Error(`Unsupported schema export version: ${String(version)}`);
  const models = Reflect.get(input, "models");
  const locales = Reflect.get(input, "locales");
  if (!Array.isArray(models) || !Array.isArray(locales)) {
    throw new Error("Schema export must carry models[] and locales[]");
  }
  // Trusting the CMS's own export beyond the envelope check; this is the
  // same trust REST clients extend to any typed SDK.
  return { version: 1, locales, models };
}
