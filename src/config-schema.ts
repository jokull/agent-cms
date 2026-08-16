import { Cause, Option, Schema, SchemaIssue } from "effect";
import type { AiBinding, VectorizeBinding } from "./search/vectorize.js";
import type { CmsBindings } from "./index.js";

const RuntimeObject = Schema.Unknown.pipe(
  Schema.refine(
    (value): value is object => typeof value === "object" && value !== null,
    { message: "Expected runtime binding object" },
  ),
);

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
  db: RuntimeObject,
  assets: Schema.optional(RuntimeObject),
  environment: Schema.optional(Schema.Literals(["production", "development"])),
  assetBaseUrl: Schema.optional(AssetBaseUrl),
  writeKey: OptionalNonEmptyString,
  ai: Schema.optional(RuntimeObject),
  vectorize: Schema.optional(RuntimeObject),
  r2AccessKeyId: OptionalNonEmptyString,
  r2SecretAccessKey: OptionalNonEmptyString,
  r2BucketName: OptionalNonEmptyString,
  cfAccountId: OptionalNonEmptyString,
  siteUrl: Schema.optional(Schema.String),
  loader: Schema.optional(RuntimeObject),
}).pipe(
  Schema.check(
    Schema.makeFilter((bindings) => {
      const hasAi = bindings.ai !== undefined;
      const hasVectorize = bindings.vectorize !== undefined;
      return hasAi === hasVectorize;
    }, { message: "ai and vectorize bindings must be configured together" }),
  ),
  Schema.check(
    Schema.makeFilter((bindings) => {
      const r2Fields = [
        bindings.r2AccessKeyId,
        bindings.r2SecretAccessKey,
        bindings.r2BucketName,
        bindings.cfAccountId,
      ];
      const presentCount = r2Fields.filter((value) => value !== undefined).length;
      return presentCount === 0 || presentCount === r2Fields.length;
    }, {
      message: "R2 credentials must include r2AccessKeyId, r2SecretAccessKey, r2BucketName, and cfAccountId together",
    }),
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
  r2Credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    bucketName: string;
    accountId: string;
  };
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
    // SAFETY: RawCmsBindingsSchema validated each binding as a non-null runtime
    // object; the concrete interface shapes are guaranteed by the host's
    // CmsBindings input typing (D1Database/R2Bucket/AiBinding/VectorizeBinding).
    db: bindings.db as D1Database,
    // SAFETY: same RawCmsBindingsSchema guarantee for the R2 bucket binding.
    assets: bindings.assets as R2Bucket | undefined,
    environment: bindings.environment,
    assetBaseUrl: bindings.assetBaseUrl,
    writeKey: bindings.writeKey,
    // SAFETY: same RawCmsBindingsSchema guarantee for the Ai binding.
    ai: bindings.ai as AiBinding | undefined,
    // SAFETY: same RawCmsBindingsSchema guarantee for the Vectorize binding.
    vectorize: bindings.vectorize as VectorizeBinding | undefined,
    r2Credentials: bindings.r2AccessKeyId
      ? {
          accessKeyId: bindings.r2AccessKeyId,
          secretAccessKey: bindings.r2SecretAccessKey!,
          bucketName: bindings.r2BucketName!,
          accountId: bindings.cfAccountId!,
        }
      : undefined,
    siteUrl: bindings.siteUrl,
    loader: bindings.loader,
  };
}
