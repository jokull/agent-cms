import { mkdir, readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";

function parseCompatibilityDate(configText) {
  const match = configText.match(/"compatibility_date"\s*:\s*"([^"]+)"/);
  return match?.[1] ?? "2024-12-01";
}

function parseCompatibilityFlags(configText) {
  const match = configText.match(/"compatibility_flags"\s*:\s*\[(.*?)\]/s);
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function toPlainUint8Array(value) {
  if (value instanceof Uint8Array) {
    return Uint8Array.from(value);
  }
  return new Uint8Array(value);
}

export function createLocalR2Client({
  persistDir,
  wranglerConfigPath,
  bucketBindingName = "ASSETS",
}) {
  let localR2ContextPromise;
  let cleanupRegistered = false;

  async function getBucket() {
    const context = await getContext();
    return context.bucket;
  }

  async function putObject(r2Key, buffer, contentType = "application/octet-stream") {
    const bucket = await getBucket();
    const bytes = toPlainUint8Array(buffer);
    await bucket.put(r2Key, bytes, {
      httpMetadata: {
        contentType,
      },
    });
  }

  async function headObject(r2Key) {
    const bucket = await getBucket();
    return bucket.head(r2Key);
  }

  async function dispose() {
    if (!localR2ContextPromise) return;
    const context = await localR2ContextPromise.catch(() => null);
    localR2ContextPromise = undefined;
    if (!context?.mf) return;
    await context.mf.dispose();
  }

  async function getContext() {
    localR2ContextPromise ??= createContext();
    return localR2ContextPromise;
  }

  async function createContext() {
    registerCleanup();
    await mkdir(persistDir, { recursive: true });
    const wranglerConfig = await readFile(wranglerConfigPath, "utf8");
    const workerScript = "export default { async fetch() { return new Response('ok') } };";
    const mf = new Miniflare({
      modules: true,
      script: workerScript,
      compatibilityDate: parseCompatibilityDate(wranglerConfig),
      compatibilityFlags: parseCompatibilityFlags(wranglerConfig),
      r2Buckets: [bucketBindingName],
      r2Persist: persistDir,
    });
    const bucket = await mf.getR2Bucket(bucketBindingName);
    return { mf, bucket };
  }

  function registerCleanup() {
    if (cleanupRegistered) return;
    cleanupRegistered = true;

    const cleanup = async () => {
      await dispose();
    };

    process.once("beforeExit", () => {
      void cleanup();
    });

    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => {
        void cleanup().finally(() => process.exit(0));
      });
    }
  }

  return {
    putObject,
    headObject,
    dispose,
  };
}
