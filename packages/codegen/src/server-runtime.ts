/**
 * The shared runtime behind generated procedures — server-only.
 *
 * Ticket 01's settled shape: the generated procedures do NOT proxy to a CMS
 * over REST; they *are* the CMS surface, running agent-cms's Effect services
 * in-process against the host's D1 (or a pre-built SqlClient layer). This
 * module owns the runtime, the tagged-error folding (ticket 07), and the
 * output projection + drift decode, so the generated artifact stays thin.
 *
 * Never import this from browser code — it pulls in agent-cms's service layer.
 */
import { err, ok, type ErrorDefinitionMap, type Middleware, type Result } from "result-rpc";
import {
  AggregateValidationError,
  AssetService,
  createAssetOp,
  createUploadUrlOp,
  DuplicateError,
  importAssetOp,
  makeCmsRuntime,
  NotFoundError,
  PublishService,
  ReferenceConflictError,
  RecordService,
  replaceAssetOp,
  ScheduleService,
  ValidationError,
  VersionService,
  type AssetUsage,
  type BulkOpResult,
  type CmsRuntimeDeps,
  type ListAssetsOptions,
  type PickerSearchRow,
  type QueryRecordsOptions,
  type RecordBacklink,
  type RecordSyncState,
  type RequestActor,
  type ValidationIssue,
} from "agent-cms/lib";
import {
  cmsErrors,
  type Duplicate,
  type RecordNotFound,
  type ReferenceConflict,
  type SchemaDrift,
  type ValidationFailed,
} from "./errors.ts";

// --- error folding (agent-cms tagged errors → cms/* wire errors) ---

function issueOf(error: ValidationError): ValidationIssue {
  return error.field === undefined
    ? { message: error.message }
    : { field: error.field, message: error.message };
}

function validationFrom(error: AggregateValidationError | ValidationError): ValidationFailed {
  const issues =
    error instanceof AggregateValidationError ? error.issues : [issueOf(error)];
  return cmsErrors.validationFailed({ issues: issues.map((issue) => ({ ...issue })) });
}

function duplicateFrom(error: DuplicateError): Duplicate {
  // Extract a field name when the message names one (`field 'x'`); slug/unique
  // collisions do, id/singleton collisions don't — leave field undefined then.
  const match = error.message.match(/field '([^']+)'/);
  return match
    ? cmsErrors.duplicate({ field: match[1], message: error.message })
    : cmsErrors.duplicate({ message: error.message });
}

function driftFrom(procedure: string, detail: string): SchemaDrift {
  return cmsErrors.schemaDrift({ procedure, detail });
}

/**
 * A `NotFoundError` for a *model* is drift (the model set is codegen-static);
 * for a *record* it is `null` here so the caller can map it to the op's own
 * `recordNotFound` (create has no such branch, so it only ever sees model).
 */
function modelDriftFrom(procedure: string, error: NotFoundError): SchemaDrift | null {
  return error.entity === "Record"
    ? null
    : driftFrom(procedure, `${error.entity} '${error.id}' not found — regenerate the client`);
}

