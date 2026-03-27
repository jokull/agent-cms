import { ParseResult, Schema } from "effect";
import type { AiBinding, VectorizeBinding } from "./search/vectorize.js";

const RuntimeObject = Schema.Unknown.pipe(
  Schema.filter(
    (value): value is object => typeof value === "object" && value !== null,
    { message: () => "Expected runtime binding object" },
  ),
);

const OptionalNonEmptyString = Schema.optional(Schema.NonEmptyTrimmedString);

const AssetBaseUrl = Schema.String.pipe(
  Schema.filter((value) => {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }, { message: () => "assetBaseUrl must be a valid URL" }),
);

const RawCmsBindingsSchema = Schema.Struct({
  db: RuntimeObject,
  assets: Schema.optional(RuntimeObject),
  environment: Schema.optional(Schema.Literal("production", "development")),
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
  Schema.filter((bindings) => {
    const hasAi = bindings.ai !== undefined;
    const hasVectorize = bindings.vectorize !== undefined;
    return hasAi === hasVectorize;
  }, { message: () => "ai and vectorize bindings must be configured together" }),
  Schema.filter((bindings) => {
    const r2Fields = [
      bindings.r2AccessKeyId,
      bindings.r2SecretAccessKey,
      bindings.r2BucketName,
      bindings.cfAccountId,
    ];
    const presentCount = r2Fields.filter((value) => value !== undefined).length;
    return presentCount === 0 || presentCount === r2Fields.length;
  }, {
    message: () => "R2 credentials must include r2AccessKeyId, r2SecretAccessKey, r2BucketName, and cfAccountId together",
  }),
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

function formatConfigParseError(error: ParseResult.ParseError): string {
  return ParseResult.ArrayFormatter.formatErrorSync(error)
    .map((issue) => issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message)
    .join("; ");
}

export function decodeCmsBindings(input: unknown): DecodedCmsBindings {
  const decoded = Schema.decodeUnknownEither(RawCmsBindingsSchema)(input);
  if (decoded._tag === "Left") {
    throw new Error(`Invalid CMS bindings: ${formatConfigParseError(decoded.left)}`);
  }

  const bindings = decoded.right;
  return {
    db: bindings.db as D1Database,
    assets: bindings.assets as R2Bucket | undefined,
    environment: bindings.environment,
    assetBaseUrl: bindings.assetBaseUrl,
    writeKey: bindings.writeKey,
    ai: bindings.ai as AiBinding | undefined,
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
