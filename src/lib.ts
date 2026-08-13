/**
 * Minimal library entry for embedding agent-cms's content services in a host
 * process (see @agent-cms/codegen). The Worker entry (`src/index.ts`) exposes
 * a fetch handler; this exposes the record/publish services, the layer that
 * satisfies them, and a runner that hides Effect from callers.
 *
 * Deliberately small — it does NOT re-export the whole service surface, only
 * what the generated in-process RPC procedures call.
 */
import { Effect, Either, Layer, ManagedRuntime, Option, Schema } from "effect";
import { SqlClient } from "@effect/sql";
import { D1Client } from "@effect/sql-d1";
import { VectorizeContext } from "./search/vectorize-context.js";
import { HooksContext } from "./hooks.js";
import {
  AssetImportContext,
  AssetUrlContext,
  createAsset,
  replaceAsset,
  importAssetFromUrl,
  createAssetUploadUrl,
} from "./services/asset-service.js";
import { CreateAssetInput, ImportAssetFromUrlInput, CreateUploadUrlInput } from "./services/input-schemas.js";
import type { R2UploadCredentials } from "./services/asset-service.js";
import type { RequestActor } from "./attribution.js";

export * as RecordService from "./services/record-service.js";
export * as PublishService from "./services/publish-service.js";
export * as VersionService from "./services/version-service.js";
export * as ScheduleService from "./services/schedule-service.js";
export * as AssetService from "./services/asset-service.js";
export * as SchemaIO from "./services/schema-io.js";

export {
  NotFoundError,
  ValidationError,
  AggregateValidationError,
  DuplicateError,
  ReferenceConflictError,
  SchemaEngineError,
} from "./errors.js";
export type { ValidationIssue, ValidationIssueCode } from "./errors.js";
export type { RequestActor } from "./attribution.js";
export type { CreateRecordInput, PatchRecordInput } from "./services/input-schemas.js";
export type {
  QueryRecordsOptions,
  PickerSearchRow,
  PickerSearchPage,
  BulkOpResult,
  RecordBacklink,
  RecordSyncState,
} from "./services/record-service.js";
export type { AssetRow } from "./db/row-types.js";
export type {
  ListAssetsOptions,
  AssetUsage,
  R2UploadCredentials,
} from "./services/asset-service.js";
export { ensureSchema } from "./migrations.js";

/**
 * Asset write ops take Effect-Schema-validated inputs (`CreateAssetInput` etc.).
 * The generated procedures hand us plain decoded wire objects, so these thin
 * wrappers re-validate through the same schemas the REST layer uses (applying
 * defaults like `tags: []`) before delegating — keeping the codegen artifact
 * free of any Effect/Schema import. A decode failure is a genuine defect (the
 * wire codec already gate-kept the shape), so it propagates as an incident.
 */
export function createAssetOp(raw: unknown, actor?: RequestActor | null) {
  return Schema.decodeUnknown(CreateAssetInput)(raw).pipe(
    Effect.flatMap((input) => createAsset(input, actor)),
  );
}
export function replaceAssetOp(id: string, raw: unknown, actor?: RequestActor | null) {
  return Schema.decodeUnknown(CreateAssetInput)(raw).pipe(
    Effect.flatMap((input) => replaceAsset(id, input, actor)),
  );
}
export function importAssetOp(raw: unknown, actor?: RequestActor | null) {
  return Schema.decodeUnknown(ImportAssetFromUrlInput)(raw).pipe(
    Effect.flatMap((input) => importAssetFromUrl(input, actor)),
  );
}
export function createUploadUrlOp(raw: unknown) {
  return Schema.decodeUnknown(CreateUploadUrlInput)(raw).pipe(
    Effect.flatMap((input) => createAssetUploadUrl(input)),
  );
}

/**
 * The context every content service closes over. A host builds this once from
 * its bindings and hands it to `makeCmsRuntime`.
 */
export type CmsServices =
  | SqlClient.SqlClient
  | VectorizeContext
  | HooksContext
  | AssetImportContext
  | AssetUrlContext;

/** A pre-built SqlClient layer (D1 in production, SQLite in tests). */
export type CmsSqlLayer = Layer.Layer<SqlClient.SqlClient>;

