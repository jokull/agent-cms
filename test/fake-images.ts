/**
 * Shared test fake for the Cloudflare Images binding (`ImagesBinding`).
 *
 * The repo's structural binding types mirror workers-types >= 5.20260902.1;
 * unit tests never touch a real Cloudflare account, so handlers are exercised
 * against this in-memory fake: `createDirectUpload` mints deterministic
 * upload URLs on the fake delivery host, `upload` stores bytes in a map,
 * per-image handles answer details/delete, and every call is recorded for
 * assertions.
 */
import type {
  ImagesBinding,
  ImagesDirectUploadOptions,
  ImagesImageMetadata,
  ImagesUploadOptions,
} from "../src/images-binding.js";

export interface FakeImagesCallLog {
  readonly createDirectUploads: ImagesDirectUploadOptions[];
  readonly uploads: Array<{ bytes: Uint8Array; options?: ImagesUploadOptions }>;
  readonly deletes: string[];
  /** imageId -> bytes stored by upload() */
  readonly stored: Map<string, Uint8Array>;
}

export interface FakeImagesOptions {
  readonly accountHash?: string;
  readonly id?: string;
  readonly metadata?: ImagesImageMetadata;
}

const IMAGE_HOST = "imagedelivery.net";
const UPLOAD_HOST = "upload.imagedelivery.net";

export function fakeImagesBinding(opts?: FakeImagesOptions): { binding: ImagesBinding; log: FakeImagesCallLog } {
  const accountHash = opts?.accountHash ?? "testaccounthash";
  const log: FakeImagesCallLog = {
    createDirectUploads: [],
    uploads: [],
    deletes: [],
    stored: new Map(),
  };

  const uploadedMeta = (id: string, options?: ImagesUploadOptions): ImagesImageMetadata => {
    const base = `https://${IMAGE_HOST}/${accountHash}/${id}`;
    return {
      id,
      filename: options?.filename,
      uploaded: new Date().toISOString(),
      requireSignedURLs: options?.requireSignedURLs ?? false,
      meta: options?.metadata,
      creator: options?.creator,
      variants: [`${base}/public`, `${base}/thumbnail`],
    };
  };

  const handle = (id: string): ImagesBinding["hosted"]["image"] extends (i: string) => infer H ? H : never => ({
    details: async () => log.stored.has(id) ? uploadedMeta(id) : null,
    bytes: async () => {
      const bytes = log.stored.get(id);
      if (!bytes) return null;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    signedUrl: async () => `https://${IMAGE_HOST}/${accountHash}/${id}/public?sign=test`,
    update: async () => uploadedMeta(id),
    delete: async () => {
      log.deletes.push(id);
      if (!log.stored.has(id)) return false;
      log.stored.delete(id);
      return true;
    },
  });

  const binding: ImagesBinding = {
    hosted: {
      image: handle,
      upload: async (image, options) => {
        const id = options?.id ?? opts?.id ?? `img-${log.uploads.length + 1}`;
        const bytes = image instanceof Uint8Array
          ? image
          : image instanceof ArrayBuffer
            ? new Uint8Array(image)
            : new Uint8Array(0);
        log.stored.set(id, bytes);
        log.uploads.push({ bytes, options });
        return uploadedMeta(id, options);
      },
      list: async () => ({ images: [], listComplete: true }),
      createDirectUpload: async (options) => {
        log.createDirectUploads.push(options ?? {});
        const id = options?.id ?? `img-${log.createDirectUploads.length}`;
        return {
          id,
          uploadURL: `https://${UPLOAD_HOST}/${accountHash}/${id}`,
        };
      },
    },
  };

  return { binding, log };
}
