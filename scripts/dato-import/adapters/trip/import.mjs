import { pathToFileURL } from "node:url";
import { Data, Effect } from "effect";

import {
  IMPORT_LOCALE,
  cmsRequest,
  configureTripRuntime,
  datoGetItem,
  datoGetItems,
  datoGetItemTypeApiKey,
  datoListItemsByType,
  datoQuery,
  datoGetSite,
  denormalizeCmsLocale,
  disposeLocalR2Context,
  ensureAsset,
  getArg,
  latLonValue,
  mapDatoBlockType,
  normalizeDatoLocale,
  patchRecordOverrides,
  publishRecord,
  readJson,
  seoValue,
  upsertRecord,
  writeJson,
} from "./common.mjs";
import { contentModelDependencyOrder } from "./schema.mjs";

let model = "location";
let limit = 5;
let skip = 0;

let findings = [];
let touchedRecords = new Map();
let touchedOverrides = new Map();
let completedRootIds = new Set();
const FATAL_FINDING_TYPES = new Set(["asset_fallback", "skipped_block"]);
let recordImportPromises = new Map();
let assetImportPromises = new Map();
const LINKED_IMPORT_CONCURRENCY = 4;
const ASSET_IMPORT_CONCURRENCY = 6;
let runStartedAt = new Date().toISOString();

class ImportInfrastructureError extends Data.TaggedError("ImportInfrastructureError") {}
class ImportRootRecordError extends Data.TaggedError("ImportRootRecordError") {}
class ImportIntegrityError extends Data.TaggedError("ImportIntegrityError") {}
class ImportVerificationError extends Data.TaggedError("ImportVerificationError") {}

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

function checkpointFilename() {
  return `checkpoint-${model}-${skip}-${limit}-${IMPORT_LOCALE}.json`;
}

function serializeTouchedRecords() {
  return Object.fromEntries(
    [...touchedRecords.entries()].map(([modelApiKey, ids]) => [modelApiKey, [...ids]]),
  );
}

function serializeTouchedOverrides() {
  return Object.fromEntries(
    [...touchedOverrides.entries()].map(([modelApiKey, overrides]) => [modelApiKey, Object.fromEntries(overrides)]),
  );
}

function restoreCheckpoint(checkpoint) {
  findings = Array.isArray(checkpoint.findings) ? checkpoint.findings : [];
  completedRootIds = new Set(Array.isArray(checkpoint.completedRootIds) ? checkpoint.completedRootIds : []);
  touchedRecords = new Map(
    Object.entries(checkpoint.touchedRecords ?? {}).map(([modelApiKey, ids]) => [modelApiKey, new Set(Array.isArray(ids) ? ids : [])]),
  );
  touchedOverrides = new Map(
    Object.entries(checkpoint.touchedOverrides ?? {}).map(([modelApiKey, overrides]) => [
      modelApiKey,
      new Map(Object.entries(overrides ?? {})),
    ]),
  );
  runStartedAt = typeof checkpoint.startedAt === "string" ? checkpoint.startedAt : new Date().toISOString();
}

function checkpointSnapshot(status, extra = {}) {
  return {
    version: 1,
    adapter: "trip",
    model,
    skip,
    limit,
    locale: IMPORT_LOCALE,
    status,
    startedAt: runStartedAt,
    updatedAt: new Date().toISOString(),
    completedRootIds: [...completedRootIds],
    touchedRecords: serializeTouchedRecords(),
    touchedOverrides: serializeTouchedOverrides(),
    findings,
    ...extra,
  };
}

function readCheckpointEffect() {
  return promiseEffect(() => readJson(checkpointFilename()), "read checkpoint", {
    checkpoint: checkpointFilename(),
  });
}

function saveCheckpointEffect(status, extra = {}) {
  return promiseEffect(() => writeJson(checkpointFilename(), checkpointSnapshot(status, extra)), "write checkpoint", {
    checkpoint: checkpointFilename(),
    status,
  });
}

function writeFindingsEffect() {
  return promiseEffect(
    () => writeJson(`findings-${model}-${skip}-${limit}.json`, findings),
    "write findings",
    { model, skip, limit },
  );
}

function promiseEffect(thunk, label = "import operation", context = {}) {
  return Effect.tryPromise({
    try: thunk,
    catch: (cause) =>
      new ImportInfrastructureError({
        operation: label,
        message: `${label} failed: ${errorMessage(cause)}`,
        cause,
        ...context,
      }),
  });
}

function runConcurrentEffect(items, fn, concurrency = LINKED_IMPORT_CONCURRENCY) {
  return Effect.forEach(items, (item) => promiseEffect(() => fn(item)), { concurrency }).pipe(Effect.asVoid);
}

function runTasksEffect(tasks, concurrency = LINKED_IMPORT_CONCURRENCY) {
  return runConcurrentEffect(tasks, (task) => task(), concurrency);
}

function mapConcurrentEffect(items, fn, concurrency = LINKED_IMPORT_CONCURRENCY) {
  return Effect.forEach(items, (item) => promiseEffect(() => fn(item)), { concurrency });
}

function noteFinding(record) {
  findings.push(record);
}

function noteFindingEffect(record) {
  return Effect.sync(() => {
    noteFinding(record);
  });
}

function fatalFindings() {
  return findings.filter((finding) => FATAL_FINDING_TYPES.has(finding.type));
}

function fatalFindingsEffect() {
  return Effect.sync(() => fatalFindings());
}

function findingsCountEffect() {
  return Effect.sync(() => findings.length);
}

function localizedInput(value) {
  return value == null ? undefined : { [IMPORT_LOCALE]: value };
}

function localizedValue(value) {
  if (value == null) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value[denormalizeCmsLocale(IMPORT_LOCALE)] ?? value[IMPORT_LOCALE] ?? null;
  }
  return value;
}

