/**
 * Cloudflare Images binding — minimal structural surface agent-cms uses.
 *
 * The CMS stores image assets in Cloudflare Images (managed via the `images`
 * binding on the Worker) instead of R2, so client uploads can go direct to
 * Cloudflare through a binding-minted one-time URL — no S3-compatible signing
 * credentials are held anywhere (see createDirectUpload below).
 *
 * The ambient `@cloudflare/workers-types` snapshot this repo pins (2023-07-01)
 * predates the binding methods added in 2026-09-02, so — following the
 * AiBinding/VectorizeBinding precedent in `./search/vectorize.ts` — these are
 * repo-owned structural types, shape-compatible with the real binding
 * (`env.IMAGES.hosted`, as declared by workers-types >= 5.20260902.1), no cast
 * needed. Non-image files continue to live in the R2 bucket binding.
 */
export interface ImagesImageMetadata {
  readonly id: string;
  readonly filename?: string;
  readonly uploaded?: string;
  readonly requireSignedURLs: boolean;
  /** Arbitrary metadata stored alongside the image (never shared with end users). */
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Cloudflare Images contract: metadata values are arbitrary JSON (mirrors workers-types ImageMetadata.meta / upload options).
  readonly meta?: Record<string, unknown>;
  /** Full delivery URLs, one per configured variant (imagedelivery.net). */
  readonly variants: string[];
  /** Present and true until the creator actually uploads the image. */
  readonly draft?: boolean;
  readonly creator?: string;
}

export interface ImagesDirectUploadOptions {
  /** Custom ID for the image. Images uploaded with a custom ID cannot later
   *  require signed URLs (`requireSignedURLs: true`) — agent-cms never sets a
   *  custom ID so private/signed delivery stays available. */
  readonly id?: string;
  readonly requireSignedURLs?: boolean;
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Cloudflare Images contract: metadata values are arbitrary JSON (mirrors workers-types ImageMetadata.meta / upload options).
  readonly metadata?: Record<string, unknown>;
  readonly creator?: string;
  /** How long the upload URL stays valid, in seconds (120–21600; default 1800). */
  readonly expiresIn?: number;
}

export interface ImagesDirectUploadResult {
  /** The ID the uploaded image will have. Known before the client uploads. */
  readonly id: string;
  /** One-time URL the client uploads the image bytes to (multipart form POST, field `file`). */
  readonly uploadURL: string;
}

export interface ImagesUploadOptions {
  readonly id?: string;
  readonly filename?: string;
  readonly requireSignedURLs?: boolean;
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Cloudflare Images contract: metadata values are arbitrary JSON (mirrors workers-types ImageMetadata.meta / upload options).
  readonly metadata?: Record<string, unknown>;
  readonly creator?: string;
  readonly encoding?: "base64";
}

export interface ImagesSignedUrlOptions {
  readonly variant: string;
  readonly expiresIn?: number;
  readonly keyName?: string;
}

export interface ImagesImageHandle {
  /** Get metadata for a hosted image; null if no image with the ID exists. */
  details(): Promise<ImagesImageMetadata | null>;
  /** Stream the original uploaded bytes; null if the image does not exist. */
  bytes(): Promise<ReadableStream<Uint8Array> | null>;
  /** Signed delivery URL for an image that requires signed URLs. */
  signedUrl(options: ImagesSignedUrlOptions): Promise<string>;
  update(options: {
    readonly requireSignedURLs?: boolean;
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Cloudflare Images contract: metadata values are arbitrary JSON (mirrors workers-types ImageMetadata.meta / upload options).
    readonly metadata?: Record<string, unknown>;
    readonly creator?: string;
  }): Promise<ImagesImageMetadata>;
  /** True if deleted; false if no image with the ID existed. */
  delete(): Promise<boolean>;
}

export interface ImagesHostedBinding {
  /** A cheap handle for per-image operations (no network until a method is called). */
  image(imageId: string): ImagesImageHandle;
  /** Upload bytes server-side into Images storage. */
  upload(
    image: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array,
    options?: ImagesUploadOptions,
  ): Promise<ImagesImageMetadata>;
  list(options?: {
    readonly limit?: number;
    readonly cursor?: string;
    readonly sortOrder?: "asc" | "desc";
    readonly creator?: string;
  }): Promise<{ readonly images: ImagesImageMetadata[]; readonly cursor?: string; readonly listComplete: boolean }>;
  /** Mint a one-time Direct Creator Upload URL (keyless, binding-scoped). */
  createDirectUpload(options?: ImagesDirectUploadOptions): Promise<ImagesDirectUploadResult>;
}

/** The `env.IMAGES` binding shape agent-cms consumes. */
export interface ImagesBinding {
  readonly hosted: ImagesHostedBinding;
}
