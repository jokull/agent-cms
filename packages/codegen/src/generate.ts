/**
 * Emits host-generic result-rpc fragments from an agent-cms SchemaExport
 * (settled by wayfinder tickets 01 + 07).
 *
 * Two files, honoring result-rpc's client boundary:
 * - contract.ts — codecs, types, and `cmsContract(app, { mutationErrors })`, a
 *   fragment builder generic over the host's `RpcFactory<C>`. Browser-safe:
 *   value-imports only result-rpc and @agent-cms/codegen/errors.
 * - procedures.ts — `cmsProcedures(app, contract, deps)`, server-only handlers
 *   that run agent-cms's Effect services in-process against the host's D1 (or
 *   a pre-built SqlClient layer). The host spreads both into its own
 *   `app.contract({ ... })` / `app.router({ ... })`.
 */
import type { SchemaExport, SchemaExportField, SchemaExportModel } from "./schema-types.ts";

export interface GeneratedFiles {
  "contract.ts": string;
  "procedures.ts": string;
}

// --- naming ---

function pascal(apiKey: string): string {
  return apiKey
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function camel(apiKey: string): string {
  const p = pascal(apiKey);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

// --- validator helpers ---

function hasValidator(field: SchemaExportField, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(field.validators, key);
}

function isRequired(field: SchemaExportField): boolean {
  // DatoCMS-compat: boolean validators arrive as `required: {}` as well as true.
  return hasValidator(field, "required") && field.validators.required !== false;
}

function enumValues(field: SchemaExportField): string[] | null {
  const raw = field.validators.enum;
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
  if (typeof raw === "object" && raw !== null) {
    const values = Reflect.get(raw, "values");
    if (Array.isArray(values)) return values.filter((v): v is string => typeof v === "string");
  }
  return null;
}

function stringArrayValidator(field: SchemaExportField, key: string): string[] {
  const raw = field.validators[key];
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
  if (typeof raw === "object" && raw !== null) {
    const values = Reflect.get(raw, "item_types") ?? Reflect.get(raw, "values");
    if (Array.isArray(values)) return values.filter((v): v is string => typeof v === "string");
  }
  return [];
}

const DAST_IMPORT = `import type {
  BlockLevelNode as DastBlockLevelNode,
  BlockNode as DastBlockRefNode,
  BlockquoteNode as DastBlockquoteNode,
  CodeNode as DastCodeNode,
  CustomMark as DastCustomMark,
  DastDocument,
  DefaultMark as DastDefaultMark,
  HeadingNode as DastHeadingNode,
  InlineBlockNode as DastInlineBlockNode,
  InlineItemNode as DastInlineItemNode,
  InlineNode as DastInlineNode,
  ItemLinkNode as DastItemLinkNode,
  LinkNode as DastLinkNode,
  ListItemNode as DastListItemNode,
  ListNode as DastListNode,
  Mark as DastMark,
  ParagraphNode as DastParagraphNode,
  RootNode as DastRootNode,
  SpanNode as DastSpanNode,
  TableCellNode as DastTableCellNode,
  TableNode as DastTableNode,
  TableRowNode as DastTableRowNode,
  ThematicBreakNode as DastThematicBreakNode,
} from "@agent-cms/dast";
`;

// --- static prelude emitted into every contract ---

const PRELUDE = `// --- DAST (shared with the CMS and the editor) ---
// Re-exported under the historical \`Dast*\` names so consumers can keep
// importing them from this contract. The underlying import above is types-only
// and therefore erased at build time: the contract stays browser-safe and
// pulls in nothing from the CMS runtime. \`@agent-cms/dast\` has zero runtime
// dependencies — add it to the host's dependencies.
export type {
  DastBlockLevelNode,
  DastBlockRefNode,
  DastBlockquoteNode,
  DastCodeNode,
  DastCustomMark,
  DastDocument,
  DastDefaultMark,
  DastHeadingNode,
  DastInlineBlockNode,
  DastInlineItemNode,
  DastInlineNode,
  DastItemLinkNode,
  DastLinkNode,
  DastListItemNode,
  DastListNode,
  DastMark,
  DastParagraphNode,
  DastRootNode,
  DastSpanNode,
  DastTableCellNode,
  DastTableNode,
  DastTableRowNode,
  DastThematicBreakNode,
};

// --- Shared value types (structurally identical to agent-cms's own) ---

/**
 * Write shape of a media reference: an asset id, or an upload descriptor.
 * The read-only keys a read adds (\`url\`, \`filename\`, …) are declared optional
 * so a value read off a record can be written straight back — the CMS strips
 * them before storing (read-modify-write is lossless).
 */
export type MediaValue =
  | string
  | {
      upload_id: string;
      alt?: string | null;
      title?: string | null;
      focal_point?: { x: number; y: number } | null;
      custom_data?: Record<string, unknown> | null;
      url?: string;
      filename?: string;
      mime_type?: string;
      size?: number;
      width?: number | null;
      height?: number | null;
      blurhash?: string | null;
    };

/**
 * Read shape of a media reference: the stored reference merged with the asset
 * it points at, including the canonical absolute \`url\`. Assignable to
 * \`MediaValue\`, so reads can be edited and written back.
 *
 * Compose transforms with \`assetUrl(value, { width })\` from
 * \`@agent-cms/codegen/assets\` (Cloudflare Image Resizing).
 */
export interface MediaRead {
  upload_id: string;
  url: string;
  filename: string;
  mime_type: string;
  size: number;
  width: number | null;
  height: number | null;
  alt: string | null;
  title: string | null;
  focal_point: { x: number; y: number } | null;
  custom_data: Record<string, unknown> | null;
  blurhash: string | null;
}

export interface SeoValue {
  title?: string;
  description?: string;
  image?: string;
  twitterCard?: string;
  /** Read-only: the canonical URL of \`image\`, resolved by the CMS. */
  image_url?: string | null;
}

/**
 * Write shape for structured_text: the DAST value plus (optionally) new/updated
 * block payloads.
 *
 * \`TBlock\` defaults to a raw payload object, and every per-field write alias
 * widens it to \`<the field's block union> | Record<string, unknown>\` so a value
 * read back off a record (whose blocks are the concrete generated interfaces)
 * is assignable straight into an update — read-modify-write compiles with no
 * adapter.
 */
export interface StructuredTextWrite<TBlock = Record<string, unknown>> {
  value: DastDocument;
  blocks?: Readonly<Record<string, TBlock>>;
}
`;

// --- shared value types + filter vocabulary emitted into every contract ---

const SHARED = `// --- Filter operator vocabulary (mirrors src/graphql/filter-compiler.ts) ---
// A per-model \`${"${Model}"}Filter\` is carried as wire.serializable<...>() and the
// server re-validates every filter in RecordService.queryRecords. Codegen ships
// the TS shape for authoring ergonomics, NOT a full nested AND/OR wire-codec
// algebra — that round-trips losslessly through the serializer and gains nothing
// from a hand-rolled recursive codec.

export interface StringFilter<T extends string = string> {
  eq?: T; neq?: T; in?: readonly T[]; notIn?: readonly T[];
  matches?: string | { pattern: string; caseSensitive?: boolean };
  notMatches?: string | { pattern: string; caseSensitive?: boolean };
  isBlank?: boolean; isPresent?: boolean; exists?: boolean;
}
export interface NumberFilter {
  eq?: number; neq?: number; gt?: number; lt?: number; gte?: number; lte?: number;
  in?: readonly number[]; notIn?: readonly number[]; exists?: boolean;
}
export interface DateFilter {
  eq?: string; neq?: string; gt?: string; lt?: string; gte?: string; lte?: string; exists?: boolean;
}
export interface BooleanFilter { eq?: boolean; neq?: boolean; exists?: boolean; }
export interface LinkFilter { eq?: string; neq?: string; in?: readonly string[]; notIn?: readonly string[]; exists?: boolean; }
export interface LinksFilter { eq?: readonly string[]; allIn?: readonly string[]; anyIn?: readonly string[]; notIn?: readonly string[]; exists?: boolean; }
export interface MediaFilter { eq?: string; neq?: string; in?: readonly string[]; notIn?: readonly string[]; exists?: boolean; }
export interface GalleryFilter { allIn?: readonly string[]; anyIn?: readonly string[]; notIn?: readonly string[]; exists?: boolean; }
export interface GeoFilter { near?: { latitude: number; longitude: number; radius: number }; exists?: boolean; }
export type RecordStatus = "draft" | "published" | "updated";
export interface StatusFilter { eq?: RecordStatus; neq?: RecordStatus; in?: readonly RecordStatus[]; notIn?: readonly RecordStatus[]; exists?: boolean; }
export interface LocalesFilter { allIn?: readonly Locale[]; anyIn?: readonly Locale[]; notIn?: readonly Locale[]; }

/** Sidebar status cluster (RecordService.getSyncState). */
export interface RecordSyncState {
  status: string | null;
  publishedAt: string | null;
  firstPublishedAt: string | null;
  scheduledPublishAt: string | null;
  scheduledUnpublishAt: string | null;
  changedFields: string[];
}

/** A backlink: a record referencing this one via a link/links field. */
export interface RecordBacklink { modelApiKey: string; recordId: string; fieldApiKey: string; }

/** Picker-search presentation row. */
export interface PickerRow { id: string; title: string | null; image: string | null; imageUrl: string | null; status: string | null; updatedAt: string | null; }

// --- Presentation hints (ADR 0006) ---

/**
 * Which of a model's fields title and illustrate a row. Emitted per model as
 * \`<MODEL>_PRESENTATION\` with the guess resolved AT GENERATION TIME, so the
 * fallback is deterministic and visible in this artifact:
 *
 * - \`title\`: the model's \`title_field\` hint → else a field named
 *   title/name/heading/label → else the first required string/text/slug field →
 *   else the first string/text/slug field → else \`null\` ("no title field —
 *   use the record id", which is what picker rows do).
 * - \`image\`: the model's \`image_preview_field\` hint → else the first \`media\`
 *   field → else \`null\`.
 */
export interface ModelPresentation {
  /** The model's api_key. */
  readonly model: string;
  /** Field api_key whose value titles a row, or null (fall back to the id). */
  readonly title: string | null;
  /** Field api_key holding the row's preview image, or null. */
  readonly image: string | null;
}

/** The media-ish shape presentRecord can pull a preview out of. */
function presentationMedia(value: unknown): { uploadId: string; url: string | null } | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const first = presentationMedia(entry);
      if (first) return first;
    }
    return null;
  }
  if (typeof value === "string") return value.length > 0 ? { uploadId: value, url: null } : null;
  if (typeof value !== "object" || value === null) return null;
  const uploadId = Reflect.get(value, "upload_id");
  if (typeof uploadId !== "string") return null;
  const url = Reflect.get(value, "url");
  return { uploadId, url: typeof url === "string" ? url : null };
}

/**
 * Render any record as the row shape the \`search\` procedure returns, using the
 * model's presentation descriptor — so a list view, a picker and a link chip
 * can share one row component:
 *
 *   presentRecord(post, POST_PRESENTATION)  // → { id, title, image, imageUrl, … }
 *
 * Same semantics as server-side picker rows: \`title\` falls back to the record
 * id when the model has no title field, \`image\` is the asset id and
 * \`imageUrl\` its canonical URL (null until the record round-trips through a
 * read). Localized fields carry locale maps — pick a locale before presenting.
 */
export function presentRecord<T extends { id: string }>(
  record: T,
  presentation: ModelPresentation,
): PickerRow {
  const rawTitle = presentation.title === null ? null : Reflect.get(record, presentation.title);
  const media = presentation.image === null ? null : presentationMedia(Reflect.get(record, presentation.image));
  const status = Reflect.get(record, "status");
  const updatedAt = Reflect.get(record, "updatedAt");
  return {
    id: record.id,
    title:
      presentation.title === null
        ? record.id
        : typeof rawTitle === "string" && rawTitle.length > 0
          ? rawTitle
          : null,
    image: media === null ? null : media.uploadId,
    imageUrl: media === null ? null : media.url,
    status: typeof status === "string" ? status : null,
    updatedAt: typeof updatedAt === "string" ? updatedAt : null,
  };
}

/** Per-id result of a bulk publish/unpublish/delete (data, never a top-level failure). */
export interface BulkResult { id: string; ok: boolean; error?: string; }

/** A stored version. \`snapshot\` holds the record's own field values (partial). */
export interface VersionOf<T> {
  id: string;
  model_api_key: string;
  record_id: string;
  version_number: number;
  action: string;
  actor_type: string | null;
  actor_label: string | null;
  actor_token_id: string | null;
  created_at: string;
  snapshot: Partial<T>;
}

// --- Assets (shared namespace) ---

/** Asset row as stored (snake_case; colors/focal_point/tags are JSON strings). */
export interface AssetRecord {
  id: string; filename: string; basename: string | null; format: string | null;
  mime_type: string; size: number; width: number | null; height: number | null;
  alt: string | null; title: string | null; r2_key: string; blurhash: string | null;
  /** Canonical absolute URL (ASSET_BASE_URL, else the CMS's own /assets route). */
  url: string;
  colors: string | null; focal_point: string | null; tags: string; custom_data: string | null;
  created_at: string; updated_at: string; created_by: string | null; updated_by: string | null;
}
export interface AssetCreateInput {
  id?: string; filename: string; mimeType: string; size?: number;
  width?: number; height?: number; alt?: string; title?: string; r2Key?: string;
  blurhash?: string; colors?: readonly string[]; focalPoint?: { x: number; y: number }; tags?: readonly string[];
}
export interface AssetImportInput {
  id?: string; url: string; filename?: string; mimeType?: string;
  width?: number; height?: number; alt?: string; title?: string; r2Key?: string;
  blurhash?: string; colors?: readonly string[]; focalPoint?: { x: number; y: number }; tags?: readonly string[];
}
export interface AssetUpdateInput { alt?: string; title?: string; width?: number; height?: number; }
export interface AssetUsage { modelApiKey: string; recordId: string; fieldApiKey: string; }
export interface AssetCreateResult {
  id: string; filename: string; mimeType: string; size: number;
  width?: number; height?: number; alt?: string; title?: string; r2Key: string; url: string;
  createdAt: string; updatedAt: string; createdBy: string | null; updatedBy: string | null;
}
export interface AssetReplaceResult {
  id: string; filename: string; mimeType: string; size: number;
  width?: number; height?: number; alt: string | null; title: string | null;
  r2Key: string; url: string; replaced: true; updatedAt: string; updatedBy: string | null;
}
export interface AssetUpdateResult { id: string; alt: string | null; title: string | null; width: number | null; height: number | null; url: string; updatedAt: string; updatedBy: string | null; }
export interface UploadUrlResult { uploadUrl: string; r2Key: string; assetId: string; }
`;

// --- shared wire codecs (module-level; reused across every model) ---

const SHARED_CODECS = `// --- Shared reusable codecs (defined once, referenced by every model) ---
const nullableString = wire.union([wire.string, wire.null] as const);
const PageInput = wire.object({ limit: wire.optional(wire.integer()), offset: wire.optional(wire.integer()) });
const StatusInput = wire.union([wire.literal("draft"), wire.literal("published"), wire.literal("updated")] as const);
const IdInput = wire.object({ id: wire.string });
const IdsInput = wire.object({ ids: wire.array(wire.string) });
export const PickerRowsCodec = wire.array(wire.object({
  id: wire.string, title: nullableString, image: nullableString, imageUrl: nullableString,
  status: nullableString, updatedAt: nullableString,
}));
export const BulkResultsCodec = wire.array(wire.object({ id: wire.string, ok: wire.boolean, error: wire.optional(wire.string) }));
export const BacklinksCodec = wire.array(wire.object({ modelApiKey: wire.string, recordId: wire.string, fieldApiKey: wire.string }));
export const ValidCodec = wire.object({ valid: wire.boolean });
export const SyncStateCodec = wire.object({
  status: nullableString, publishedAt: nullableString, firstPublishedAt: nullableString,
  scheduledPublishAt: nullableString, scheduledUnpublishAt: nullableString, changedFields: wire.array(wire.string),
});
export const AssetRecordCodec = wire.serializable<AssetRecord>();
export const AssetListCodec = wire.object({ assets: wire.array(AssetRecordCodec), total: wire.integer() });
export const AssetUsagesCodec = wire.array(wire.object({ modelApiKey: wire.string, recordId: wire.string, fieldApiKey: wire.string }));
export const AssetCreateResultCodec = wire.serializable<AssetCreateResult>();
export const AssetReplaceResultCodec = wire.serializable<AssetReplaceResult>();
export const AssetUpdateResultCodec = wire.serializable<AssetUpdateResult>();
export const UploadUrlResultCodec = wire.serializable<UploadUrlResult>();
export const AssetDeletedCodec = wire.object({ deleted: wire.boolean });
`;

// --- per-field mapping ---

interface EmitContext {
  blockModels: SchemaExportModel[];
  localeUnion: string;
}

interface FieldEmit {
  /** wire codec expression for read output (pre null/localized wrapping) */
  outCodec: string;
  /** wire codec expression for write input (pre optional/localized wrapping) */
  inCodec: string;
  /** extra top-level declarations (interfaces) this field needs */
  declarations: string[];
  comment?: string;
}

function blockUnionFor(ctx: EmitContext, whitelist: string[] | null): string {
  const models =
    whitelist === null || whitelist.length === 0
      ? ctx.blockModels
      : ctx.blockModels.filter((m) => whitelist.includes(m.apiKey));
  if (models.length === 0) return "never";
  return models.map((m) => `${pascal(m.apiKey)}Block`).join(" | ");
}

function fieldEmit(model: SchemaExportModel, field: SchemaExportField, ctx: EmitContext): FieldEmit {
  const typeName = `${pascal(model.apiKey)}${pascal(field.apiKey)}`;
  switch (field.fieldType) {
    case "string":
    case "text":
    case "slug": {
      const values = enumValues(field);
      if (values) {
        const codec = `wire.union([${values.map((v) => `wire.literal(${JSON.stringify(v)})`).join(", ")}] as const)`;
        return { outCodec: codec, inCodec: codec, declarations: [] };
      }
      return { outCodec: "wire.string", inCodec: "wire.string", declarations: [] };
    }
    case "date":
      return { outCodec: "wire.string", inCodec: "wire.string", declarations: [], comment: "ISO date YYYY-MM-DD" };
    case "date_time":
      return { outCodec: "wire.string", inCodec: "wire.string", declarations: [], comment: "ISO datetime" };
    case "boolean":
      return { outCodec: "wire.boolean", inCodec: "wire.boolean", declarations: [] };
    case "integer":
      return { outCodec: "wire.integer()", inCodec: "wire.integer()", declarations: [] };
    case "float":
      return { outCodec: "wire.finiteNumber", inCodec: "wire.finiteNumber", declarations: [] };
    case "color": {
      const codec =
        "wire.object({ red: wire.integer({ min: 0, max: 255 }), green: wire.integer({ min: 0, max: 255 }), blue: wire.integer({ min: 0, max: 255 }), alpha: wire.optional(wire.integer({ min: 0, max: 255 })) })";
      return { outCodec: codec, inCodec: codec, declarations: [] };
    }
    case "lat_lon": {
      const codec = "wire.object({ latitude: wire.finiteNumber, longitude: wire.finiteNumber })";
      return { outCodec: codec, inCodec: codec, declarations: [] };
    }
    case "json":
      return { outCodec: "wire.serializable<unknown>()", inCodec: "wire.serializable<unknown>()", declarations: [] };
    case "seo":
      return { outCodec: "wire.serializable<SeoValue>()", inCodec: "wire.serializable<SeoValue>()", declarations: [] };
    case "media":
      return {
        outCodec: "wire.serializable<MediaRead>()",
        inCodec: "wire.serializable<MediaValue>()",
        declarations: [],
        comment: "read: asset + canonical url · write: asset id or descriptor",
      };
    case "media_gallery":
      return {
        outCodec: "wire.serializable<MediaRead[]>()",
        inCodec: "wire.serializable<MediaValue[]>()",
        declarations: [],
        comment: "read: assets + canonical urls · write: asset ids or descriptors",
      };
    case "video":
      return { outCodec: "wire.serializable<unknown>()", inCodec: "wire.serializable<unknown>()", declarations: [] };
    case "link": {
      const targets = stringArrayValidator(field, "item_item_type");
      return {
        outCodec: "wire.string",
        inCodec: "wire.string",
        declarations: [],
        comment: targets.length > 0 ? `record id → ${targets.join(" | ")}` : "record id",
      };
    }
    case "links": {
      const targets = stringArrayValidator(field, "items_item_type");
      return {
        outCodec: "wire.array(wire.string)",
        inCodec: "wire.array(wire.string)",
        declarations: [],
        comment: targets.length > 0 ? `record ids → ${targets.join(" | ")}` : "record ids",
      };
    }
    case "structured_text": {
      const whitelist = hasValidator(field, "structured_text_blocks")
        ? stringArrayValidator(field, "structured_text_blocks")
        : null;
      const union = blockUnionFor(ctx, whitelist);
      const envelope = `${typeName}Envelope`;
      const write = `${typeName}Write`;
      const declarations = [
        [
          `/** structured_text envelope for ${model.apiKey}.${field.apiKey}${whitelist === null ? " (no block whitelist — union of all block models)" : ""} */`,
          `export interface ${envelope} {`,
          `  value: DastDocument;`,
          `  blocks: Record<string, ${union}>;`,
          `}`,
        ].join("\n"),
        [
          `/** Write shape for ${model.apiKey}.${field.apiKey}. ${envelope} (what a read returns) is assignable to it. */`,
          `export type ${write} = StructuredTextWrite<${union === "never" ? "Record<string, unknown>" : `${union} | Record<string, unknown>`}>;`,
        ].join("\n"),
      ];
      return {
        outCodec: `wire.serializable<${envelope}>()`,
        inCodec: `wire.serializable<${write}>()`,
        declarations,
      };
    }
    case "rich_text": {
      const whitelist = hasValidator(field, "rich_text_blocks")
        ? stringArrayValidator(field, "rich_text_blocks")
        : null;
      const union = blockUnionFor(ctx, whitelist);
      return {
        outCodec: `wire.serializable<Array<${union}>>()`,
        inCodec: "wire.serializable<unknown>()",
        declarations: [],
      };
    }
    default:
      return {
        outCodec: "wire.serializable<unknown>()",
        inCodec: "wire.serializable<unknown>()",
        declarations: [],
        comment: `unknown field type "${field.fieldType}" — passthrough`,
      };
  }
}

/** TS type string for block-model payload fields (blocks are TS-only, not codecs). */
function blockFieldTsType(field: SchemaExportField): string {
  switch (field.fieldType) {
    case "string":
    case "text":
    case "slug": {
      const values = enumValues(field);
      return values ? values.map((v) => JSON.stringify(v)).join(" | ") : "string";
    }
    case "date":
    case "date_time":
      return "string";
    case "boolean":
      return "boolean";
    case "integer":
    case "float":
      return "number";
    case "color":
      return "{ red: number; green: number; blue: number; alpha?: number }";
    case "lat_lon":
      return "{ latitude: number; longitude: number }";
    case "seo":
      return "SeoValue";
    case "media":
      return "MediaRead";
    case "media_gallery":
      return "MediaRead[]";
    case "link":
      return "string";
    case "links":
      return "string[]";
    case "structured_text":
      return "{ value: DastDocument; blocks: Record<string, unknown> }";
    default:
      return "unknown";
  }
}

// --- presentation hints (resolved at generation time) ---

/** Field api_keys conventionally holding a record's title, in preference order. */
const TITLE_FIELD_NAMES: readonly string[] = ["title", "name", "heading", "label"];
const TITLE_FIELD_TYPES: ReadonlySet<string> = new Set(["string", "text", "slug"]);

export interface ResolvedPresentation {
  title: string | null;
  image: string | null;
}

/**
 * Resolve a model's presentation fields. Mirrors RecordService's picker-row
 * resolution (src/services/record-service.ts) so a generated row and a picker
 * row title the same record identically — the difference is only *when* it runs:
 * here, once, into the artifact.
 */
export function resolvePresentation(model: SchemaExportModel): ResolvedPresentation {
  const fields = [...model.fields].sort((a, b) => a.position - b.position);
  const has = (apiKey: string | null | undefined): apiKey is string =>
    typeof apiKey === "string" && fields.some((f) => f.apiKey === apiKey);

  const titleFromName = TITLE_FIELD_NAMES.map((name) =>
    fields.find((f) => f.apiKey === name),
  ).find((f) => f !== undefined);
  const strings = fields.filter((f) => TITLE_FIELD_TYPES.has(f.fieldType));
  const title = has(model.titleField)
    ? model.titleField
    : (titleFromName?.apiKey ??
      strings.find((f) => isRequired(f))?.apiKey ??
      strings[0]?.apiKey ??
      null);

  const image = has(model.imagePreviewField)
    ? model.imagePreviewField
    : (fields.find((f) => f.fieldType === "media")?.apiKey ?? null);

  return { title, image };
}

function emitPresentation(model: SchemaExportModel): string {
  const { title, image } = resolvePresentation(model);
  const source = (hint: string | null | undefined, resolved: string | null): string =>
    hint != null && hint === resolved ? "explicit hint" : resolved === null ? "no candidate" : "generation-time fallback";
  return [
    `/** Presentation for ${model.apiKey}: title = ${source(model.titleField, title)}, image = ${source(model.imagePreviewField, image)}. */`,
    `export const ${pascal(model.apiKey).toUpperCase()}_PRESENTATION = {`,
    `  model: ${JSON.stringify(model.apiKey)},`,
    `  title: ${title === null ? "null" : JSON.stringify(title)},`,
    `  image: ${image === null ? "null" : JSON.stringify(image)},`,
    `} as const satisfies ModelPresentation;`,
  ].join("\n");
}

// --- filter / orderBy typing (per-model, from the field registry) ---

/** The filter operator interface for a field type, or null when not filterable. */
function filterOperatorType(field: SchemaExportField): string | null {
  switch (field.fieldType) {
    case "string":
    case "text":
    case "slug": {
      const values = enumValues(field);
      return values ? `StringFilter<${values.map((v) => JSON.stringify(v)).join(" | ")}>` : "StringFilter";
    }
    case "integer":
    case "float":
      return "NumberFilter";
    case "date":
    case "date_time":
      return "DateFilter";
    case "boolean":
      return "BooleanFilter";
    case "link":
      return "LinkFilter";
    case "links":
      return "LinksFilter";
    case "media":
      return "MediaFilter";
    case "media_gallery":
      return "GalleryFilter";
    case "lat_lon":
      return "GeoFilter";
    default:
      // color / json / seo / video / structured_text / rich_text — not filterable.
      return null;
  }
}

/** Field types a record may be ordered by (scalar columns only). */
const ORDERABLE_FIELD_TYPES: ReadonlySet<string> = new Set([
  "string", "text", "slug", "integer", "float", "date", "date_time", "boolean",
]);

const ORDER_META_KEYS = [
  "id", "_status", "_position", "_createdAt", "_updatedAt", "_publishedAt", "_firstPublishedAt",
];

function emitFilterInterface(model: SchemaExportModel, fields: readonly SchemaExportField[]): string {
  const M = pascal(model.apiKey);
  const lines = [`export interface ${M}Filter {`, `  id?: StringFilter;`];
  for (const field of fields) {
    const op = filterOperatorType(field);
    if (op) lines.push(`  ${field.apiKey}?: ${op};`);
  }
  lines.push(
    `  _status?: StatusFilter;`,
    `  _createdAt?: DateFilter;`,
    `  _updatedAt?: DateFilter;`,
    `  _publishedAt?: DateFilter;`,
    `  _firstPublishedAt?: DateFilter;`,
    `  _position?: NumberFilter;`,
  );
  if (fields.some((f) => f.localized)) lines.push(`  _locales?: LocalesFilter;`);
  lines.push(`  AND?: readonly ${M}Filter[];`, `  OR?: readonly ${M}Filter[];`, `}`);
  return lines.join("\n");
}

function emitOrderByType(model: SchemaExportModel, fields: readonly SchemaExportField[]): string {
  const M = pascal(model.apiKey);
  const keys = [
    ...fields.filter((f) => ORDERABLE_FIELD_TYPES.has(f.fieldType)).map((f) => f.apiKey),
    ...ORDER_META_KEYS,
  ];
  const union = keys.flatMap((k) => [`"${k}_ASC"`, `"${k}_DESC"`]).join(" | ");
  return `export type ${M}OrderBy = ${union || "never"};`;
}

// --- per-model contract + procedure fragment builders ---
// These emit the string bodies spliced into cmsContract / cmsProcedures. Kept
// as functions (not inline) so the collection/singleton split stays readable.

function collectionContract(key: string, M: string, sortable: boolean): string {
  const affects = `.errors(mutationErrors).affects(${key}List).mutation()`;
  const lines = [
    `    const ${key}List = app.procedure().input(wire.object({`,
    `      filter: wire.optional(wire.serializable<${M}Filter>()),`,
    `      orderBy: wire.optional(wire.array(wire.serializable<${M}OrderBy>())),`,
    `      page: wire.optional(PageInput),`,
    `      status: wire.optional(StatusInput),`,
    `    })).output(wire.object({ records: wire.array(${M}Codec), total: wire.integer() }))`,
    `      .errors(pickErrors(cmsErrors, "schemaDrift")).query();`,
    `    const ${key} = {`,
    `      list: ${key}List,`,
    `      byId: app.procedure().input(IdInput).output(${M}Codec)`,
    `        .errors(pickErrors(cmsErrors, "recordNotFound", "schemaDrift")).query(),`,
    `      search: app.procedure().input(wire.object({ q: wire.string, page: wire.optional(PageInput) })).output(PickerRowsCodec)`,
    `        .errors(pickErrors(cmsErrors, "schemaDrift")).query(),`,
    `      create: app.procedure().input(wire.object({ data: ${M}CreateInput })).output(${M}Codec)`,
    `        .errors(pickErrors(cmsErrors, "validationFailed", "duplicate", "schemaDrift"))${affects},`,
    `      update: app.procedure().input(wire.object({ id: wire.string, data: ${M}UpdateInput })).output(${M}Codec)`,
    `        .errors(pickErrors(cmsErrors, "recordNotFound", "validationFailed", "duplicate", "schemaDrift"))${affects},`,
    `      delete: app.procedure().input(IdInput).output(wire.object({ id: wire.string }))`,
    `        .errors(pickErrors(cmsErrors, "recordNotFound", "referenceConflict", "schemaDrift"))${affects},`,
    `      duplicate: app.procedure().input(IdInput).output(${M}Codec)`,
    `        .errors(pickErrors(cmsErrors, "recordNotFound", "schemaDrift"))${affects},`,
    `      publish: app.procedure().input(IdInput).output(${M}Codec)`,
    `        .errors(pickErrors(cmsErrors, "recordNotFound", "validationFailed", "schemaDrift"))${affects},`,
    `      unpublish: app.procedure().input(IdInput).output(${M}Codec)`,
    `        .errors(pickErrors(cmsErrors, "recordNotFound", "validationFailed", "schemaDrift"))${affects},`,
    `      publishMany: app.procedure().input(IdsInput).output(BulkResultsCodec)${affects},`,
    `      unpublishMany: app.procedure().input(IdsInput).output(BulkResultsCodec)${affects},`,
    `      deleteMany: app.procedure().input(IdsInput).output(BulkResultsCodec)${affects},`,
    `      links: app.procedure().input(IdInput).output(BacklinksCodec)`,
    `        .errors(pickErrors(cmsErrors, "recordNotFound", "schemaDrift")).query(),`,
    // Loose input on purpose: a dry-run validates half-filled forms, so it must
    // accept a partial payload (the server reports the missing required fields).
    `      validate: app.procedure().input(wire.object({ data: wire.serializable<Partial<Create${M}>>() })).output(ValidCodec)`,
    `        .errors(pickErrors(cmsErrors, "validationFailed", "schemaDrift")).query(),`,
    `      validateUpdate: app.procedure().input(wire.object({ id: wire.string, data: ${M}UpdateInput })).output(ValidCodec)`,
    `        .errors(pickErrors(cmsErrors, "recordNotFound", "validationFailed", "schemaDrift")).query(),`,
    `      syncState: app.procedure().input(IdInput).output(SyncStateCodec)`,
    `        .errors(pickErrors(cmsErrors, "recordNotFound", "schemaDrift")).query(),`,
    `      versions: {`,
    `        list: app.procedure().input(IdInput).output(${M}VersionListCodec)`,
    `          .errors(pickErrors(cmsErrors, "recordNotFound", "schemaDrift")).query(),`,
    `        get: app.procedure().input(wire.object({ id: wire.string, versionId: wire.string })).output(${M}VersionCodec)`,
    `          .errors(pickErrors(cmsErrors, "recordNotFound", "schemaDrift")).query(),`,
    `        restore: app.procedure().input(wire.object({ id: wire.string, versionId: wire.string })).output(${M}Codec)`,
    `          .errors(pickErrors(cmsErrors, "recordNotFound", "schemaDrift"))${affects},`,
    `      },`,
    `      schedulePublish: app.procedure().input(wire.object({ id: wire.string, at: wire.string })).output(${M}Codec)`,
    `        .errors(pickErrors(cmsErrors, "recordNotFound", "validationFailed", "schemaDrift"))${affects},`,
    `      scheduleUnpublish: app.procedure().input(wire.object({ id: wire.string, at: wire.string })).output(${M}Codec)`,
    `        .errors(pickErrors(cmsErrors, "recordNotFound", "validationFailed", "schemaDrift"))${affects},`,
    `      clearSchedule: app.procedure().input(IdInput).output(${M}Codec)`,
    `        .errors(pickErrors(cmsErrors, "recordNotFound", "schemaDrift"))${affects},`,
  ];
  if (sortable) {
    lines.push(
      `      reorder: app.procedure().input(IdsInput).output(wire.object({ reordered: wire.integer() }))`,
      `        .errors(pickErrors(cmsErrors, "schemaDrift"))${affects},`,
    );
  }
  lines.push(`    };`);
  return lines.join("\n");
}

function collectionProcedures(key: string, M: string, KEYS: string, api: string, sortable: boolean): string {
  const dec = (op: string) => `        return decodeRecord(${M}Codec, ${KEYS}, "${key}.${op}", r.value);`;
  const lines = [
    `    ${key}: {`,
    `      list: app.implement(contract.${key}.list).handler(async ({ input }) => {`,
    `        const r = await cms.query(${api}, toQueryOptions(input));`,
    `        if (!r.ok) return r;`,
    `        return decodeRecordPage(${M}Codec, ${KEYS}, "${key}.list", r.value);`,
    `      }),`,
    `      byId: app.implement(contract.${key}.byId).handler(async ({ input }) => {`,
    `        const r = await cms.byId(${api}, input.id);`,
    `        if (!r.ok) return r;`,
    dec("byId"),
    `      }),`,
    `      search: app.implement(contract.${key}.search).handler(async ({ input }) => cms.search(${api}, input.q, input.page ?? undefined)),`,
    `      create: mutation(contract.${key}.create).handler(async ({ input, context }) => {`,
    `        const r = await cms.create(${api}, toRecord(input.data), actorFor(context));`,
    `        if (!r.ok) return r;`,
    dec("create"),
    `      }),`,
    `      update: mutation(contract.${key}.update).handler(async ({ input, context }) => {`,
    `        const r = await cms.update(${api}, input.id, toRecord(input.data), actorFor(context));`,
    `        if (!r.ok) return r;`,
    dec("update"),
    `      }),`,
    `      delete: mutation(contract.${key}.delete).handler(async ({ input }) => cms.remove(${api}, input.id)),`,
    `      duplicate: mutation(contract.${key}.duplicate).handler(async ({ input, context }) => {`,
    `        const r = await cms.duplicate(${api}, input.id, actorFor(context));`,
    `        if (!r.ok) return r;`,
    dec("duplicate"),
    `      }),`,
    `      publish: mutation(contract.${key}.publish).handler(async ({ input, context }) => {`,
    `        const r = await cms.publish(${api}, input.id, actorFor(context));`,
    `        if (!r.ok) return r;`,
    dec("publish"),
    `      }),`,
    `      unpublish: mutation(contract.${key}.unpublish).handler(async ({ input, context }) => {`,
    `        const r = await cms.unpublish(${api}, input.id, actorFor(context));`,
    `        if (!r.ok) return r;`,
    dec("unpublish"),
    `      }),`,
    `      publishMany: mutation(contract.${key}.publishMany).handler(async ({ input, context }) => cms.publishMany(${api}, input.ids, actorFor(context))),`,
    `      unpublishMany: mutation(contract.${key}.unpublishMany).handler(async ({ input, context }) => cms.unpublishMany(${api}, input.ids, actorFor(context))),`,
    `      deleteMany: mutation(contract.${key}.deleteMany).handler(async ({ input, context }) => cms.deleteMany(${api}, input.ids, actorFor(context))),`,
    `      links: app.implement(contract.${key}.links).handler(async ({ input }) => cms.links(${api}, input.id)),`,
    `      validate: app.implement(contract.${key}.validate).handler(async ({ input }) => cms.validate(${api}, toRecord(input.data))),`,
    `      validateUpdate: app.implement(contract.${key}.validateUpdate).handler(async ({ input }) => cms.validateUpdate(${api}, input.id, toRecord(input.data))),`,
    `      syncState: app.implement(contract.${key}.syncState).handler(async ({ input }) => {`,
    `        const r = await cms.syncState(${api}, input.id);`,
    `        if (!r.ok) return r;`,
    `        return decodeOutput(SyncStateCodec, "${key}.syncState", r.value);`,
    `      }),`,
    `      versions: {`,
    `        list: app.implement(contract.${key}.versions.list).handler(async ({ input }) => {`,
    `          const r = await cms.versionsList(${api}, input.id);`,
    `          if (!r.ok) return r;`,
    `          return decodeOutput(${M}VersionListCodec, "${key}.versions.list", r.value);`,
    `        }),`,
    `        get: app.implement(contract.${key}.versions.get).handler(async ({ input }) => {`,
    `          const r = await cms.versionsGet(${api}, input.id, input.versionId);`,
    `          if (!r.ok) return r;`,
    `          return decodeOutput(${M}VersionCodec, "${key}.versions.get", r.value);`,
    `        }),`,
    `        restore: mutation(contract.${key}.versions.restore).handler(async ({ input, context }) => {`,
    `          const r = await cms.versionsRestore(${api}, input.id, input.versionId, actorFor(context));`,
    `          if (!r.ok) return r;`,
    `          return decodeRecord(${M}Codec, ${KEYS}, "${key}.versions.restore", r.value);`,
    `        }),`,
    `      },`,
    `      schedulePublish: mutation(contract.${key}.schedulePublish).handler(async ({ input, context }) => {`,
    `        const r = await cms.schedulePublish(${api}, input.id, input.at, actorFor(context));`,
    `        if (!r.ok) return r;`,
    dec("schedulePublish"),
    `      }),`,
    `      scheduleUnpublish: mutation(contract.${key}.scheduleUnpublish).handler(async ({ input, context }) => {`,
    `        const r = await cms.scheduleUnpublish(${api}, input.id, input.at, actorFor(context));`,
    `        if (!r.ok) return r;`,
    dec("scheduleUnpublish"),
    `      }),`,
    `      clearSchedule: mutation(contract.${key}.clearSchedule).handler(async ({ input, context }) => {`,
    `        const r = await cms.clearSchedule(${api}, input.id, actorFor(context));`,
    `        if (!r.ok) return r;`,
    dec("clearSchedule"),
    `      }),`,
  ];
  if (sortable) {
    lines.push(
      `      reorder: mutation(contract.${key}.reorder).handler(async ({ input, context }) => cms.reorder(${api}, input.ids, actorFor(context))),`,
    );
  }
  lines.push(`    },`);
  return lines.join("\n");
}

function singletonContract(key: string, M: string): string {
  const affects = `.errors(mutationErrors).affects(${key}Get).mutation()`;
  return [
    `    const ${key}Get = app.procedure().output(${M}Codec)`,
    `      .errors(pickErrors(cmsErrors, "recordNotFound", "schemaDrift")).query();`,
    `    const ${key} = {`,
    `      get: ${key}Get,`,
    `      update: app.procedure().input(wire.object({ data: ${M}UpdateInput })).output(${M}Codec)`,
    `        .errors(pickErrors(cmsErrors, "recordNotFound", "validationFailed", "duplicate", "schemaDrift"))${affects},`,
    `      validate: app.procedure().input(wire.object({ data: ${M}UpdateInput })).output(ValidCodec)`,
    `        .errors(pickErrors(cmsErrors, "validationFailed", "schemaDrift")).query(),`,
    `      syncState: app.procedure().output(SyncStateCodec)`,
    `        .errors(pickErrors(cmsErrors, "recordNotFound", "schemaDrift")).query(),`,
    `      publish: app.procedure().output(${M}Codec)`,
    `        .errors(pickErrors(cmsErrors, "recordNotFound", "validationFailed", "schemaDrift"))${affects},`,
    `      unpublish: app.procedure().output(${M}Codec)`,
    `        .errors(pickErrors(cmsErrors, "recordNotFound", "validationFailed", "schemaDrift"))${affects},`,
    `    };`,
  ].join("\n");
}

function singletonProcedures(key: string, M: string, KEYS: string, api: string): string {
  return [
    `    ${key}: {`,
    `      get: app.implement(contract.${key}.get).handler(async () => {`,
    `        const r = await cms.getSingleton(${api});`,
    `        if (!r.ok) return r;`,
    `        return decodeRecord(${M}Codec, ${KEYS}, "${key}.get", r.value);`,
    `      }),`,
    `      update: mutation(contract.${key}.update).handler(async ({ input, context }) => {`,
    `        const r = await cms.updateSingleton(${api}, toRecord(input.data), actorFor(context));`,
    `        if (!r.ok) return r;`,
    `        return decodeRecord(${M}Codec, ${KEYS}, "${key}.update", r.value);`,
    `      }),`,
    `      validate: app.implement(contract.${key}.validate).handler(async ({ input }) => cms.validate(${api}, toRecord(input.data))),`,
    `      syncState: app.implement(contract.${key}.syncState).handler(async () => {`,
    `        const r = await cms.syncStateSingleton(${api});`,
    `        if (!r.ok) return r;`,
    `        return decodeOutput(SyncStateCodec, "${key}.syncState", r.value);`,
    `      }),`,
    `      publish: mutation(contract.${key}.publish).handler(async ({ context }) => {`,
    `        const r = await cms.publishSingleton(${api}, actorFor(context));`,
    `        if (!r.ok) return r;`,
    `        return decodeRecord(${M}Codec, ${KEYS}, "${key}.publish", r.value);`,
    `      }),`,
    `      unpublish: mutation(contract.${key}.unpublish).handler(async ({ context }) => {`,
    `        const r = await cms.unpublishSingleton(${api}, actorFor(context));`,
    `        if (!r.ok) return r;`,
    `        return decodeRecord(${M}Codec, ${KEYS}, "${key}.unpublish", r.value);`,
    `      }),`,
    `    },`,
  ].join("\n");
}

function assetsContract(): string {
  const affects = `.errors(mutationErrors).affects(assetsList).mutation()`;
  return [
    `    const assetsList = app.procedure()`,
    `      .input(wire.object({ q: wire.optional(wire.string), page: wire.optional(PageInput), orderBy: wire.optional(wire.array(wire.string)) }))`,
    `      .output(AssetListCodec).errors(pickErrors(cmsErrors, "schemaDrift")).query();`,
    `    const assets = {`,
    `      list: assetsList,`,
    `      get: app.procedure().input(IdInput).output(AssetRecordCodec)`,
    `        .errors(pickErrors(cmsErrors, "recordNotFound", "schemaDrift")).query(),`,
    `      createUploadUrl: app.procedure().input(wire.object({ filename: wire.string, contentType: wire.string })).output(UploadUrlResultCodec)`,
    `        .errors(pickErrors(cmsErrors, "schemaDrift")).errors(mutationErrors).mutation(),`,
    `      create: app.procedure().input(wire.object({ data: wire.serializable<AssetCreateInput>() })).output(AssetCreateResultCodec)`,
    `        .errors(pickErrors(cmsErrors, "duplicate", "schemaDrift"))${affects},`,
    `      importFromUrl: app.procedure().input(wire.serializable<AssetImportInput>()).output(AssetCreateResultCodec)`,
    `        .errors(pickErrors(cmsErrors, "schemaDrift")).errors(mutationErrors).affects(assetsList).mutation(),`,
    `      update: app.procedure().input(wire.object({ id: wire.string, data: wire.serializable<AssetUpdateInput>() })).output(AssetUpdateResultCodec)`,
    `        .errors(pickErrors(cmsErrors, "recordNotFound", "schemaDrift"))${affects},`,
    `      replace: app.procedure().input(wire.object({ id: wire.string, data: wire.serializable<AssetCreateInput>() })).output(AssetReplaceResultCodec)`,
    `        .errors(pickErrors(cmsErrors, "recordNotFound", "schemaDrift"))${affects},`,
    `      delete: app.procedure().input(wire.object({ id: wire.string, force: wire.optional(wire.boolean) })).output(AssetDeletedCodec)`,
    `        .errors(pickErrors(cmsErrors, "recordNotFound", "referenceConflict"))${affects},`,
    `      usages: app.procedure().input(IdInput).output(AssetUsagesCodec)`,
    `        .errors(pickErrors(cmsErrors, "recordNotFound")).query(),`,
    `    };`,
  ].join("\n");
}

function assetsProcedures(): string {
  return [
    `    assets: {`,
    `      list: app.implement(contract.assets.list).handler(async ({ input }) => {`,
    `        const r = await cms.assetsList({ query: input.q ?? undefined, page: input.page ?? undefined, orderBy: input.orderBy ? [...input.orderBy] : undefined });`,
    `        if (!r.ok) return r;`,
    `        return decodeOutput(AssetListCodec, "assets.list", r.value);`,
    `      }),`,
    `      get: app.implement(contract.assets.get).handler(async ({ input }) => {`,
    `        const r = await cms.assetsGet(input.id);`,
    `        if (!r.ok) return r;`,
    `        return decodeOutput(AssetRecordCodec, "assets.get", r.value);`,
    `      }),`,
    `      createUploadUrl: mutation(contract.assets.createUploadUrl).handler(async ({ input }) => {`,
    `        const r = await cms.assetsCreateUploadUrl({ filename: input.filename, mimeType: input.contentType });`,
    `        if (!r.ok) return r;`,
    `        return decodeOutput(UploadUrlResultCodec, "assets.createUploadUrl", r.value);`,
    `      }),`,
    `      create: mutation(contract.assets.create).handler(async ({ input, context }) => {`,
    `        const r = await cms.assetsCreate(input.data, actorFor(context));`,
    `        if (!r.ok) return r;`,
    `        return decodeOutput(AssetCreateResultCodec, "assets.create", r.value);`,
    `      }),`,
    `      importFromUrl: mutation(contract.assets.importFromUrl).handler(async ({ input, context }) => {`,
    `        const r = await cms.assetsImportFromUrl(input, actorFor(context));`,
    `        if (!r.ok) return r;`,
    `        return decodeOutput(AssetCreateResultCodec, "assets.importFromUrl", r.value);`,
    `      }),`,
    `      update: mutation(contract.assets.update).handler(async ({ input, context }) => {`,
    `        const r = await cms.assetsUpdate(input.id, input.data, actorFor(context));`,
    `        if (!r.ok) return r;`,
    `        return decodeOutput(AssetUpdateResultCodec, "assets.update", r.value);`,
    `      }),`,
    `      replace: mutation(contract.assets.replace).handler(async ({ input, context }) => {`,
    `        const r = await cms.assetsReplace(input.id, input.data, actorFor(context));`,
    `        if (!r.ok) return r;`,
    `        return decodeOutput(AssetReplaceResultCodec, "assets.replace", r.value);`,
    `      }),`,
    `      delete: mutation(contract.assets.delete).handler(async ({ input }) => cms.assetsDelete(input.id, input.force ?? false)),`,
    `      usages: app.implement(contract.assets.usages).handler(async ({ input }) => cms.assetsUsages(input.id)),`,
    `    },`,
  ].join("\n");
}

// --- emission ---

export function generate(schema: SchemaExport): GeneratedFiles {
  const blockModels = schema.models.filter((m) => m.isBlock);
  const recordModels = schema.models.filter((m) => !m.isBlock);
  const localeUnion =
    schema.locales.length > 0
      ? schema.locales.map((l) => JSON.stringify(l.code)).join(" | ")
      : "string";
  const ctx: EmitContext = { blockModels, localeUnion };

  const contract: string[] = [];
  const push = (s: string) => contract.push(s);

  push(`/* Generated by @agent-cms/codegen — DO NOT EDIT. Regenerate from the CMS schema. */`);
  push(`/* eslint-disable */`);
  push(`import { pickErrors, wire, type ErrorDefinitionMap, type InputOf, type RpcFactory } from "result-rpc";`);
  push(`import { cmsErrors } from "@agent-cms/codegen/errors";`);
  push(DAST_IMPORT);
  push(``);
  push(`export type Locale = ${localeUnion};`);
  push(`/** Localized fields travel as locale-keyed maps. */`);
  push(`export type Localized<T> = Partial<Record<Locale, T>>;`);
  push(``);
  push(PRELUDE);
  push(SHARED);
  push(SHARED_CODECS);

  // Block payload interfaces
  for (const block of blockModels) {
    push(`/** Block model "${block.name}" (${block.apiKey}) */`);
    push(`export interface ${pascal(block.apiKey)}Block {`);
    push(`  id: string;`);
    push(`  _type: ${JSON.stringify(block.apiKey)};`);
    for (const field of [...block.fields].sort((a, b) => a.position - b.position)) {
      const optional = isRequired(field) ? "" : "?";
      push(`  ${field.apiKey}${optional}: ${blockFieldTsType(field)};`);
    }
    push(`}`);
    push(``);
  }

  // Presentation descriptors — every model (records AND blocks: a block card is
  // a row too), plus a registry keyed by api_key for generic lookup.
  push(`// --- Presentation descriptors (ADR 0006; fallbacks resolved at generation time) ---`);
  push(``);
  for (const model of schema.models) {
    push(emitPresentation(model));
    push(``);
  }
  push(`/** Every model's presentation descriptor, keyed by api_key. */`);
  push(`export const PRESENTATION = {`);
  for (const model of schema.models) {
    push(`  ${JSON.stringify(model.apiKey)}: ${pascal(model.apiKey).toUpperCase()}_PRESENTATION,`);
  }
  push(`} as const satisfies Record<string, ModelPresentation>;`);
  push(``);

  const contractEntries: string[] = [];
  const procedureEntries: string[] = [];
  const codecImports: string[] = [];

  for (const model of recordModels) {
    const Model = pascal(model.apiKey);
    const key = camel(model.apiKey);
    const KEYS = `${Model.toUpperCase()}_FIELD_KEYS`;
    const fields = [...model.fields].sort((a, b) => a.position - b.position);
    const apiKeyLit = JSON.stringify(model.apiKey);

    // Field-level declarations (envelopes etc.)
    const declared = new Set<string>();
    for (const field of fields) {
      for (const decl of fieldEmit(model, field, ctx).declarations) {
        if (!declared.has(decl)) {
          declared.add(decl);
          push(decl);
          push(``);
        }
      }
    }

    // Output codec
    push(`/** ${model.name} (${model.apiKey}) */`);
    push(`export const ${Model}Codec = wire.object({`);
    push(`  id: wire.string,`);
    push(`  status: wire.string,`);
    push(`  createdAt: wire.union([wire.string, wire.null] as const),`);
    push(`  updatedAt: wire.union([wire.string, wire.null] as const),`);
    push(`  publishedAt: wire.union([wire.string, wire.null] as const),`);
    for (const field of fields) {
      const emit = fieldEmit(model, field, ctx);
      const localized = field.localized ? `wire.record(${emit.outCodec})` : emit.outCodec;
      const wrapped = isRequired(field) && !field.localized
        ? localized
        : `wire.union([${localized}, wire.null] as const)`;
      const comment = emit.comment ? ` // ${emit.comment}` : "";
      push(`  ${field.apiKey}: ${wrapped},${comment}`);
    }
    push(`});`);
    push(`export type ${Model} = InputOf<typeof ${Model}Codec>;`);
    push(``);

    // Input codecs
    push(`export const ${Model}CreateInput = wire.object({`);
    for (const field of fields) {
      const emit = fieldEmit(model, field, ctx);
      const inner = field.localized ? `wire.record(${emit.inCodec})` : emit.inCodec;
      const wrapped = isRequired(field) ? inner : `wire.optional(${inner})`;
      push(`  ${field.apiKey}: ${wrapped},`);
    }
    push(`});`);
    push(`export type Create${Model} = InputOf<typeof ${Model}CreateInput>;`);
    push(``);
    // Update input: every field is optional AND nullable. Absent = leave
    // unchanged; `null` = clear the stored value (per-locale for localized
    // fields). This mirrors what RecordService.patchRecord already honours.
    push(`export const ${Model}UpdateInput = wire.object({`);
    for (const field of fields) {
      const emit = fieldEmit(model, field, ctx);
      const nullable = `wire.union([${emit.inCodec}, wire.null] as const)`;
      const inner = field.localized ? `wire.record(${nullable})` : nullable;
      push(`  ${field.apiKey}: wire.optional(${field.localized ? `wire.union([${inner}, wire.null] as const)` : inner}),`);
    }
    push(`});`);
    push(`export type Update${Model} = InputOf<typeof ${Model}UpdateInput>;`);
    push(``);
    push(`export const ${KEYS} = [${fields.map((f) => JSON.stringify(f.apiKey)).join(", ")}] as const;`);
    push(``);
    push(`export const ${Model}VersionCodec = wire.serializable<VersionOf<${Model}>>();`);
    push(`export const ${Model}VersionListCodec = wire.array(${Model}VersionCodec);`);
    push(``);

    codecImports.push(
      `  ${Model}Codec,`,
      `  ${KEYS},`,
      `  ${Model}VersionCodec,`,
      `  ${Model}VersionListCodec,`,
    );

    if (model.singleton) {
      // Singleton: exactly one row, no collection surface (no list/byId/create/
      // delete/duplicate/bulk). get/update/validate/syncState/publish/unpublish.
      contractEntries.push(singletonContract(key, Model));
      procedureEntries.push(singletonProcedures(key, Model, KEYS, apiKeyLit));
    } else {
      push(emitFilterInterface(model, fields));
      push(``);
      push(emitOrderByType(model, fields));
      push(``);
      const sortable = model.sortable || model.tree;
      contractEntries.push(collectionContract(key, Model, sortable));
      procedureEntries.push(collectionProcedures(key, Model, KEYS, apiKeyLit, sortable));
    }
  }

  // Shared assets namespace (one, not per-model).
  contractEntries.push(assetsContract());
  procedureEntries.push(assetsProcedures());
  codecImports.push(
    `  SyncStateCodec,`,
    `  AssetListCodec,`,
    `  AssetRecordCodec,`,
    `  UploadUrlResultCodec,`,
    `  AssetCreateResultCodec,`,
    `  AssetUpdateResultCodec,`,
    `  AssetReplaceResultCodec,`,
  );

  const recordKeys = recordModels.map((m) => camel(m.apiKey));

  // The fragment builder: generic over the host's RpcFactory<C>, returning the
  // nested record the host spreads into `app.contract({ ...cmsContract(app, ...) })`.
  push(
    [
      `/**`,
      ` * Contract fragment. Spread into the host's own contract:`,
      ` *   app.contract({ ...cmsContract(app, { mutationErrors: {} }), ...hostProcedures })`,
      ` * Pass \`mutationErrors\` (e.g. \`{ Unauthorized }\`) to declare the errors the`,
      ` * host's auth middleware contributes to every CMS mutation. result-rpc is`,
      ` * contract-first, so those definitions must be declared here to be usable.`,
      ` */`,
      `export function cmsContract<C, MErrors extends ErrorDefinitionMap>(`,
      `  app: RpcFactory<C>,`,
      `  options: { mutationErrors: MErrors },`,
      `) {`,
      `  const mutationErrors = options.mutationErrors;`,
      contractEntries.join("\n"),
      `  return { ${[...recordKeys, "assets"].join(", ")} };`,
      `}`,
    ].join("\n")
  );
  push(``);

  const procedures = `/* Generated by @agent-cms/codegen — DO NOT EDIT. Regenerate from the CMS schema. */
/* eslint-disable */
/* Server-only: do not import from browser code (result-rpc client boundary). */
import type { ErrorDefinitionMap, ProcedureContract, RpcFactory } from "result-rpc";
import {
  createCmsExecutor,
  decodeOutput,
  decodeRecord,
  decodeRecordPage,
  toQueryOptions,
  toRecord,
  type CmsProceduresDeps,
  type RequestActor,
} from "@agent-cms/codegen/server-runtime";
import {
  cmsContract,
${codecImports.join("\n")}
} from "./contract.ts";

/**
 * Server implementations. Spread into the host's own router:
 *   app.router({ ...cmsProcedures(app, contract, { DB: env.DB, actor }), ...hostRouter })
 * where \`contract\` is the same fragment passed to cmsContract. Handlers run
 * agent-cms's Effect services in-process; \`deps.mutationMiddleware\` (the host's
 * auth) wraps every mutation, and \`deps.actor\` records the editor.
 */
export function cmsProcedures<C, MErrors extends ErrorDefinitionMap = ErrorDefinitionMap>(
  app: RpcFactory<C>,
  // The contract is typed WIDE (ErrorDefinitionMap) on purpose: inside a body
  // generic over MErrors the union would be opaque and the concrete cms errors
  // the handlers return would not typecheck. The client's own type safety comes
  // from cmsContract's concrete return, not from this server-side factory.
  contract: ReturnType<typeof cmsContract<C, ErrorDefinitionMap>>,
  deps: CmsProceduresDeps<C, MErrors>,
) {
  const cms = createCmsExecutor(deps);
  const actorFor = (context: C): RequestActor | null => (deps.actor ? deps.actor(context) : null);
  // Wrap a mutation contract with the host's auth middleware when supplied. The
  // middleware's errors (MErrors) are already declared on the contract, so the
  // handler's failure union is unchanged whether or not it is applied.
  const mutation = <TInput, TOutput, TDefs extends ErrorDefinitionMap>(
    procedureContract: ProcedureContract<C, TInput, TOutput, TDefs, "mutation">,
  ) => {
    const impl = app.implement(procedureContract);
    return deps.mutationMiddleware ? impl.use(deps.mutationMiddleware) : impl;
  };
  return {
${procedureEntries.join("\n")}
  };
}
`;

  return { "contract.ts": contract.join("\n"), "procedures.ts": procedures };
}