function localizedMap(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== null && entry !== undefined && entry !== "")
    .map(([locale, entry]) => [normalizeDatoLocale(locale), entry]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function localizedSeoValue(value) {
  const map = localizedMap(value);
  if (!map) return undefined;
  const out = {};
  for (const [locale, seo] of Object.entries(map)) {
    const normalized = seoValue(seo);
    if (normalized && Object.keys(normalized).length > 0) {
      out[locale] = normalized;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function localizedIds(value) {
  const resolved = localizedValue(value);
  return Array.isArray(resolved) ? resolved : [];
}

function assetFromUploadRef(value) {
  if (!value?.upload_id) return null;
  return {
    id: value.upload_id,
    alt: value.alt ?? null,
    title: value.title ?? null,
    focalPoint: value.focal_point ?? null,
  };
}

function collectBlockRefs(node, refs = new Set()) {
  if (!node || typeof node !== "object") return refs;
  if (Array.isArray(node)) {
    for (const entry of node) collectBlockRefs(entry, refs);
    return refs;
  }
  if ((node.type === "block" || node.type === "inlineBlock") && typeof node.item === "string") {
    refs.add(node.item);
  }
  for (const value of Object.values(node)) {
    collectBlockRefs(value, refs);
  }
  return refs;
}

async function getRawBlockItems(dast) {
  const refs = [...collectBlockRefs(dast)];
  return datoGetItems(refs);
}

function markTouched(modelApiKey, id) {
  if (!touchedRecords.has(modelApiKey)) {
    touchedRecords.set(modelApiKey, new Set());
  }
  touchedRecords.get(modelApiKey).add(id);
}

function toRecordOverrides(meta) {
  if (!meta) return undefined;
  const overrides = {
    ...(meta.created_at ? { createdAt: meta.created_at } : {}),
    ...(meta.updated_at ? { updatedAt: meta.updated_at } : {}),
    ...(meta.published_at ? { publishedAt: meta.published_at } : {}),
    ...(meta.first_published_at ? { firstPublishedAt: meta.first_published_at } : {}),
  };
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function rememberOverrides(modelApiKey, id, overrides) {
  if (!overrides) return;
  if (!touchedOverrides.has(modelApiKey)) {
    touchedOverrides.set(modelApiKey, new Map());
  }
  touchedOverrides.get(modelApiKey).set(id, overrides);
}

async function upsertImportedRecord(modelApiKey, id, data, overrides) {
  await upsertRecord(modelApiKey, id, data, { publish: false, overrides });
  markTouched(modelApiKey, id);
  rememberOverrides(modelApiKey, id, overrides);
}

function upsertImportedRecordEffect(modelApiKey, id, data, overrides) {
  return promiseEffect(
    () => upsertImportedRecord(modelApiKey, id, data, overrides),
    "upsert imported record",
    { model: modelApiKey, recordId: id },
  );
}

function singleFlightEffect(cache, key, effectFactory, context = {}) {
  if (cache.has(key)) {
    return promiseEffect(() => cache.get(key), "reuse in-flight import", {
      key,
      ...context,
    });
  }

  const promise = Effect.runPromise(
    effectFactory().pipe(
      Effect.ensuring(
        Effect.sync(() => {
          cache.delete(key);
        }),
      ),
    ),
  );
  cache.set(key, promise);
  return promiseEffect(() => promise, "await in-flight import", {
    key,
    ...context,
  });
}

function publishTouchedRecordsEffect() {
  if (IMPORT_LOCALE !== "en") {
    return noteFindingEffect({
        type: "deferred_publish",
        detail: `Skipped auto-publish for locale '${IMPORT_LOCALE}'. Non-default locale imports only merge localized values onto existing records.`,
      });
  }

  return Effect.forEach(
    contentModelDependencyOrder(),
    (modelApiKey) =>
      Effect.forEach(
        [...(touchedRecords.get(modelApiKey) ?? [])],
        (id) =>
          promiseEffect(async () => {
            await publishRecord(modelApiKey, id);
            const overrides = touchedOverrides.get(modelApiKey)?.get(id);
            if (overrides) {
              await patchRecordOverrides(modelApiKey, id, overrides);
            }
          }),
        { concurrency: 1 },
      ),
    { concurrency: 1 },
  ).pipe(Effect.asVoid);
}

function assetFields(name) {
  return `
    ${name} {
      __typename
      id
      filename
      mimeType
      size
      width
      height
      alt
      title
      blurhash
      url
    }
  `;
}

function blockFragments(types) {
  const fragments = [];

  if (types.includes("tour_card")) {
    fragments.push(`
      ... on TourCardRecord {
        id
        description
        tour {
          id
          slug
          title
          summary
          duration
          tripadvisorReviewCount
          tripadvisorRating
          location { id slug name }
          ${assetFields("heroImage")}
        }
      }
    `);
  }

  if (types.includes("image")) {
    fragments.push(`
      ... on ImageRecord {
        id
        ${assetFields("image")}
      }
    `);
  }

  if (types.includes("video")) {
    fragments.push(`
      ... on VideoRecord {
        id
        videoUrl { url }
      }
    `);
  }

  if (types.includes("table")) {
    fragments.push(`
      ... on TableRecord {
        id
        tableData
      }
    `);
  }

  if (types.includes("place_card")) {
    fragments.push(`
      ... on PlaceCardRecord {
        id
        headline
        description { value }
        place {
          id
          slug
          title
          googlePlacesId
          ${assetFields("heroImage")}
        }
      }
    `);
  }

  if (types.includes("google_place_card")) {
    fragments.push(`
      ... on GooglePlaceCardRecord {
        id
        headline
        description { value }
        googlePlace
      }
    `);
  }

  return `
    blocks {
      __typename
      ${fragments.join("\n")}
    }
  `;
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function rewriteBlockRefs(node, idMap, context) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    return node
      .map((entry) => rewriteBlockRefs(entry, idMap, context))
      .filter((entry) => entry != null);
  }

  const copy = {};
  for (const [key, value] of Object.entries(node)) {
    copy[key] = key === "item" ? value : rewriteBlockRefs(value, idMap, context);
  }
  if ((copy.type === "block" || copy.type === "inlineBlock") && typeof copy.item === "string") {
    const mapped = idMap.get(copy.item);
    if (!mapped) {
      noteFinding({
        type: "accepted_regression",
        area: "unsupported_block_reference",
        detail: `Dropped unsupported ${copy.type} reference '${copy.item}' while importing ${context}.`,
      });
      return null;
    }
    copy.item = mapped;
  }
  return copy;
}

function scopedBlockId(scopeId, blockId) {
  return `${scopeId}__${blockId}`;
}

function transformStructuredText(value, scopeId) {
  if (!value) return null;
  const idMap = new Map();
  const blocks = {};
  for (const block of value.blocks ?? []) {
    const scopedId = scopedBlockId(scopeId, block.id);
    idMap.set(block.id, scopedId);
    const type = mapDatoBlockType(block.__typename);
    if (type === "image") {
      if (block.image) {
        blocks[scopedId] = {
          _type: "image",
          image: block.image.id,
        };
      }
      continue;
    }
    if (type === "video") {
      blocks[scopedId] = {
        _type: "video",
        video_url: block.videoUrl?.url ?? null,
      };
      noteFinding({ type: "accepted_regression", area: "video_block", detail: "Video blocks are imported as plain URL strings, not typed file/video fields." });
      continue;
    }
    if (type === "table") {
      blocks[scopedId] = {
        _type: "table",
        table_data: block.tableData ?? null,
      };
      continue;
    }
    if (type === "tour_card") {
      blocks[scopedId] = {
        _type: "tour_card",
        description: block.description ?? null,
        tour: block.tour?.id ?? null,
      };
      continue;
    }
    if (type === "place_card") {
      blocks[scopedId] = {
        _type: "place_card",
        headline: block.headline ?? null,
        description: block.description?.value ? transformStructuredText({ value: block.description.value, blocks: block.description.blocks ?? [] }, `${scopeId}__${block.id}__description`) : null,
        place: block.place?.id ?? null,
      };
      continue;
    }
    if (type === "google_place_card") {
      blocks[scopedId] = {
        _type: "google_place_card",
        headline: block.headline ?? null,
        description: block.description?.value ? transformStructuredText({ value: block.description.value, blocks: block.description.blocks ?? [] }, `${scopeId}__${block.id}__description`) : null,
        google_place: block.googlePlace ?? null,
      };
      continue;
    }
    noteFinding({ type: "skipped_block", blockType: block.__typename, detail: "Block type not yet mapped by importer." });
  }
  const rawValue = deepClone(value.value);
  return {
    value: rewriteBlockRefs(rawValue, idMap, scopeId),
    blocks,
  };
}

async function importAssetsFromRecord(record) {
  const candidates = [];
  const bodyBlocks = Array.isArray(record.body?.blocks)
    ? record.body.blocks
    : Object.values(record.body?.blocks ?? {});

  function pushAsset(asset) {
    if (asset?.id) candidates.push(asset);
  }

  pushAsset(record.hero);
  pushAsset(record.thumbnail);
  pushAsset(record.image);
  pushAsset(record.profilePicture);
  pushAsset(record.heroImage);

  for (const block of bodyBlocks) {
    pushAsset(block.image);
    pushAsset(block.heroImage);
  }

  await Effect.runPromise(runConcurrentEffect(candidates, async (asset) => {
    const result = await Effect.runPromise(ensureAssetOnceEffect(asset));
    if (result?.metadataOnly) {
      noteFinding({
        type: "asset_fallback",
        assetId: asset.id,
        detail: `Imported metadata only for asset '${asset.filename}'. Original blob could not be copied this run.${result.uploadError ? ` Cause: ${result.uploadError}` : ""}`,
      });
    }
  }, ASSET_IMPORT_CONCURRENCY));
}

async function importSiteSettings() {
  const site = await datoGetSite();
  await importAssetRefs(
    site.attributes?.favicon ? { upload_id: site.attributes.favicon } : null,
    ...Object.values(site.attributes?.global_seo ?? {}).map((entry) =>
      entry?.fallback_seo?.image ? { upload_id: entry.fallback_seo.image } : null
    )
  );

  await Effect.runPromise(upsertImportedRecordEffect("site_settings", "default", {
    ...(localizedMap(
      Object.fromEntries(
        Object.entries(site.attributes?.global_seo ?? {}).map(([locale, entry]) => [locale, entry?.site_name ?? null])
      )
    ) ? { site_name: localizedMap(
      Object.fromEntries(
        Object.entries(site.attributes?.global_seo ?? {}).map(([locale, entry]) => [locale, entry?.site_name ?? null])
      )
    ) } : {}),
    ...(localizedMap(
      Object.fromEntries(
        Object.entries(site.attributes?.global_seo ?? {}).map(([locale, entry]) => [locale, entry?.title_suffix ?? null])
      )
    ) ? { title_suffix: localizedMap(
      Object.fromEntries(
        Object.entries(site.attributes?.global_seo ?? {}).map(([locale, entry]) => [locale, entry?.title_suffix ?? null])
      )
    ) } : {}),
    ...(site.attributes?.no_index == null ? {} : { no_index: site.attributes.no_index }),
    ...(site.attributes?.favicon ? { favicon: site.attributes.favicon } : {}),
    ...(localizedMap(
      Object.fromEntries(
        Object.entries(site.attributes?.global_seo ?? {}).map(([locale, entry]) => [locale, entry?.facebook_page_url ?? null])
      )
    ) ? { facebook_page_url: localizedMap(
      Object.fromEntries(
        Object.entries(site.attributes?.global_seo ?? {}).map(([locale, entry]) => [locale, entry?.facebook_page_url ?? null])
      )
    ) } : {}),
    ...(localizedMap(
      Object.fromEntries(
        Object.entries(site.attributes?.global_seo ?? {}).map(([locale, entry]) => [locale, entry?.twitter_account ?? null])
      )
    ) ? { twitter_account: localizedMap(
      Object.fromEntries(
        Object.entries(site.attributes?.global_seo ?? {}).map(([locale, entry]) => [locale, entry?.twitter_account ?? null])
      )
    ) } : {}),
    ...(localizedSeoValue(
      Object.fromEntries(
        Object.entries(site.attributes?.global_seo ?? {}).map(([locale, entry]) => [locale, entry?.fallback_seo ?? null])
      )
    ) ? { fallback_seo: localizedSeoValue(
      Object.fromEntries(
        Object.entries(site.attributes?.global_seo ?? {}).map(([locale, entry]) => [locale, entry?.fallback_seo ?? null])
      )
    ) } : {}),
  }));
}

async function importAssetRefs(...refs) {
  await Effect.runPromise(runConcurrentEffect(refs, async (ref) => {
    const asset = assetFromUploadRef(ref);
    if (!asset?.id) return;
    const result = await Effect.runPromise(ensureAssetOnceEffect(asset));
    if (result?.metadataOnly) {
      noteFinding({
        type: "asset_fallback",
        assetId: asset.id,
        detail: `Imported metadata only for asset '${asset.id}'. Original blob could not be copied this run.${result.uploadError ? ` Cause: ${result.uploadError}` : ""}`,
      });
    }
  }, ASSET_IMPORT_CONCURRENCY));
}

async function importContributorById(id) {
  await Effect.runPromise(importRecordOnceEffect("contributor", id, () => promiseEffect(async () => {
    const contributor = await datoGetItem(id);
    await importAssetRefs(contributor.attributes.profile_picture);
    await Effect.runPromise(upsertImportedRecordEffect("contributor", contributor.id, {
      ...(contributor.attributes.name == null ? {} : { name: contributor.attributes.name }),
      ...(localizedValue(contributor.attributes.role) == null ? {} : { role: localizedValue(contributor.attributes.role) }),
      ...(assetFromUploadRef(contributor.attributes.profile_picture)?.id == null ? {} : { profile_picture: assetFromUploadRef(contributor.attributes.profile_picture).id }),
    }, toRecordOverrides(contributor.meta)));
  }, "import contributor", { recordId: id })));
}

async function importLocationById(id) {
  await Effect.runPromise(importRecordOnceEffect("location", id, () => promiseEffect(async () => {
    const location = await datoGetItem(id);
    await importAssetRefs(location.attributes.image);
    await Effect.runPromise(upsertImportedRecordEffect("location", location.id, {
      ...(localizedInput(localizedValue(location.attributes.name)) ? { name: localizedInput(localizedValue(location.attributes.name)) } : {}),
      ...(location.attributes.slug == null ? {} : { slug: location.attributes.slug }),
      ...(localizedInput(localizedValue(location.attributes.description)) ? { description: localizedInput(localizedValue(location.attributes.description)) } : {}),
      ...(assetFromUploadRef(location.attributes.image)?.id == null ? {} : { image: assetFromUploadRef(location.attributes.image).id }),
      ...(latLonValue(location.attributes.geolocation) == null ? {} : { geolocation: latLonValue(location.attributes.geolocation) }),
    }, toRecordOverrides(location.meta)));
  }, "import location", { recordId: id })));
}

async function importPlaceById(id) {
  await Effect.runPromise(importRecordOnceEffect("place", id, () => promiseEffect(async () => {
    const place = await datoGetItem(id);
    const content = place.attributes.content?.[IMPORT_LOCALE] ?? null;
    await importAssetRefs(place.attributes.hero_image, ...(place.attributes.gallery ?? []));
    await Effect.runPromise(runTasksEffect([
      ...(place.attributes.locations ?? []).map((locationId) => () => importLocationById(locationId)),
      ...(place.attributes.tours ?? []).map((tourId) => () => importTourById(tourId)),
      ...(place.attributes.blogs ?? []).map((articleId) => () => importArticleById(articleId)),
      ...(place.attributes.nearby_places ?? []).map((nearbyPlaceId) => () => importPlaceById(nearbyPlaceId)),
      ...localizedIds(place.attributes.questions).map((qaId) => () => importQaById(qaId)),
      ...(content ? [() => importDependenciesFromRawBody(content)] : []),
    ]));
    await Effect.runPromise(upsertImportedRecordEffect("place", place.id, {
      ...(localizedInput(localizedValue(place.attributes.title)) ? { title: localizedInput(localizedValue(place.attributes.title)) } : {}),
      ...(place.attributes.slug == null ? {} : { slug: place.attributes.slug }),
      ...(place.attributes.google_places_id == null ? {} : { google_places_id: place.attributes.google_places_id }),
      ...(assetFromUploadRef(place.attributes.hero_image)?.id == null ? {} : { hero_image: assetFromUploadRef(place.attributes.hero_image).id }),
      ...(Array.isArray(place.attributes.gallery) && place.attributes.gallery.length > 0 ? { gallery: place.attributes.gallery.map((asset) => asset.upload_id).filter(Boolean) } : {}),
      ...(Array.isArray(place.attributes.locations) && place.attributes.locations.length > 0 ? { locations: place.attributes.locations } : {}),
      ...(content ? { content: { [IMPORT_LOCALE]: await transformStructuredTextRaw(content, `${place.id}__content__${IMPORT_LOCALE}`) } } : {}),
      ...(localizedSeoValue(place.attributes.seo) ? { seo: localizedSeoValue(place.attributes.seo) } : {}),
      ...(Array.isArray(place.attributes.tours) && place.attributes.tours.length > 0 ? { tours: place.attributes.tours } : {}),
      ...(Array.isArray(place.attributes.nearby_places) && place.attributes.nearby_places.length > 0 ? { nearby_places: place.attributes.nearby_places } : {}),
      ...(Array.isArray(place.attributes.blogs) && place.attributes.blogs.length > 0 ? { blogs: place.attributes.blogs } : {}),
      ...(localizedIds(place.attributes.questions).length > 0 ? { questions: localizedIds(place.attributes.questions) } : {}),
    }, toRecordOverrides(place.meta)));
  }, "import place", { recordId: id })));
}

async function importTourById(id) {
  await Effect.runPromise(importRecordOnceEffect("tour", id, () => promiseEffect(async () => {
    const tour = await datoGetItem(id);
    await importAssetRefs(tour.attributes.hero_image);
    if (tour.attributes.location) {
      await importLocationById(tour.attributes.location);
    }
    await Effect.runPromise(upsertImportedRecordEffect("tour", tour.id, {
      ...(localizedInput(localizedValue(tour.attributes.title)) ? { title: localizedInput(localizedValue(tour.attributes.title)) } : {}),
      ...(tour.attributes.slug == null ? {} : { slug: tour.attributes.slug }),
      ...(localizedInput(localizedValue(tour.attributes.summary)) ? { summary: localizedInput(localizedValue(tour.attributes.summary)) } : {}),
      ...(tour.attributes.duration == null ? {} : { duration: tour.attributes.duration }),
      ...(tour.attributes.per_person == null ? {} : { per_person: tour.attributes.per_person }),
      ...(tour.attributes.tripadvisor_review_count == null ? {} : { tripadvisor_review_count: tour.attributes.tripadvisor_review_count }),
      ...(tour.attributes.tripadvisor_rating == null ? {} : { tripadvisor_rating: tour.attributes.tripadvisor_rating }),
      ...(assetFromUploadRef(tour.attributes.hero_image)?.id == null ? {} : { hero_image: assetFromUploadRef(tour.attributes.hero_image).id }),
      ...(tour.attributes.location == null ? {} : { location: tour.attributes.location }),
    }, toRecordOverrides(tour.meta)));
  }, "import tour", { recordId: id })));
}

async function importQaById(id) {
  await Effect.runPromise(importRecordOnceEffect("qa", id, () => promiseEffect(async () => {
    const qa = await datoGetItem(id);
    await Effect.runPromise(upsertImportedRecordEffect("qa", qa.id, {
      ...(qa.attributes.question == null ? {} : { question: qa.attributes.question }),
      ...(qa.attributes.answer == null ? {} : { answer: qa.attributes.answer }),
    }, toRecordOverrides(qa.meta)));
  }, "import qa", { recordId: id })));
}

async function importArticleById(id) {
  await Effect.runPromise(importRecordOnceEffect("article", id, () => promiseEffect(async () => {
    const article = await datoGetItem(id);
    const body = article.attributes.body?.[IMPORT_LOCALE] ?? null;
    await Effect.runPromise(runTasksEffect([
      ...(article.attributes.contributor ? [() => importContributorById(article.attributes.contributor)] : []),
      ...(article.attributes.location ? [() => importLocationById(article.attributes.location)] : []),
      ...localizedIds(article.attributes.questions).map((qaId) => () => importQaById(qaId)),
      ...(body ? [() => importDependenciesFromRawBody(body)] : []),
    ]));
    await importAssetRefs(article.attributes.hero, article.attributes.thumbnail);
    await Effect.runPromise(upsertImportedRecordEffect("article", article.id, {
      ...(localizedInput(localizedValue(article.attributes.title)) ? { title: localizedInput(localizedValue(article.attributes.title)) } : {}),
      ...(article.attributes.slug == null ? {} : { slug: article.attributes.slug }),
      ...(localizedInput(localizedValue(article.attributes.summary)) ? { summary: localizedInput(localizedValue(article.attributes.summary)) } : {}),
      ...(body ? { body: { [IMPORT_LOCALE]: await transformStructuredTextRaw(body, `${article.id}__body__${IMPORT_LOCALE}`) } } : {}),
      ...(article.attributes.date == null ? {} : { date: article.attributes.date }),
      ...(article.attributes.redirect_url == null ? {} : { redirect_url: article.attributes.redirect_url }),
      ...(article.attributes.toc_is_visible == null ? {} : { toc_is_visible: article.attributes.toc_is_visible }),
      ...(localizedSeoValue(article.attributes.seo_metadata) ? { seo_metadata: localizedSeoValue(article.attributes.seo_metadata) } : {}),
      ...(assetFromUploadRef(article.attributes.hero)?.id == null ? {} : { hero: assetFromUploadRef(article.attributes.hero).id }),
      ...(assetFromUploadRef(article.attributes.thumbnail)?.id == null ? {} : { thumbnail: assetFromUploadRef(article.attributes.thumbnail).id }),
      ...(article.attributes.contributor == null ? {} : { contributor: article.attributes.contributor }),
      ...(article.attributes.location == null ? {} : { location: article.attributes.location }),
      ...(localizedIds(article.attributes.questions).length > 0 ? { questions: localizedIds(article.attributes.questions) } : {}),
    }, toRecordOverrides(article.meta)));
  }, "import article", { recordId: id })));
}

function importRecordOnceEffect(modelApiKey, id, loader) {
  const key = `${modelApiKey}:${id}`;
  return singleFlightEffect(recordImportPromises, key, loader, {
    model: modelApiKey,
    recordId: id,
  });
}

function ensureAssetOnceEffect(asset) {
  if (!asset?.id) return Effect.succeed(null);
  return singleFlightEffect(
    assetImportPromises,
    asset.id,
    () => promiseEffect(() => ensureAsset(asset), "ensure asset", { assetId: asset.id }),
    { assetId: asset.id },
  );
}

async function importNestedSupportRecords(record) {
  await Effect.runPromise(runTasksEffect([
    ...(record.contributor?.id ? [() => importContributorById(record.contributor.id)] : []),
    ...(record.location?.id ? [() => importLocationById(record.location.id)] : []),
    ...(record.body?.blocks ?? []).flatMap((block) => [
      ...(block.tour?.id ? [() => importTourById(block.tour.id)] : []),
      ...(block.place?.id ? [() => importPlaceById(block.place.id)] : []),
    ]),
  ]));
}

async function importDependenciesFromRawBody(dast) {
  await Effect.runPromise(runConcurrentEffect(await getRawBlockItems(dast), async (block) => {
    const blockType = await datoGetItemTypeApiKey(block.relationships.item_type.data.id);
    if (blockType === "image") {
      await importAssetRefs(block.attributes.image);
      return;
    }
    if (blockType === "tour_card") {
      if (block.attributes.tour) {
        await importTourById(block.attributes.tour);
      }
      return;
    }
    if (blockType === "place_card") {
      if (block.attributes.place) {
        await importPlaceById(block.attributes.place);
      }
      if (block.attributes.description) {
        await importDependenciesFromRawBody(block.attributes.description);
      }
      return;
    }
    if (blockType === "google_place_card") {
      if (block.attributes.description) {
        await importDependenciesFromRawBody(block.attributes.description);
      }
      return;
    }
  }));
}

async function transformStructuredTextRaw(dast, scopeId) {
  if (!dast) return null;
  const blocks = {};
  const idMap = new Map();
  for (const block of await getRawBlockItems(dast)) {
    const blockType = await datoGetItemTypeApiKey(block.relationships.item_type.data.id);
    const scopedId = scopedBlockId(scopeId, block.id);
    idMap.set(block.id, scopedId);

    if (blockType === "image") {
      await importAssetRefs(block.attributes.image);
      blocks[scopedId] = {
        _type: "image",
        image: assetFromUploadRef(block.attributes.image)?.id ?? null,
      };
      continue;
    }

    if (blockType === "video") {
      blocks[scopedId] = {
        _type: "video",
        video_url: block.attributes.video_url?.url ?? block.attributes.video_url ?? null,
      };
      noteFinding({ type: "accepted_regression", area: "video_block", detail: "Video blocks are imported as plain URL strings, not typed file/video fields." });
      continue;
    }

    if (blockType === "table") {
      blocks[scopedId] = {
        _type: "table",
        table_data: block.attributes.table_data ?? block.attributes.tableData ?? null,
      };
      continue;
    }

    if (blockType === "tour_card") {
      if (block.attributes.tour) {
        await importTourById(block.attributes.tour);
      }
      blocks[scopedId] = {
        _type: "tour_card",
        description: block.attributes.description ?? null,
        tour: block.attributes.tour ?? null,
      };
      continue;
    }

    if (blockType === "place_card") {
      if (block.attributes.place) {
        await importPlaceById(block.attributes.place);
      }
      blocks[scopedId] = {
        _type: "place_card",
        headline: block.attributes.headline ?? null,
        description: block.attributes.description ? await transformStructuredTextRaw(block.attributes.description, `${scopeId}__${block.id}__description`) : null,
        place: block.attributes.place ?? null,
      };
      continue;
    }

    if (blockType === "google_place_card") {
      blocks[scopedId] = {
        _type: "google_place_card",
        headline: block.attributes.headline ?? null,
        description: block.attributes.description ? await transformStructuredTextRaw(block.attributes.description, `${scopeId}__${block.id}__description`) : null,
        google_place: block.attributes.google_place ?? null,
      };
      continue;
    }

    noteFinding({ type: "skipped_block", blockType: blockType ?? block.relationships.item_type.data.id, detail: "Block type not yet mapped by importer." });
  }

  return {
    value: rewriteBlockRefs(deepClone(dast), idMap, scopeId),
    blocks,
  };
}

function queryForModel(modelApiKey) {
  if (modelApiKey === "location") {
    return `
      query ImportLocations($first: IntType!, $skip: IntType!, $locale: SiteLocale!) {
        allLocations(first: $first, skip: $skip, locale: $locale, fallbackLocales: [en], orderBy: name_ASC) {
          id
          slug
          name
          description
          geolocation { latitude longitude }
          ${assetFields("image")}
        }
      }
    `;
  }

  if (modelApiKey === "place") {
    return `
      query ImportPlaces($first: IntType!, $skip: IntType!, $locale: SiteLocale!) {
        allPlaces(first: $first, skip: $skip, locale: $locale, fallbackLocales: [en], orderBy: _updatedAt_DESC) {
          id
          slug
          title
          googlePlacesId
          ${assetFields("heroImage")}
        }
      }
    `;
  }

  if (modelApiKey === "article") {
    return `
      query ImportArticles($first: IntType!, $skip: IntType!, $locale: SiteLocale!) {
        allArticles(first: $first, skip: $skip, locale: $locale, fallbackLocales: [en], orderBy: date_DESC) {
          id
          slug
          title
          summary
          date
          redirectUrl
          tocIsVisible
          seoMetadata { title description }
          ${assetFields("hero")}
          ${assetFields("thumbnail")}
          contributor {
            id
            name
            role
            ${assetFields("profilePicture")}
          }
          location {
            id
            slug
            name
          }
          body {
            value
            ${blockFragments(["tour_card", "image", "video", "table"])}
          }
        }
      }
    `;
  }

  if (modelApiKey === "guide") {
    return `
      query ImportGuides($first: IntType!, $skip: IntType!, $locale: SiteLocale!) {
        allGuides(first: $first, skip: $skip, locale: $locale, fallbackLocales: [en], orderBy: _updatedAt_DESC) {
          id
          slug
          title
          summary
          seoMetadata { title description }
          geolocation { latitude longitude }
          ${assetFields("hero")}
          ${assetFields("thumbnail")}
          location {
            id
            slug
            name
          }
          body {
            value
            ${blockFragments(["image", "place_card", "tour_card", "video", "google_place_card"])}
          }
        }
      }
    `;
  }

  throw new Error(`Unsupported model '${modelApiKey}'. Supported: location, place, article, guide`);
}

function recordsFromData(modelApiKey, data) {
  if (modelApiKey === "location") return data.allLocations;
  if (modelApiKey === "place") return data.allPlaces;
  if (modelApiKey === "article") return data.allArticles;
  if (modelApiKey === "guide") return data.allGuides;
  return [];
}

async function importLocation(record) {
  await importAssetsFromRecord(record);
  await Effect.runPromise(upsertImportedRecordEffect("location", record.id, {
    ...(localizedInput(record.name) ? { name: localizedInput(record.name) } : {}),
    ...(record.slug == null ? {} : { slug: record.slug }),
    ...(localizedInput(record.description) ? { description: localizedInput(record.description) } : {}),
    ...(record.image?.id == null ? {} : { image: record.image.id }),
    ...(latLonValue(record.geolocation) == null ? {} : { geolocation: latLonValue(record.geolocation) }),
  }, record.overrides));
}

async function importPlace(record) {
  await importAssetsFromRecord(record);
  await Effect.runPromise(upsertImportedRecordEffect("place", record.id, {
    ...(localizedInput(record.title) ? { title: localizedInput(record.title) } : {}),
    ...(record.slug == null ? {} : { slug: record.slug }),
    ...(record.googlePlacesId == null ? {} : { google_places_id: record.googlePlacesId }),
    ...(record.heroImage?.id == null ? {} : { hero_image: record.heroImage.id }),
    ...(Array.isArray(record.gallery) && record.gallery.length > 0 ? { gallery: record.gallery.map((asset) => asset.id).filter(Boolean) } : {}),
    ...(Array.isArray(record.locations) && record.locations.length > 0 ? { locations: record.locations.map((entry) => entry.id).filter(Boolean) } : {}),
    ...(record.content ? { content: { [IMPORT_LOCALE]: record.content } } : {}),
    ...(record.seo ? { seo: record.seo } : {}),
    ...(Array.isArray(record.tours) && record.tours.length > 0 ? { tours: record.tours.map((entry) => entry.id).filter(Boolean) } : {}),
    ...(Array.isArray(record.nearbyPlaces) && record.nearbyPlaces.length > 0 ? { nearby_places: record.nearbyPlaces.map((entry) => entry.id).filter(Boolean) } : {}),
    ...(Array.isArray(record.blogs) && record.blogs.length > 0 ? { blogs: record.blogs.map((entry) => entry.id).filter(Boolean) } : {}),
    ...(Array.isArray(record.questions) && record.questions.length > 0 ? { questions: record.questions.map((entry) => entry.id).filter(Boolean) } : {}),
  }, record.overrides));
}

async function importArticle(record) {
  await importAssetsFromRecord(record);
  await Effect.runPromise(upsertImportedRecordEffect("article", record.id, {
    ...(localizedInput(record.title) ? { title: localizedInput(record.title) } : {}),
    ...(record.slug == null ? {} : { slug: record.slug }),
    ...(localizedInput(record.summary) ? { summary: localizedInput(record.summary) } : {}),
    ...(record.body ? { body: { [IMPORT_LOCALE]: record.body } } : {}),
    ...(record.date == null ? {} : { date: record.date }),
    ...(record.redirectUrl == null ? {} : { redirect_url: record.redirectUrl }),
    ...(record.hero?.id == null ? {} : { hero: record.hero.id }),
    ...(record.thumbnail?.id == null ? {} : { thumbnail: record.thumbnail.id }),
    ...(record.contributor?.id == null ? {} : { contributor: record.contributor.id }),
    ...(record.location?.id == null ? {} : { location: record.location.id }),
    ...(Array.isArray(record.questions) && record.questions.length > 0 ? { questions: record.questions.map((entry) => entry.id).filter(Boolean) } : {}),
    ...(record.seoMetadata ? { seo_metadata: record.seoMetadata } : {}),
    ...(record.tocIsVisible == null ? {} : { toc_is_visible: record.tocIsVisible }),
  }, record.overrides));
}

async function importGuide(record) {
  await importAssetsFromRecord(record);
  await Effect.runPromise(upsertImportedRecordEffect("guide", record.id, {
    ...(localizedInput(record.title) ? { title: localizedInput(record.title) } : {}),
    ...(record.slug == null ? {} : { slug: record.slug }),
    ...(localizedInput(record.summary) ? { summary: localizedInput(record.summary) } : {}),
    ...(record.body ? { body: { [IMPORT_LOCALE]: record.body } } : {}),
    ...(record.hero?.id == null ? {} : { hero: record.hero.id }),
    ...(record.thumbnail?.id == null ? {} : { thumbnail: record.thumbnail.id }),
    ...(latLonValue(record.geolocation) == null ? {} : { geolocation: latLonValue(record.geolocation) }),
    ...(record.location?.id == null ? {} : { location: record.location.id }),
    ...(record.seoMetadata ? { seo_metadata: record.seoMetadata } : {}),
  }, record.overrides));
}

async function listSourceRecords(modelApiKey) {
  if (modelApiKey === "location") {
    return (await datoListItemsByType("location", { limit, offset: skip }))
      .filter((item) => !completedRootIds.has(item.id))
      .map((item) => ({
      id: item.id,
      overrides: toRecordOverrides(item.meta),
      slug: item.attributes.slug ?? null,
      name: localizedValue(item.attributes.name),
      description: localizedValue(item.attributes.description),
      geolocation: item.attributes.geolocation ?? null,
      image: assetFromUploadRef(item.attributes.image),
    }));
  }

  if (modelApiKey === "place") {
    const items = (await datoListItemsByType("place", { limit, offset: skip }))
      .filter((item) => !completedRootIds.has(item.id));
    return Effect.runPromise(mapConcurrentEffect(items, async (item) => {
      const content = item.attributes.content?.[IMPORT_LOCALE] ?? null;
      await Effect.runPromise(runTasksEffect([
        ...(item.attributes.locations ?? []).map((locationId) => () => importLocationById(locationId)),
        ...(item.attributes.tours ?? []).map((tourId) => () => importTourById(tourId)),
        ...(item.attributes.blogs ?? []).map((articleId) => () => importArticleById(articleId)),
        ...(item.attributes.nearby_places ?? []).map((nearbyPlaceId) => () => importPlaceById(nearbyPlaceId)),
        ...localizedIds(item.attributes.questions).map((qaId) => () => importQaById(qaId)),
        ...(content ? [() => importDependenciesFromRawBody(content)] : []),
      ]));
      await importAssetRefs(item.attributes.hero_image, ...(item.attributes.gallery ?? []));
      return {
        id: item.id,
        overrides: toRecordOverrides(item.meta),
        slug: item.attributes.slug ?? null,
        title: localizedValue(item.attributes.title),
        googlePlacesId: item.attributes.google_places_id ?? null,
        heroImage: assetFromUploadRef(item.attributes.hero_image),
        gallery: (item.attributes.gallery ?? []).map(assetFromUploadRef).filter(Boolean),
        locations: (item.attributes.locations ?? []).map((id) => ({ id })),
        content: content ? await transformStructuredTextRaw(content, `${item.id}__content__${IMPORT_LOCALE}`) : null,
        seo: localizedSeoValue(item.attributes.seo),
        tours: (item.attributes.tours ?? []).map((id) => ({ id })),
        nearbyPlaces: (item.attributes.nearby_places ?? []).map((id) => ({ id })),
        blogs: (item.attributes.blogs ?? []).map((id) => ({ id })),
        questions: localizedIds(item.attributes.questions).map((id) => ({ id })),
      };
    }, LINKED_IMPORT_CONCURRENCY));
  }

  if (modelApiKey === "article") {
    const items = (await datoListItemsByType("article", { limit, offset: skip }))
      .filter((item) => !completedRootIds.has(item.id));
    return Effect.runPromise(mapConcurrentEffect(items, async (item) => {
      const body = item.attributes.body?.[IMPORT_LOCALE] ?? null;
      await Effect.runPromise(runTasksEffect([
        ...(item.attributes.contributor ? [() => importContributorById(item.attributes.contributor)] : []),
        ...(item.attributes.location ? [() => importLocationById(item.attributes.location)] : []),
        ...localizedIds(item.attributes.questions).map((qaId) => () => importQaById(qaId)),
        ...(body ? [() => importDependenciesFromRawBody(body)] : []),
      ]));
      await importAssetRefs(item.attributes.hero, item.attributes.thumbnail);
      return {
        id: item.id,
        overrides: toRecordOverrides(item.meta),
        slug: item.attributes.slug ?? null,
        title: localizedValue(item.attributes.title),
        summary: localizedValue(item.attributes.summary),
        date: item.attributes.date ?? null,
        redirectUrl: item.attributes.redirect_url ?? null,
        tocIsVisible: item.attributes.toc_is_visible ?? null,
        seoMetadata: localizedSeoValue(item.attributes.seo_metadata),
        hero: assetFromUploadRef(item.attributes.hero),
        thumbnail: assetFromUploadRef(item.attributes.thumbnail),
        contributor: item.attributes.contributor ? { id: item.attributes.contributor } : null,
        location: item.attributes.location ? { id: item.attributes.location } : null,
        questions: localizedIds(item.attributes.questions).map((id) => ({ id })),
        body: body ? await transformStructuredTextRaw(body, `${item.id}__body__${IMPORT_LOCALE}`) : null,
      };
    }, LINKED_IMPORT_CONCURRENCY));
  }

  if (modelApiKey === "guide") {
    const items = (await datoListItemsByType("guide", { limit, offset: skip }))
      .filter((item) => !completedRootIds.has(item.id));
    return Effect.runPromise(mapConcurrentEffect(items, async (item) => {
      const body = item.attributes.body?.[IMPORT_LOCALE] ?? null;
      await Effect.runPromise(runTasksEffect([
        ...(item.attributes.location ? [() => importLocationById(item.attributes.location)] : []),
        ...(body ? [() => importDependenciesFromRawBody(body)] : []),
      ]));
      await importAssetRefs(item.attributes.hero, item.attributes.thumbnail);
      return {
        id: item.id,
        overrides: toRecordOverrides(item.meta),
        slug: item.attributes.slug ?? null,
        title: localizedValue(item.attributes.title),
        summary: localizedValue(item.attributes.summary),
        seoMetadata: localizedSeoValue(item.attributes.seo_metadata),
        geolocation: item.attributes.geolocation ?? null,
        hero: assetFromUploadRef(item.attributes.hero),
        thumbnail: assetFromUploadRef(item.attributes.thumbnail),
        location: item.attributes.location ? { id: item.attributes.location } : null,
        body: body ? await transformStructuredTextRaw(body, `${item.id}__body__${IMPORT_LOCALE}`) : null,
      };
    }, LINKED_IMPORT_CONCURRENCY));
  }

  const query = queryForModel(modelApiKey);
  const data = await datoQuery(query, {
    first: limit,
    skip,
    locale: IMPORT_LOCALE,
  });
  return recordsFromData(modelApiKey, data);
}

export async function runImport(options = {}) {
  return Effect.runPromise(createImportProgram(options));
}

export function createImportProgram(options = {}) {
  configureTripRuntime(options);
  model = options.model ?? "location";
  limit = options.limit ?? 5;
  skip = options.skip ?? 0;
  findings = [];
  touchedRecords = new Map();
  touchedOverrides = new Map();
  completedRootIds = new Set();
  recordImportPromises = new Map();
  assetImportPromises = new Map();
  runStartedAt = new Date().toISOString();

  const importRootRecord = (record) =>
    promiseEffect(async () => {
      if (model === "location") await importLocation(record);
      if (model === "place") await importPlace(record);
      if (model === "article") await importArticle(record);
      if (model === "guide") await importGuide(record);
    }, "import root record", { model, recordId: record.id });

  return Effect.gen(function* () {
    const existingCheckpoint = yield* readCheckpointEffect();
    if (existingCheckpoint?.value?.status && existingCheckpoint.value.status !== "completed") {
      restoreCheckpoint(existingCheckpoint.value);
      yield* Effect.logInfo(
        `Resuming Dato import for ${model} (${IMPORT_LOCALE}) with ${completedRootIds.size} completed root record(s)`,
      );
    } else if (existingCheckpoint?.value?.status === "completed") {
      yield* Effect.logInfo(`Starting fresh Dato import for ${model} (${IMPORT_LOCALE}); previous checkpoint was already completed`);
    } else {
      yield* Effect.logInfo(`Starting Dato import for ${model} (${IMPORT_LOCALE})`);
    }

    yield* saveCheckpointEffect("running");
    yield* promiseEffect(() => importSiteSettings(), "import site settings");
    const records = yield* promiseEffect(() => listSourceRecords(model), "list source records", { model, skip, limit });

    yield* Effect.forEach(
      records,
      (record) =>
        importRootRecord(record).pipe(
          Effect.zipRight(
            Effect.sync(() => {
              completedRootIds.add(record.id);
            }),
          ),
          Effect.catchAll((error) =>
            Effect.fail(
              new ImportRootRecordError({
                model,
                recordId: record.id,
                message: `Failed to import root ${model} record '${record.id}'`,
                cause: error,
              }),
            ),
          ),
          Effect.zipRight(saveCheckpointEffect("running", { recordId: record.id })),
        ),
      { concurrency: 1 },
    );
    yield* publishTouchedRecordsEffect();

    const findingsPath = yield* writeFindingsEffect();
    const integrityViolations = yield* fatalFindingsEffect();
    const findingsCount = yield* findingsCountEffect();

    if (integrityViolations.length > 0) {
      yield* Effect.fail(
        new ImportIntegrityError({
          model,
          findingsPath,
          violationCount: integrityViolations.length,
          message: `Import aborted for ${model}: ${integrityViolations.length} referential integrity violation(s). See ${findingsPath}`,
        }),
      );
    }

    yield* Effect.logInfo(`Imported ${records.length} ${model} record(s) from locale ${IMPORT_LOCALE}`);
    yield* Effect.logInfo(`Skipped/accepted findings: ${findingsCount}`);
    yield* Effect.logInfo(`Saved ${findingsPath}`);

    const summary = yield* promiseEffect(() =>
      cmsRequest("POST", "/graphql", {
        query: `
          query Verify($first: Int) {
            ${model === "location" ? "allLocations(first: $first) { id slug }" : ""}
            ${model === "place" ? "allPlaces(first: $first) { id slug }" : ""}
            ${model === "article" ? "allArticles(first: $first) { id slug }" : ""}
            ${model === "guide" ? "allGuides(first: $first) { id slug }" : ""}
          }
        `,
        variables: { first: limit + skip + 5 },
      }),
      "verify imported records",
      { model, skip, limit },
    );

    if (!summary.ok) {
      yield* Effect.fail(
        new ImportVerificationError({
          model,
          status: summary.status,
          body: summary.body,
          message: `Verification query failed (${summary.status}): ${JSON.stringify(summary.body)}`,
        }),
      );
    }

    yield* Effect.logInfo("Verification query succeeded");
    yield* saveCheckpointEffect("completed", { completedAt: new Date().toISOString(), findingsPath });
    return {
      findingsPath,
      recordsImported: records.length,
    };
  }).pipe(
    Effect.catchAll((error) =>
      saveCheckpointEffect("failed", {
          lastError: errorMessage(error),
          lastErrorTag: error && typeof error === "object" && "_tag" in error ? error._tag : undefined,
        }).pipe(Effect.zipRight(Effect.fail(error))),
    ),
    Effect.ensuring(promiseEffect(() => disposeLocalR2Context(), "dispose local R2 context")),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runImport({
    model: getArg("model", "location"),
    limit: Number(getArg("limit", "5")),
    skip: Number(getArg("skip", "0")),
  });
}
