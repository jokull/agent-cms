import { Cause, Data, Option, Predicate, Schema, SchemaIssue } from "effect";
import { isObjectRecord } from "./dynamic/row-types.js";
import type { AiBinding, VectorizeBinding } from "./search/vectorize.js";
import type { ImagesBinding } from "./images-binding.js";
import type { CmsBindings } from "./index.js";

// ---------------------------------------------------------------------------
// Binding validation pattern — borrowed from danieljvdm/effect-cf (MIT):
//   https://github.com/danieljvdm/effect-cf/blob/1b32c5475/packages/effect-cf/src/Binding.ts
// The schema below validates structure + cross-field invariants; per-binding
// guards then verify the binding objects expose the methods the CMS actually
// calls, so the decoded values need no `as` casts (the guard narrows).
// ---------------------------------------------------------------------------

/** Error raised when a binding is present but does not match the expected shape. */
export class BindingValidationError extends Data.TaggedError("BindingValidationError")<{
  readonly binding: string;
  readonly expected: string;
  readonly actual: string;
  readonly message: string;
}> {}

type BindingCandidate = Parameters<typeof Predicate.isUnknown>[0];

const isPropertyTarget = (value: BindingCandidate): value is { readonly constructor?: Function } =>
  Predicate.isObjectOrArray(value) || Predicate.isFunction(value);

const getObjectName = (value: { readonly constructor?: Function }): string => {
  const tag = Object.prototype.toString.call(value).slice("[object ".length, -1);
  const constructorName = "constructor" in value &&
    Predicate.isFunction(value.constructor) &&
    Predicate.isString(value.constructor.name)
    ? value.constructor.name
    : undefined;

  if (tag !== "Object") return tag;
  if (constructorName !== undefined && constructorName !== "" && constructorName !== "Object") {
    return constructorName;
  }
  return tag;
};

