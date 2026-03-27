import { resolve, relative } from "node:path";

import { createDatoClient } from "./datocms.mjs";
import { fetchDatoSchemaMetadata } from "./dato-schema-metadata.mjs";
import { ensureOutDir, writeJson, writeJsonFile } from "./runtime.mjs";
import { generateSchema } from "./schema-codegen.mjs";

const DEFAULT_ITEM_CHUNK_SIZE = 300;
const DEFAULT_UPLOAD_CHUNK_SIZE = 1000;
const DEFAULT_ITEM_PAGE_CONCURRENCY = 8;
const DEFAULT_UPLOAD_PAGE_CONCURRENCY = 4;
const NESTED_ITEM_PAGE_LIMIT = 30;
const UPLOAD_PAGE_LIMIT = 500;

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function chunkArray(items, chunkSize) {
  const chunks = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function getItemTotalCount(body) {
  const total = body?.meta?.total_count;
  return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

export async function exportDatoEnvironment({
  token,
  outDir = resolve(process.cwd(), "scripts/dato-import/out"),
  filename = "dato-export.json",
  itemChunkSize = DEFAULT_ITEM_CHUNK_SIZE,
  uploadChunkSize = DEFAULT_UPLOAD_CHUNK_SIZE,
  itemPageConcurrency = DEFAULT_ITEM_PAGE_CONCURRENCY,
  uploadPageConcurrency = DEFAULT_UPLOAD_PAGE_CONCURRENCY,
}) {
  const dato = createDatoClient({ token });
  await ensureOutDir(outDir);

  const site = await dato.getSite();
  const schema = await generateSchema(dato);
  const { itemTypes, itemTypeIdToApiKey, fieldMap } = await fetchDatoSchemaMetadata(dato);
  const serializedFieldMap = Object.fromEntries(fieldMap);
  const itemCountProbe = await dato.cmaRequest("/items", {
    nested: true,
    version: "current",
    "page[limit]": 1,
    "page[offset]": 0,
  });
  const uploadCountProbe = await dato.cmaRequest("/uploads", {
    "page[limit]": 1,
    "page[offset]": 0,
  });

  const totalItems = getItemTotalCount(itemCountProbe);
  const totalUploads = getItemTotalCount(uploadCountProbe);
  const itemOffsets = Array.from(
    { length: Math.ceil(totalItems / NESTED_ITEM_PAGE_LIMIT) },
    (_, index) => index * NESTED_ITEM_PAGE_LIMIT,
  );
  const uploadOffsets = Array.from(
    { length: Math.ceil(totalUploads / UPLOAD_PAGE_LIMIT) },
    (_, index) => index * UPLOAD_PAGE_LIMIT,
  );

  const itemPages = await mapWithConcurrency(itemOffsets, itemPageConcurrency, async (offset) => {
    const body = await dato.cmaRequest("/items", {
      nested: true,
      version: "current",
      "page[limit]": NESTED_ITEM_PAGE_LIMIT,
      "page[offset]": offset,
    });
    return body.data ?? [];
  });

  const itemsByModel = new Map();

  for (const page of itemPages) {
    for (const item of page) {
      const modelApiKey = item.relationships?.item_type?.data?.id
        ? (itemTypeIdToApiKey.get(item.relationships.item_type.data.id) ?? null)
        : null;
      if (!modelApiKey) {
        continue;
      }
      const existing = itemsByModel.get(modelApiKey) ?? [];
      existing.push(item);
      itemsByModel.set(modelApiKey, existing);
    }
  }

  const uploadsPages = await mapWithConcurrency(uploadOffsets, uploadPageConcurrency, async (offset) => {
    const body = await dato.cmaRequest("/uploads", {
      "page[limit]": UPLOAD_PAGE_LIMIT,
      "page[offset]": offset,
    });
    return body.data ?? [];
  });
  const uploads = uploadsPages.flat();

  const modelManifests = [];
  const recordIndex = {};
  let exportedRecordCount = 0;

  const manifestModelOrder = Array.from(itemsByModel.keys()).sort((left, right) => left.localeCompare(right));

  for (const modelApiKey of manifestModelOrder) {
    const items = itemsByModel.get(modelApiKey) ?? [];
    if (items.length === 0) continue;

    const chunks = chunkArray(items, itemChunkSize);
    const chunkPaths = [];

    for (const [index, chunk] of chunks.entries()) {
      const chunkPath = resolve(outDir, "chunks", "items", `${modelApiKey}-${String(index + 1).padStart(4, "0")}.json`);
      await writeJsonFile(chunkPath, chunk);
      const relativeChunkPath = relative(outDir, chunkPath);
      chunkPaths.push(relativeChunkPath);
      for (const item of chunk) {
        recordIndex[item.id] = { modelApiKey, chunkPath: relativeChunkPath };
      }
      exportedRecordCount += chunk.length;
    }

    modelManifests.push({
      apiKey: modelApiKey,
      count: items.length,
      chunks: chunkPaths,
    });
  }

  const uploadChunkPaths = [];
  for (const [index, chunk] of chunkArray(uploads, uploadChunkSize).entries()) {
    const chunkPath = resolve(outDir, "chunks", "uploads", `uploads-${String(index + 1).padStart(4, "0")}.json`);
    await writeJsonFile(chunkPath, chunk);
    uploadChunkPaths.push(relative(outDir, chunkPath));
  }

  const recordIndexPath = "chunks/record-index.json";
  await writeJson(outDir, recordIndexPath, recordIndex);

  const snapshot = {
    version: 2,
    format: "chunked",
    exportedAt: new Date().toISOString(),
    site,
    schema,
    itemTypes,
    fieldMap: serializedFieldMap,
    models: modelManifests,
    uploads: {
      count: uploads.length,
      chunks: uploadChunkPaths,
    },
    recordIndexPath,
    counts: {
      models: modelManifests.length,
      records: exportedRecordCount,
      uploads: uploads.length,
      itemPages: itemOffsets.length,
      uploadPages: uploadOffsets.length,
    },
    exportSettings: {
      itemChunkSize,
      uploadChunkSize,
      itemPageConcurrency,
      uploadPageConcurrency,
      nestedItemPageLimit: NESTED_ITEM_PAGE_LIMIT,
      uploadPageLimit: UPLOAD_PAGE_LIMIT,
    },
  };

  const outPath = await writeJson(outDir, filename, snapshot);

  return {
    outPath,
    snapshot,
  };
}