/** Anything not adopted into a domain error is a server incident — throw it. */
function unexpected(procedure: string, error: unknown): never {
  throw new Error(
    `Unhandled CMS failure in ${procedure}: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

/**
 * The common not-found fold for ops that carry `recordNotFound`: a missing
 * Model is drift (the model set is codegen-static — regenerate); anything else
 * that is missing (Record, Version, Asset) is the op's own `recordNotFound`.
 */
function notFoundToRecordOrDrift(procedure: string, id: string, error: NotFoundError): RecordNotFound | SchemaDrift {
  return error.entity === "Model"
    ? driftFrom(procedure, `${error.entity} '${error.id}' not found — regenerate the client`)
    : cmsErrors.recordNotFound({ id });
}

// --- per-op fold helpers (shared by record + singleton variants) ---

/** notFound only (records/versions → recordNotFound, model → drift). */
function foldNotFound(procedure: string, id: string, error: unknown): RecordNotFound | SchemaDrift {
  if (error instanceof NotFoundError) return notFoundToRecordOrDrift(procedure, id, error);
  return unexpected(procedure, error);
}

/** publish/unpublish: notFound + aggregated validation. */
function foldPublish(procedure: string, id: string, error: unknown): RecordNotFound | ValidationFailed | SchemaDrift {
  if (error instanceof NotFoundError) return notFoundToRecordOrDrift(procedure, id, error);
  if (error instanceof AggregateValidationError || error instanceof ValidationError) return validationFrom(error);
  return unexpected(procedure, error);
}

/** update/patch-shaped: notFound + validation + duplicate. */
function foldUpdate(procedure: string, id: string, error: unknown): RecordNotFound | ValidationFailed | Duplicate | SchemaDrift {
  if (error instanceof NotFoundError) return notFoundToRecordOrDrift(procedure, id, error);
  if (error instanceof AggregateValidationError || error instanceof ValidationError) return validationFrom(error);
  if (error instanceof DuplicateError) return duplicateFrom(error);
  return unexpected(procedure, error);
}

/** create-shaped validate dry-run: validation + model-drift, no record lookup. */
function foldValidateCreate(procedure: string, error: unknown): ValidationFailed | SchemaDrift {
  if (error instanceof AggregateValidationError || error instanceof ValidationError) return validationFrom(error);
  if (error instanceof NotFoundError && error.entity === "Model") {
    return driftFrom(procedure, `Model '${error.id}' not found — regenerate the client`);
  }
  return unexpected(procedure, error);
}

/** update-shaped validate + schedule: notFound + validation. */
function foldValidateUpdate(procedure: string, id: string, error: unknown): RecordNotFound | ValidationFailed | SchemaDrift {
  return foldPublish(procedure, id, error);
}

/**
 * Query-list folds: a fresh client can only send filter/orderBy the CMS knows,
 * so a rejected column or a missing model is a stale build (drift), not a domain
 * outcome. Shared by record `list` and `assets.list`.
 */
function foldListDrift(procedure: string, error: unknown): SchemaDrift {
  if (error instanceof ValidationError) return driftFrom(procedure, error.message);
  if (error instanceof NotFoundError) {
    return driftFrom(procedure, `${error.entity} '${error.id}' not found — regenerate the client`);
  }
  return unexpected(procedure, error);
}

/** An asset that is missing → recordNotFound; anything else is an incident. */
function foldAssetNotFound(procedure: string, id: string, error: unknown): RecordNotFound {
  if (error instanceof NotFoundError && error.entity === "Asset") return cmsErrors.recordNotFound({ id });
  return unexpected(procedure, error);
}

/** Read `id` off an unknown record row without an `as` cast. */
function readRowId(row: unknown): string {
  return typeof row === "object" && row !== null ? String(Reflect.get(row, "id")) : "";
}

/** Coerce a service picker row to the fixed presentation shape the codec expects. */
function toPickerRow(row: PickerSearchRow): {
  id: string;
  title: string | null;
  image: string | null;
  imageUrl: string | null;
  status: string | null;
  updatedAt: string | null;
} {
  const str = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));
  return {
    id: row.id,
    title: str(row.title),
    image: row.image,
    imageUrl: row.imageUrl,
    status: str(row.status),
    updatedAt: str(row.updatedAt),
  };
}

// --- output projection + drift decode ---

const META_SOURCE: ReadonlyArray<readonly [projected: string, column: string]> = [
  ["id", "id"],
  ["status", "_status"],
  ["createdAt", "_created_at"],
  ["updatedAt", "_updated_at"],
  ["publishedAt", "_published_at"],
];

/**
 * Project a raw service record onto the generated shape: curated meta fields
 * plus the schema's declared field api_keys. Undeclared columns are dropped —
 * a column codegen doesn't know about is by definition not part of the contract.
 */
export function projectRecord(raw: unknown, fieldKeys: readonly string[]): Record<string, unknown> {
  const source: Record<string, unknown> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw))
      : {};
  const out: Record<string, unknown> = {};
  for (const [projected, column] of META_SOURCE) {
    out[projected] = source[column] ?? null;
  }
  for (const key of fieldKeys) {
    out[key] = source[key] ?? null;
  }
  return out;
}

interface DecodableCodec<T> {
  decode(value: unknown): { ok: true; value: T } | { ok: false; issues: unknown };
}

/**
 * Decode a projected record through its generated codec. A mismatch means the
 * CMS and the generated artifact disagree about the schema — drift — declared
 * on every procedure so a host shell can own "stale build, regenerate".
 */
export function decodeRecord<T>(
  codec: DecodableCodec<T>,
  fieldKeys: readonly string[],
  procedure: string,
  raw: unknown,
): Result<T, SchemaDrift> {
  const decoded = codec.decode(projectRecord(raw, fieldKeys));
  if (decoded.ok) return ok(decoded.value);
  return err(driftFrom(procedure, `output did not match the contract: ${JSON.stringify(decoded.issues)}`));
}

export function decodeRecords<T>(
  codec: DecodableCodec<T>,
  fieldKeys: readonly string[],
  procedure: string,
  rows: readonly unknown[],
): Result<T[], SchemaDrift> {
  const out: T[] = [];
  for (const row of rows) {
    const decoded = decodeRecord(codec, fieldKeys, procedure, row);
    if (!decoded.ok) return decoded;
    out.push(decoded.value);
  }
  return ok(out);
}

/** Decode a `{ records, total }` page: records through the model codec, total passed through. */
export function decodeRecordPage<T>(
  codec: DecodableCodec<T>,
  fieldKeys: readonly string[],
  procedure: string,
  page: { readonly records: readonly unknown[]; readonly total: number },
): Result<{ records: T[]; total: number }, SchemaDrift> {
  const decoded = decodeRecords(codec, fieldKeys, procedure, page.records);
  if (!decoded.ok) return decoded;
  return ok({ records: decoded.value, total: page.total });
}

/**
 * Decode a non-record output (versions, sync state, asset rows) through its
 * generated codec. Serializable codecs pass through (typing only); strict
 * codecs validate — a mismatch is drift, the same "stale build" signal.
 */
export function decodeOutput<T>(codec: DecodableCodec<T>, procedure: string, raw: unknown): Result<T, SchemaDrift> {
  const decoded = codec.decode(raw);
  if (decoded.ok) return ok(decoded.value);
  return err(driftFrom(procedure, `output did not match the contract: ${JSON.stringify(decoded.issues)}`));
}

/** Map a generated `list` input to the record service's query options. */
export function toQueryOptions(input: {
  filter?: object | null;
  orderBy?: readonly string[] | null;
  page?: { limit?: number; offset?: number } | null;
  status?: "draft" | "published" | "updated" | null;
}): QueryRecordsOptions {
  return {
    filter: input.filter ? toRecord(input.filter) : undefined,
    orderBy: input.orderBy ? [...input.orderBy] : undefined,
    page: input.page ?? undefined,
    status: input.status ?? undefined,
  };
}

/** Coerce a decoded input object into the loose record the services accept. */
export function toRecord(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value));
}

// --- the executor: one shared runtime, per-op typed folding ---

export interface CmsExecutor {
  list(modelApiKey: string): Promise<Result<unknown[], never>>;
  byId(modelApiKey: string, id: string): Promise<Result<unknown, RecordNotFound | SchemaDrift>>;
  create(
    modelApiKey: string,
    data: Record<string, unknown>,
    actor: RequestActor | null,
  ): Promise<Result<unknown, ValidationFailed | Duplicate | SchemaDrift>>;
  update(
    modelApiKey: string,
    id: string,
    data: Record<string, unknown>,
    actor: RequestActor | null,
  ): Promise<Result<unknown, RecordNotFound | ValidationFailed | Duplicate | SchemaDrift>>;
  remove(
    modelApiKey: string,
    id: string,
  ): Promise<Result<{ id: string }, RecordNotFound | ReferenceConflict | SchemaDrift>>;
  publish(
    modelApiKey: string,
    id: string,
    actor: RequestActor | null,
  ): Promise<Result<unknown, RecordNotFound | ValidationFailed | SchemaDrift>>;
  unpublish(
    modelApiKey: string,
    id: string,
    actor: RequestActor | null,
  ): Promise<Result<unknown, RecordNotFound | ValidationFailed | SchemaDrift>>;

  // --- queryable list / picker / duplicate / bulk / links (WS-R) ---
  query(
    modelApiKey: string,
    opts: QueryRecordsOptions,
  ): Promise<Result<{ records: unknown[]; total: number }, SchemaDrift>>;
  search(
    modelApiKey: string,
    q: string,
    page: { limit?: number; offset?: number } | undefined,
  ): Promise<Result<ReturnType<typeof toPickerRow>[], SchemaDrift>>;
  duplicate(
    modelApiKey: string,
    id: string,
    actor: RequestActor | null,
  ): Promise<Result<unknown, RecordNotFound | SchemaDrift>>;
  publishMany(modelApiKey: string, ids: readonly string[], actor: RequestActor | null): Promise<Result<BulkOpResult[], never>>;
  unpublishMany(modelApiKey: string, ids: readonly string[], actor: RequestActor | null): Promise<Result<BulkOpResult[], never>>;
  deleteMany(modelApiKey: string, ids: readonly string[], actor: RequestActor | null): Promise<Result<BulkOpResult[], never>>;
  links(modelApiKey: string, id: string): Promise<Result<RecordBacklink[], RecordNotFound | SchemaDrift>>;

  // --- dry-run validation + sync state (WS-V) ---
  validate(modelApiKey: string, data: Record<string, unknown>): Promise<Result<{ valid: true }, ValidationFailed | SchemaDrift>>;
  validateUpdate(
    modelApiKey: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<Result<{ valid: true }, RecordNotFound | ValidationFailed | SchemaDrift>>;
  syncState(modelApiKey: string, id: string): Promise<Result<RecordSyncState, RecordNotFound | SchemaDrift>>;

  // --- reorder (sortable/tree only) ---
  reorder(modelApiKey: string, ids: readonly string[], actor: RequestActor | null): Promise<Result<{ reordered: number }, SchemaDrift>>;

  // --- versions ---
  versionsList(modelApiKey: string, id: string): Promise<Result<unknown[], RecordNotFound | SchemaDrift>>;
  versionsGet(modelApiKey: string, id: string, versionId: string): Promise<Result<unknown, RecordNotFound | SchemaDrift>>;
  versionsRestore(
    modelApiKey: string,
    id: string,
    versionId: string,
    actor: RequestActor | null,
  ): Promise<Result<unknown, RecordNotFound | SchemaDrift>>;

  // --- schedule ---
  schedulePublish(
    modelApiKey: string,
    id: string,
    at: string,
    actor: RequestActor | null,
  ): Promise<Result<unknown, RecordNotFound | ValidationFailed | SchemaDrift>>;
  scheduleUnpublish(
    modelApiKey: string,
    id: string,
    at: string,
    actor: RequestActor | null,
  ): Promise<Result<unknown, RecordNotFound | ValidationFailed | SchemaDrift>>;
  clearSchedule(modelApiKey: string, id: string, actor: RequestActor | null): Promise<Result<unknown, RecordNotFound | SchemaDrift>>;

  // --- singleton variants (no id — the model has exactly one row) ---
  getSingleton(modelApiKey: string): Promise<Result<unknown, RecordNotFound | SchemaDrift>>;
  updateSingleton(
    modelApiKey: string,
    data: Record<string, unknown>,
    actor: RequestActor | null,
  ): Promise<Result<unknown, RecordNotFound | ValidationFailed | Duplicate | SchemaDrift>>;
  publishSingleton(modelApiKey: string, actor: RequestActor | null): Promise<Result<unknown, RecordNotFound | ValidationFailed | SchemaDrift>>;
  unpublishSingleton(modelApiKey: string, actor: RequestActor | null): Promise<Result<unknown, RecordNotFound | ValidationFailed | SchemaDrift>>;
  syncStateSingleton(modelApiKey: string): Promise<Result<RecordSyncState, RecordNotFound | SchemaDrift>>;

  // --- shared assets namespace ---
  assetsList(opts: ListAssetsOptions): Promise<Result<{ assets: unknown[]; total: number }, SchemaDrift>>;
  assetsGet(id: string): Promise<Result<unknown, RecordNotFound>>;
  assetsCreateUploadUrl(input: unknown): Promise<Result<unknown, never>>;
  assetsCreate(data: unknown, actor: RequestActor | null): Promise<Result<unknown, Duplicate>>;
  assetsImportFromUrl(data: unknown, actor: RequestActor | null): Promise<Result<unknown, never>>;
  assetsUpdate(
    id: string,
    metadata: { alt?: string; title?: string; width?: number; height?: number },
    actor: RequestActor | null,
  ): Promise<Result<unknown, RecordNotFound>>;
  assetsReplace(id: string, data: unknown, actor: RequestActor | null): Promise<Result<unknown, RecordNotFound>>;
  assetsDelete(id: string, force: boolean): Promise<Result<{ deleted: true }, RecordNotFound | ReferenceConflict>>;
  assetsUsages(id: string): Promise<Result<AssetUsage[], RecordNotFound>>;
}

export function createCmsExecutor(deps: CmsRuntimeDeps): CmsExecutor {
  const runtime = makeCmsRuntime(deps);

  return {
    list: async (modelApiKey) => {
      const proc = `${modelApiKey}.list`;
      const r = await runtime.run(RecordService.listRecords(modelApiKey));
      if (r.ok) return ok(r.value);
      // list declares no domain failures; a missing model (drift) or any other
      // error is a server incident — throwing routes it to server/internal.
      return unexpected(proc, r.error);
    },

    byId: async (modelApiKey, id) => {
      const proc = `${modelApiKey}.byId`;
      const r = await runtime.run(RecordService.getRecord(modelApiKey, id));
      if (r.ok) return ok(r.value);
      const e = r.error;
      if (e instanceof NotFoundError) {
        return e.entity === "Record"
          ? err(cmsErrors.recordNotFound({ id }))
          : err(driftFrom(proc, `${e.entity} '${e.id}' not found — regenerate the client`));
      }
      return unexpected(proc, e);
    },

    create: async (modelApiKey, data, actor) => {
      const proc = `${modelApiKey}.create`;
      const r = await runtime.run(RecordService.createRecord({ modelApiKey, data }, actor));
      if (r.ok) return ok(r.value);
      const e = r.error;
      if (e instanceof AggregateValidationError || e instanceof ValidationError) return err(validationFrom(e));
      if (e instanceof DuplicateError) return err(duplicateFrom(e));
      if (e instanceof NotFoundError) {
        const drift = modelDriftFrom(proc, e);
        if (drift) return err(drift);
      }
      return unexpected(proc, e);
    },

    update: async (modelApiKey, id, data, actor) => {
      const proc = `${modelApiKey}.update`;
      const r = await runtime.run(RecordService.patchRecord(id, { modelApiKey, data }, actor));
      if (r.ok) return ok(r.value);
      const e = r.error;
      if (e instanceof NotFoundError) {
        return e.entity === "Record"
          ? err(cmsErrors.recordNotFound({ id }))
          : err(driftFrom(proc, `${e.entity} '${e.id}' not found — regenerate the client`));
      }
      if (e instanceof AggregateValidationError || e instanceof ValidationError) return err(validationFrom(e));
      if (e instanceof DuplicateError) return err(duplicateFrom(e));
      return unexpected(proc, e);
    },

    remove: async (modelApiKey, id) => {
      const proc = `${modelApiKey}.delete`;
      const r = await runtime.run(RecordService.removeRecord(modelApiKey, id));
      if (r.ok) return ok({ id });
      const e = r.error;
      if (e instanceof NotFoundError) {
        return e.entity === "Record"
          ? err(cmsErrors.recordNotFound({ id }))
          : err(driftFrom(proc, `${e.entity} '${e.id}' not found — regenerate the client`));
      }
      if (e instanceof ReferenceConflictError) return err(cmsErrors.referenceConflict({ references: [...e.references] }));
      return unexpected(proc, e);
    },

    publish: async (modelApiKey, id, actor) => {
      const proc = `${modelApiKey}.publish`;
      const r = await runtime.run(PublishService.publishRecord(modelApiKey, id, actor));
      if (r.ok) return ok(r.value);
      const e = r.error;
      if (e instanceof NotFoundError) {
        return e.entity === "Record"
          ? err(cmsErrors.recordNotFound({ id }))
          : err(driftFrom(proc, `${e.entity} '${e.id}' not found — regenerate the client`));
      }
      if (e instanceof AggregateValidationError || e instanceof ValidationError) return err(validationFrom(e));
      return unexpected(proc, e);
    },

    unpublish: async (modelApiKey, id, actor) => {
      const proc = `${modelApiKey}.unpublish`;
      const r = await runtime.run(PublishService.unpublishRecord(modelApiKey, id, actor));
      if (r.ok) return ok(r.value);
      const e = r.error;
      if (e instanceof NotFoundError) {
        return e.entity === "Record"
          ? err(cmsErrors.recordNotFound({ id }))
          : err(driftFrom(proc, `${e.entity} '${e.id}' not found — regenerate the client`));
      }
      if (e instanceof AggregateValidationError || e instanceof ValidationError) return err(validationFrom(e));
      return unexpected(proc, e);
    },

    // --- queryable list / picker / duplicate / bulk / links ---

    query: async (modelApiKey, opts) => {
      const proc = `${modelApiKey}.list`;
      const r = await runtime.run(RecordService.queryRecords(modelApiKey, opts));
      if (r.ok) return ok(r.value);
      return err(foldListDrift(proc, r.error));
    },

    search: async (modelApiKey, q, page) => {
      const proc = `${modelApiKey}.search`;
      const r = await runtime.run(RecordService.searchRecords(modelApiKey, q, page));
      if (r.ok) return ok(r.value.map(toPickerRow));
      return err(foldListDrift(proc, r.error));
    },

    duplicate: async (modelApiKey, id, actor) => {
      const proc = `${modelApiKey}.duplicate`;
      const r = await runtime.run(RecordService.duplicateRecord(modelApiKey, id, actor));
      if (r.ok) return ok(r.value);
      return err(foldNotFound(proc, id, r.error));
    },

    publishMany: async (modelApiKey, ids, actor) => {
      const r = await runtime.run(RecordService.publishRecords(modelApiKey, [...ids], actor));
      if (r.ok) return ok(r.value);
      return unexpected(`${modelApiKey}.publishMany`, r.error);
    },
    unpublishMany: async (modelApiKey, ids, actor) => {
      const r = await runtime.run(RecordService.unpublishRecords(modelApiKey, [...ids], actor));
      if (r.ok) return ok(r.value);
      return unexpected(`${modelApiKey}.unpublishMany`, r.error);
    },
    deleteMany: async (modelApiKey, ids, actor) => {
      const r = await runtime.run(RecordService.deleteRecords(modelApiKey, [...ids], actor));
      if (r.ok) return ok(r.value);
      return unexpected(`${modelApiKey}.deleteMany`, r.error);
    },

    links: async (modelApiKey, id) => {
      const proc = `${modelApiKey}.links`;
      const r = await runtime.run(RecordService.getRecordBacklinks(modelApiKey, id));
      if (r.ok) return ok(r.value);
      return err(foldNotFound(proc, id, r.error));
    },

    // --- dry-run validation + sync state ---

    validate: async (modelApiKey, data) => {
      const proc = `${modelApiKey}.validate`;
      const r = await runtime.run(RecordService.validateRecord(modelApiKey, data));
      if (r.ok) return ok(r.value);
      return err(foldValidateCreate(proc, r.error));
    },
    validateUpdate: async (modelApiKey, id, data) => {
      const proc = `${modelApiKey}.validateUpdate`;
      const r = await runtime.run(RecordService.validateRecordUpdate(modelApiKey, id, data));
      if (r.ok) return ok(r.value);
      return err(foldValidateUpdate(proc, id, r.error));
    },
    syncState: async (modelApiKey, id) => {
      const proc = `${modelApiKey}.syncState`;
      const r = await runtime.run(RecordService.getSyncState(modelApiKey, id));
      if (r.ok) return ok(r.value);
      return err(foldNotFound(proc, id, r.error));
    },

    // --- reorder ---

    reorder: async (modelApiKey, ids, actor) => {
      const proc = `${modelApiKey}.reorder`;
      const r = await runtime.run(RecordService.reorderRecords(modelApiKey, [...ids], actor));
      if (r.ok) return ok(r.value);
      return err(foldListDrift(proc, r.error));
    },

    // --- versions ---

    versionsList: async (modelApiKey, id) => {
      const proc = `${modelApiKey}.versions.list`;
      const r = await runtime.run(VersionService.listVersions(modelApiKey, id));
      if (r.ok) return ok(r.value);
      return err(foldNotFound(proc, id, r.error));
    },
    versionsGet: async (modelApiKey, id, versionId) => {
      const proc = `${modelApiKey}.versions.get`;
      const r = await runtime.run(VersionService.getVersion(versionId));
      if (r.ok) return ok(r.value);
      return err(foldNotFound(proc, id, r.error));
    },
    versionsRestore: async (modelApiKey, id, versionId, actor) => {
      const proc = `${modelApiKey}.versions.restore`;
      const restored = await runtime.run(VersionService.restoreVersion(modelApiKey, id, versionId, actor));
      if (!restored.ok) return err(foldNotFound(proc, id, restored.error));
      // The service returns the raw (un-materialized) row; re-read for a clean,
      // codec-decodable record.
      const r = await runtime.run(RecordService.getRecord(modelApiKey, id));
      if (r.ok) return ok(r.value);
      return err(foldNotFound(proc, id, r.error));
    },

    // --- schedule (return the materialized record after mutating) ---

    schedulePublish: async (modelApiKey, id, at, actor) => {
      const proc = `${modelApiKey}.schedulePublish`;
      const s = await runtime.run(ScheduleService.schedulePublish(modelApiKey, id, at, actor));
      if (!s.ok) return err(foldValidateUpdate(proc, id, s.error));
      const r = await runtime.run(RecordService.getRecord(modelApiKey, id));
      if (r.ok) return ok(r.value);
      return err(foldNotFound(proc, id, r.error));
    },
    scheduleUnpublish: async (modelApiKey, id, at, actor) => {
      const proc = `${modelApiKey}.scheduleUnpublish`;
      const s = await runtime.run(ScheduleService.scheduleUnpublish(modelApiKey, id, at, actor));
      if (!s.ok) return err(foldValidateUpdate(proc, id, s.error));
      const r = await runtime.run(RecordService.getRecord(modelApiKey, id));
      if (r.ok) return ok(r.value);
      return err(foldNotFound(proc, id, r.error));
    },
    clearSchedule: async (modelApiKey, id, actor) => {
      const proc = `${modelApiKey}.clearSchedule`;
      const s = await runtime.run(ScheduleService.clearSchedule(modelApiKey, id, actor));
      if (!s.ok) return err(foldNotFound(proc, id, s.error));
      const r = await runtime.run(RecordService.getRecord(modelApiKey, id));
      if (r.ok) return ok(r.value);
      return err(foldNotFound(proc, id, r.error));
    },

    // --- singleton variants ---

    getSingleton: async (modelApiKey) => {
      const proc = `${modelApiKey}.get`;
      const idr = await firstSingletonId(modelApiKey, proc);
      if (!idr.ok) return idr;
      const r = await runtime.run(RecordService.getRecord(modelApiKey, idr.value));
      if (r.ok) return ok(r.value);
      return err(foldNotFound(proc, idr.value, r.error));
    },
    updateSingleton: async (modelApiKey, data, actor) => {
      const proc = `${modelApiKey}.update`;
      const r = await runtime.run(RecordService.updateSingletonRecord(modelApiKey, data, actor));
      if (r.ok) return ok(r.value);
      return err(foldUpdate(proc, modelApiKey, r.error));
    },
    publishSingleton: async (modelApiKey, actor) => {
      const proc = `${modelApiKey}.publish`;
      const idr = await firstSingletonId(modelApiKey, proc);
      if (!idr.ok) return idr;
      const r = await runtime.run(PublishService.publishRecord(modelApiKey, idr.value, actor));
      if (r.ok) return ok(r.value);
      return err(foldPublish(proc, idr.value, r.error));
    },
    unpublishSingleton: async (modelApiKey, actor) => {
      const proc = `${modelApiKey}.unpublish`;
      const idr = await firstSingletonId(modelApiKey, proc);
      if (!idr.ok) return idr;
      const r = await runtime.run(PublishService.unpublishRecord(modelApiKey, idr.value, actor));
      if (r.ok) return ok(r.value);
      return err(foldPublish(proc, idr.value, r.error));
    },
    syncStateSingleton: async (modelApiKey) => {
      const proc = `${modelApiKey}.syncState`;
      const idr = await firstSingletonId(modelApiKey, proc);
      if (!idr.ok) return idr;
      const r = await runtime.run(RecordService.getSyncState(modelApiKey, idr.value));
      if (r.ok) return ok(r.value);
      return err(foldNotFound(proc, idr.value, r.error));
    },

    // --- shared assets namespace ---

    assetsList: async (opts) => {
      const r = await runtime.run(AssetService.listAssets(opts));
      if (r.ok) return ok(r.value);
      return err(foldListDrift("assets.list", r.error));
    },
    assetsGet: async (id) => {
      const r = await runtime.run(AssetService.getAsset(id));
      if (r.ok) return ok(r.value);
      return err(foldAssetNotFound("assets.get", id, r.error));
    },
    assetsCreateUploadUrl: async (input) => {
      const r = await runtime.run(createUploadUrlOp(input));
      if (r.ok) return ok(r.value);
      // Presigned uploads need R2 credentials in deps; unconfigured → incident.
      return unexpected("assets.createUploadUrl", r.error);
    },
    assetsCreate: async (data, actor) => {
      const r = await runtime.run(createAssetOp(data, actor));
      if (r.ok) return ok(r.value);
      // createAsset rejects a colliding id with a ValidationError → cms/duplicate.
      if (r.error instanceof ValidationError) return err(duplicateFrom(new DuplicateError({ message: r.error.message })));
      return unexpected("assets.create", r.error);
    },
    assetsImportFromUrl: async (data, actor) => {
      const r = await runtime.run(importAssetOp(data, actor));
      if (r.ok) return ok(r.value);
      // Import needs an R2 bucket in deps; unconfigured / fetch failures → incident.
      return unexpected("assets.importFromUrl", r.error);
    },
    assetsUpdate: async (id, metadata, actor) => {
      const r = await runtime.run(AssetService.updateAssetMetadata(id, metadata, actor));
      if (r.ok) return ok(r.value);
      return err(foldAssetNotFound("assets.update", id, r.error));
    },
    assetsReplace: async (id, data, actor) => {
      const r = await runtime.run(replaceAssetOp(id, data, actor));
      if (r.ok) return ok(r.value);
      return err(foldAssetNotFound("assets.replace", id, r.error));
    },
    assetsDelete: async (id, force) => {
      const r = await runtime.run(AssetService.deleteAsset(id, force));
      if (r.ok) return ok({ deleted: true });
      const e = r.error;
      if (e instanceof NotFoundError && e.entity === "Asset") return err(cmsErrors.recordNotFound({ id }));
      if (e instanceof ReferenceConflictError) return err(cmsErrors.referenceConflict({ references: [...e.references] }));
      return unexpected("assets.delete", e);
    },
    assetsUsages: async (id) => {
      const r = await runtime.run(AssetService.getAssetUsages(id));
      if (r.ok) return ok(r.value);
      return err(foldAssetNotFound("assets.usages", id, r.error));
    },
  };

  /** Resolve the sole row id of a singleton model (or recordNotFound / drift). */
  async function firstSingletonId(modelApiKey: string, proc: string): Promise<Result<string, RecordNotFound | SchemaDrift>> {
    const r = await runtime.run(RecordService.listRecords(modelApiKey));
    if (!r.ok) return err(foldNotFound(proc, modelApiKey, r.error));
    const rows = r.value;
    if (!Array.isArray(rows) || rows.length === 0) return err(cmsErrors.recordNotFound({ id: modelApiKey }));
    return ok(readRowId(rows[0]));
  }
}

// --- host wiring (BYO-auth + editor attribution) ---

/**
 * Deps the generated `cmsProcedures` factory takes:
 * - a SqlClient layer or a D1 binding (runs the services in-process),
 * - `actor`: maps the host's request context to the editor recorded in
 *   `_created_by`/`_updated_by`/`_published_by`,
 * - `mutationMiddleware`: the host's own auth middleware, applied to every
 *   CMS mutation. Its errors (`MErrors`, e.g. `Unauthorized`) must already be
 *   declared on the contract via `cmsContract(app, { mutationErrors })` —
 *   result-rpc is contract-first, so an undeclared middleware error is
 *   rejected. Reads carry no auth (BYO-auth: the host owns it, ticket 07).
 */
export type CmsProceduresDeps<C, MErrors extends ErrorDefinitionMap> = CmsRuntimeDeps & {
  readonly actor?: (context: C) => RequestActor | null;
  readonly mutationMiddleware?: Middleware<C, C, MErrors>;
};

export type { CmsRuntimeDeps, RequestActor } from "agent-cms/lib";
