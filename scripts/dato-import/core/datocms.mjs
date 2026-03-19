import { Data, Effect } from "effect";

class DatoRequestError extends Data.TaggedError("DatoRequestError") {}

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
        try: () => fetch(url, init),
        catch: (cause) => new DatoRequestError({ message: `Dato request failed for ${url}`, cause }),
      });
      const body = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: (cause) => new DatoRequestError({ message: `Dato response JSON decode failed for ${url}`, cause }),
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
          new DatoRequestError({
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

    const runAttempt = (attempt) =>
      Effect.gen(function* () {
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

        if (rateLimitError && attempt < 4) {
          const reset = Number(body?.data?.[0]?.attributes?.details?.reset ?? 1);
          yield* Effect.sleep(Math.max(reset, 1) * 1000);
          return yield* runAttempt(attempt + 1);
        }

        yield* Effect.fail(
          new DatoRequestError({
            message: `Dato CMA request failed: ${JSON.stringify(body.errors ?? body, null, 2)}`,
            cause: body.errors ?? body,
          }),
        );
      });

    return Effect.runPromise(runAttempt(0)).catch((error) => {
      if (error instanceof DatoRequestError) {
        throw error;
      }
      throw new Error(`Dato CMA request failed after retries for ${url.pathname}`);
    });
  }

  async function listItemsByType(type, { limit = 20, offset = 0 } = {}) {
    const body = await cmaRequest("/items", {
      "page[limit]": limit,
      "page[offset]": offset,
      "filter[type]": type,
    });
    return body.data ?? [];
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

  async function getSite() {
    const body = await cmaRequest("/site");
    return body.data;
  }

  return {
    query,
    cmaRequest,
    listItemsByType,
    getItem,
    getItems,
    getItemTypes,
    getItemTypeApiKey,
    getUpload,
    getUploads,
    getSite,
  };
}
