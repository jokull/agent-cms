import { Data, Effect } from "effect";

class DatoNetworkError extends Data.TaggedError("DatoNetworkError") {}
class DatoDecodeError extends Data.TaggedError("DatoDecodeError") {}
class DatoApiError extends Data.TaggedError("DatoApiError") {}
class DatoRateLimitError extends Data.TaggedError("DatoRateLimitError") {}

export function createDatoClient({
  token,
  graphqlUrl = "https://graphql.datocms.com/",
  cmaUrl = "https://site-api.datocms.com",
}) {
  if (!token) {
    throw new Error("DATOCMS_API_TOKEN is required");
  }

  const itemCache = new Map();
  const itemTypeCache = new Map();
  const uploadCache = new Map();

  function requestJson(url, init) {
    return Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () => fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }),
        catch: (cause) => new DatoNetworkError({ message: `Dato request failed for ${url}`, cause }),
      }).pipe(Effect.retry({ times: 2 }));
      const body = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: (cause) => new DatoDecodeError({ message: `Dato response JSON decode failed for ${url}`, cause }),
      });
      return { response, body };
    });
  }

  async function query(query, variables = {}) {
    return Effect.runPromise(Effect.gen(function* () {
      const { response, body } = yield* requestJson(graphqlUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "x-exclude-invalid": "true",
        },
        body: JSON.stringify({ query, variables }),
      });
      if (!response.ok || body.errors) {
        yield* Effect.fail(
          new DatoApiError({
            message: `Dato query failed: ${JSON.stringify(body.errors ?? body, null, 2)}`,
            cause: body.errors ?? body,
          }),
        );
      }
      return body.data;
    }));
  }

  async function cmaRequest(path, searchParams = undefined) {
    const url = new URL(`${cmaUrl}${path}`);
    if (searchParams) {
      for (const [key, value] of Object.entries(searchParams)) {
        if (value == null) continue;
        if (Array.isArray(value)) {
          for (const entry of value) {
            url.searchParams.append(key, String(entry));
          }
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const cmaRequestEffect = Effect.gen(function* () {
        const { response, body } = yield* requestJson(url, {
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            "X-Api-Version": "3",
          },
        });

        const rateLimitError =
          response.status === 429 ||
          (Array.isArray(body?.data) && body.data.some((entry) => entry?.attributes?.code === "RATE_LIMIT_EXCEEDED"));

        if (response.ok && !body.errors) {
          return body;
        }

        if (rateLimitError) {
          yield* Effect.fail(
            new DatoRateLimitError({
              message: `Dato CMA request exhausted rate-limit retries for ${url.pathname}`,
              resetSeconds: Number(body?.data?.[0]?.attributes?.details?.reset ?? 1),
              cause: body.errors ?? body,
            }),
          );
        }

        yield* Effect.fail(
          new DatoApiError({
            message: `Dato CMA request failed: ${JSON.stringify(body.errors ?? body, null, 2)}`,
            cause: body.errors ?? body,
          }),
        );
      }).pipe(
      Effect.catchAll((error) => {
        if (error instanceof DatoRateLimitError) {
          return Effect.logWarning(
            `Dato CMA rate limited for ${url.pathname}; retrying in ${Math.max(error.resetSeconds ?? 1, 1)}s`,
          ).pipe(
            Effect.zipRight(Effect.sleep(Math.max(error.resetSeconds ?? 1, 1) * 1000)),
            Effect.zipRight(Effect.fail(error)),
          );
        }
        return Effect.fail(error);
      }),
      Effect.retry({
        while: (error) => error instanceof DatoRateLimitError,
        times: 4,
      }),
    );

    return Effect.runPromise(cmaRequestEffect);
  }

  async function listItemsByType(type, { limit = 20, offset = 0 } = {}) {
    const body = await cmaRequest("/items", {
      "page[limit]": limit,
      "page[offset]": offset,
      "filter[type]": type,
    });
    return body.data ?? [];
  }

  async function* listItemsPagedIterator({
    nested = false,
    pageLimit = nested ? 30 : 500,
    ...filters
  } = {}) {
    let offset = 0;

    while (true) {
      const body = await cmaRequest("/items", {
        ...filters,
        nested,
        "page[limit]": pageLimit,
        "page[offset]": offset,
      });
      const page = body.data ?? [];

      for (const item of page) {
        itemCache.set(item.id, item);
        yield item;
      }

      if (page.length < pageLimit) {
        break;
      }

      offset += page.length;
    }
  }

  async function listAllItems(options = {}) {
    const items = [];
    for await (const item of listItemsPagedIterator(options)) {
      items.push(item);
    }
    return items;
  }

  async function getItem(id) {
    if (itemCache.has(id)) return itemCache.get(id);
    const body = await cmaRequest(`/items/${encodeURIComponent(id)}`);
    itemCache.set(id, body.data);
    return body.data;
  }

  async function getItems(ids) {
    if (!ids.length) return [];
    const cached = [];
    const missing = [];
    for (const id of ids) {
      if (itemCache.has(id)) cached.push(itemCache.get(id));
      else missing.push(id);
    }
    if (missing.length === 0) return cached;
    const body = await cmaRequest("/items", {
      "page[limit]": missing.length,
      "filter[ids]": missing.join(","),
    });
    for (const item of body.data ?? []) {
      itemCache.set(item.id, item);
      cached.push(item);
    }
    return ids.map((id) => itemCache.get(id)).filter(Boolean);
  }

  async function getItemTypes() {
    if (itemTypeCache.size > 0) return itemTypeCache;
    const body = await cmaRequest("/item-types", {
      "page[limit]": 200,
    });
    for (const itemType of body.data ?? []) {
      itemTypeCache.set(itemType.id, itemType.attributes.api_key);
    }
    return itemTypeCache;
  }

  async function getItemTypeApiKey(itemTypeId) {
    const itemTypes = await getItemTypes();
    return itemTypes.get(itemTypeId) ?? null;
  }

  async function getUpload(id) {
    if (uploadCache.has(id)) return uploadCache.get(id);
    const body = await cmaRequest(`/uploads/${encodeURIComponent(id)}`);
    uploadCache.set(id, body.data);
    return body.data;
  }

  async function getUploads(ids) {
    if (!ids.length) return [];
    return Effect.runPromise(
      Effect.forEach(ids, (id) => Effect.tryPromise(() => getUpload(id)), {
        concurrency: 8,
      }),
    );
  }

  async function* listUploadsPagedIterator({ pageLimit = 500 } = {}) {
    let offset = 0;

    while (true) {
      const body = await cmaRequest("/uploads", {
        "page[limit]": pageLimit,
        "page[offset]": offset,
      });
      const page = body.data ?? [];

      for (const upload of page) {
        uploadCache.set(upload.id, upload);
        yield upload;
      }

      if (page.length < pageLimit) {
        break;
      }

      offset += page.length;
    }
  }

  async function listAllUploads(options = {}) {
    const uploads = [];
    for await (const upload of listUploadsPagedIterator(options)) {
      uploads.push(upload);
    }
    return uploads;
  }

  async function getSite() {
    const body = await cmaRequest("/site");
    return body.data;
  }

  return {
    query,
    cmaRequest,
    listItemsByType,
    listItemsPagedIterator,
    listAllItems,
    getItem,
    getItems,
    getItemTypes,
    getItemTypeApiKey,
    getUpload,
    getUploads,
    listUploadsPagedIterator,
    listAllUploads,
    getSite,
  };
}