const propertyNames = (value: { readonly constructor?: Function }): ReadonlyArray<string> => {
  const names = new Set<string>();
  for (const target of [value, Object.getPrototypeOf(value)] as const) {
    if (target === null || target === Object.prototype || target === Function.prototype) continue;
    for (const name of Object.getOwnPropertyNames(target)) names.add(name);
  }
  return [...names].filter((name) => name !== "constructor").sort();
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- binding error reporting: describes an arbitrary candidate value; the reader is the error path.
const describeActual = (value: BindingCandidate): string => {
  if (value === null) return "null";
  if (Predicate.isString(value)) return "string";
  if (Predicate.isNumber(value)) return "number";
  if (Predicate.isBoolean(value)) return "boolean";
  if (Predicate.isBigInt(value)) return "bigint";
  if (Predicate.isSymbol(value)) return "symbol";
  if (!isPropertyTarget(value)) return "undefined";

  const names = propertyNames(value);
  const methods = names.filter((name) => {
    try {
      return Predicate.hasProperty(value, name) && Predicate.isFunction(value[name]);
    } catch {
      return false;
    }
  });
  const properties = names.filter((name) => !methods.includes(name));
  const details = [
    methods.length > 0 ? `methods ${methods.join(", ")}` : undefined,
    properties.length > 0 ? `properties ${properties.join(", ")}` : undefined,
  ].filter((detail) => detail !== undefined);

  if (details.length === 0) return getObjectName(value);
  return `${getObjectName(value)} with ${details.join("; ")}`;
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- binding boundary parser: duck-checks a Cloudflare binding object against the D1 surface the CMS calls (prepare/batch via @effect/sql-d1).
function isD1Database(value: unknown): value is D1Database {
  return isObjectRecord(value)
    && Predicate.isFunction(value.prepare)
    && Predicate.isFunction(value.batch);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- binding boundary parser: duck-checks an R2 bucket against the surface the CMS calls (get/put for asset serving and uploads).
function isR2Bucket(value: unknown): value is R2Bucket {
  return isObjectRecord(value)
    && Predicate.isFunction(value.get)
    && Predicate.isFunction(value.put);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- binding boundary parser: duck-checks a Workers AI binding against the surface the CMS calls (run for embeddings).
function isAiBinding(value: unknown): value is AiBinding {
  return isObjectRecord(value) && Predicate.isFunction(value.run);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- binding boundary parser: duck-checks a Vectorize index against the surface the CMS calls (upsert/query/deleteByIds for semantic search).
function isVectorizeBinding(value: unknown): value is VectorizeBinding {
  return isObjectRecord(value)
    && Predicate.isFunction(value.upsert)
    && Predicate.isFunction(value.query)
    && Predicate.isFunction(value.deleteByIds);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- binding boundary parser: duck-checks a Cloudflare Images binding against the surface the CMS calls (hosted.createDirectUpload/upload for direct image uploads and server-side ingest).
function isImagesBinding(value: unknown): value is ImagesBinding {
  return isObjectRecord(value)
    && isObjectRecord(value.hosted)
    && Predicate.isFunction(value.hosted.createDirectUpload)
    && Predicate.isFunction(value.hosted.upload);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- binding boundary parser: accepts the raw binding candidate and narrows it via the guard; failure produces the descriptive BindingValidationError.
function getBinding<T>(
  binding: string,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- raw binding candidate entering the boundary parser.
  value: unknown,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- guard closure over the same raw candidate.
  isResource: (value: unknown) => value is T,
  expected: string,
): T {
  if (!isResource(value)) {
    const actual = describeActual(value);
    throw new BindingValidationError({
      binding,
      expected,
      actual,
      message: `Cloudflare binding "${binding}" failed validation. Expected ${expected}; got ${actual}`,
    });
  }
  return value;
}

const OptionalNonEmptyString = Schema.optional(Schema.NonEmptyString);

const AssetBaseUrl = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value: string) => Schema.decodeUnknownOption(Schema.URLFromString)(value)._tag === "Some",
      { message: "assetBaseUrl must be a valid URL" },
    ),
  ),
);

const RawCmsBindingsSchema = Schema.Struct({
  db: Schema.Unknown,
  assets: Schema.optional(Schema.Unknown),
  environment: Schema.optional(Schema.Literals(["production", "development"])),
  assetBaseUrl: Schema.optional(AssetBaseUrl),
  writeKey: OptionalNonEmptyString,
  ai: Schema.optional(Schema.Unknown),
  vectorize: Schema.optional(Schema.Unknown),
  images: Schema.optional(Schema.Unknown),
  siteUrl: Schema.optional(Schema.String),
  loader: Schema.optional(Schema.Unknown),
}).pipe(
  Schema.check(
    Schema.makeFilter((bindings) => {
      const hasAi = bindings.ai !== undefined;
      const hasVectorize = bindings.vectorize !== undefined;
      return hasAi === hasVectorize;
    }, { message: "ai and vectorize bindings must be configured together" }),
  ),
);

export interface DecodedCmsBindings {
  db: D1Database;
  assets?: R2Bucket;
  environment?: "production" | "development";
  assetBaseUrl?: string;
  writeKey?: string;
  ai?: AiBinding;
  vectorize?: VectorizeBinding;
  /** Cloudflare Images binding — enables hosted image assets and keyless direct uploads */
  images?: ImagesBinding;
  siteUrl?: string;
  loader?: unknown;
}

function formatConfigParseError(error: Schema.SchemaError): string {
  return SchemaIssue.makeFormatterDefault()(error.issue);
}

export function decodeCmsBindings(input: CmsBindings): DecodedCmsBindings {
  const decoded = Schema.decodeUnknownExit(RawCmsBindingsSchema)(input);
  if (decoded._tag === "Failure") {
    const error = Cause.findErrorOption(decoded.cause).pipe(Option.getOrThrow);
    throw new Error(`Invalid CMS bindings: ${formatConfigParseError(error)}`);
  }
  const bindings = decoded.value;
  return {
    db: getBinding("db", bindings.db, isD1Database, "D1 database binding with prepare() and batch()"),
    assets: bindings.assets === undefined
      ? undefined
      : getBinding("assets", bindings.assets, isR2Bucket, "R2 bucket binding with get() and put()"),
    environment: bindings.environment,
    assetBaseUrl: bindings.assetBaseUrl,
    writeKey: bindings.writeKey,
    ai: bindings.ai === undefined
      ? undefined
      : getBinding("ai", bindings.ai, isAiBinding, "Workers AI binding with run()"),
    vectorize: bindings.vectorize === undefined
      ? undefined
      : getBinding("vectorize", bindings.vectorize, isVectorizeBinding, "Vectorize index binding with upsert(), query(), and deleteByIds()"),
    images: bindings.images === undefined
      ? undefined
      : getBinding("images", bindings.images, isImagesBinding, "Cloudflare Images binding with hosted.createDirectUpload() and hosted.upload()"),
    siteUrl: bindings.siteUrl,
    loader: bindings.loader,
  };
}