/** Re-exported so hosts can type `{ DB }` without pulling in Cloudflare types. */
export type CmsD1Database = D1Database;

/** Re-exported so hosts can type `{ assets: { r2Bucket } }` without Cloudflare types. */
export type CmsR2Bucket = R2Bucket;

/**
 * Optional asset-storage config a host supplies so the upload/import procedures
 * (`assets.createUploadUrl`, `assets.importFromUrl`) work in-process:
 * - `r2Bucket` — an R2 binding, required by `importFromUrl` (server-side fetch
 *   → R2 put). Absent → the op fails as an incident (`server/internal`).
 * - `r2Credentials` — access keys, required by `createUploadUrl` (presigned S3
 *   PUT). Absent → the op fails as an incident.
 * The rest of the surface (records + asset CRUD metadata) needs neither.
 */
export interface CmsAssetConfig {
  readonly r2Bucket?: CmsR2Bucket;
  readonly r2Credentials?: R2UploadCredentials;
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Public asset base (`ASSET_BASE_URL`) — a bucket/CDN host serving R2 objects
   * at their key path. Every asset row and every media value read through this
   * runtime carries `<baseUrl>/<r2_key>` as its `url`.
   */
  readonly baseUrl?: string;
  /**
   * Fallback origin used when `baseUrl` is absent: asset URLs become
   * `<origin>/assets/<id>/<filename>`, the route the CMS Worker serves from R2.
   * With neither set, URLs are the same-origin relative path.
   */
  readonly originUrl?: string;
}

/**
 * Wrap a bare SqlClient layer with the auxiliary contexts the services need.
 * Vectorize/hooks default to `none`. Asset import binds the host's R2 config
 * when supplied (else the two R2-backed ops fail as incidents). A host wanting
 * search or hooks should mount the full CMS Worker instead — this path is for
 * typed reads/writes, not the whole platform.
 */
export function cmsRuntimeLayer(sqlLayer: CmsSqlLayer, assets?: CmsAssetConfig): Layer.Layer<CmsServices> {
  return Layer.mergeAll(
    sqlLayer,
    Layer.succeed(VectorizeContext, Option.none()),
    Layer.succeed(HooksContext, Option.none()),
    Layer.succeed(AssetImportContext, {
      r2Bucket: assets?.r2Bucket,
      r2Credentials: assets?.r2Credentials,
      fetch: assets?.fetch ?? globalThis.fetch,
    }),
    Layer.succeed(AssetUrlContext, {
      current: () => ({ baseUrl: assets?.baseUrl, origin: assets?.originUrl }),
    }),
  );
}

/**
 * Deps for `makeCmsRuntime`: an existing SqlClient layer, or a raw D1 binding,
 * plus optional asset-storage config (`assets`) for the R2-backed procedures.
 */
export type CmsRuntimeDeps = ({ readonly layer: CmsSqlLayer } | { readonly DB: CmsD1Database }) & {
  readonly assets?: CmsAssetConfig;
};

/** Plain (Effect-free) outcome of running a service effect. */
export type CmsRunResult<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: unknown };

/**
 * A long-lived runtime the generated procedures share. `run` executes a
 * service effect and returns a plain tagged result — the tagged domain error
 * lands in `error` (never thrown), while genuine defects reject the promise so
 * result-rpc can sanitize them to `server/internal`.
 */
export interface CmsRuntime {
  run<A>(effect: Effect.Effect<A, unknown, CmsServices>): Promise<CmsRunResult<A>>;
}

export function makeCmsRuntime(deps: CmsRuntimeDeps): CmsRuntime {
  const sqlLayer: CmsSqlLayer =
    "DB" in deps ? D1Client.layer({ db: deps.DB }).pipe(Layer.orDie) : deps.layer;
  const runtime = ManagedRuntime.make(cmsRuntimeLayer(sqlLayer, deps.assets));
  return {
    run: (effect) =>
      runtime.runPromise(Effect.either(effect)).then((either) =>
        Either.isRight(either)
          ? { ok: true, value: either.right }
          : { ok: false, error: either.left },
      ),
  };
}
