import { Data, Effect } from "effect";

class AgentCmsRequestError extends Data.TaggedError("AgentCmsRequestError") {}
class AgentCmsResponseError extends Data.TaggedError("AgentCmsResponseError") {}

export function createAgentCmsClient({ cmsUrl }) {
  function requestEffect(method, path, body) {
    return Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(`${cmsUrl}${path}`, {
            method,
            headers: { "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        catch: (cause) => new AgentCmsRequestError({ message: `${method} ${path} failed to send`, cause }),
      }).pipe(Effect.retry({ times: 2 }));

      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) => new AgentCmsResponseError({ message: `${method} ${path} body read failed`, cause }),
      });

      let parsed;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }

      return {
        ok: response.ok,
        status: response.status,
        body: parsed,
      };
    });
  }

  function jsonEffect(method, path, body) {
    return requestEffect(method, path, body).pipe(
      Effect.flatMap((result) =>
        result.ok
          ? Effect.succeed(result.body)
          : Effect.fail(
              new AgentCmsResponseError({
                message: `${method} ${path} failed (${result.status}): ${JSON.stringify(result.body)}`,
                cause: result.body,
              }),
            ),
      ),
    );
  }

  async function request(method, path, body) {
    return Effect.runPromise(requestEffect(method, path, body));
  }

  async function json(method, path, body) {
    return Effect.runPromise(jsonEffect(method, path, body));
  }

  async function listModels() {
    return json("GET", "/api/models");
  }

  async function listFields(modelId) {
    return json("GET", `/api/models/${modelId}/fields`);
  }

  async function listLocales() {
    return json("GET", "/api/locales");
  }

  async function getExistingModelMap() {
    const models = await listModels();
    return new Map(models.map((model) => [model.api_key ?? model.apiKey, model]));
  }

  async function getExistingFieldMap(modelId) {
    const fields = await listFields(modelId);
    return new Map(fields.map((field) => [field.api_key ?? field.apiKey, field]));
  }

  async function ensureLocale(code, fallbackLocaleId = null, position = undefined) {
    const locales = await listLocales();
    const existing = locales.find((locale) => locale.code === code);
    if (existing) return existing;
    return json("POST", "/api/locales", {
      code,
      ...(position === undefined ? {} : { position }),
      ...(fallbackLocaleId == null ? {} : { fallbackLocaleId }),
    });
  }

  async function ensureModel(definition) {
    const models = await getExistingModelMap();
    const existing = models.get(definition.apiKey);
    if (existing) {
      if (definition.singleton !== undefined && Boolean(existing.singleton) !== Boolean(definition.singleton)) {
        return json("PATCH", `/api/models/${existing.id}`, {
          singleton: Boolean(definition.singleton),
        });
      }
      return existing;
    }
    return json("POST", "/api/models", definition);
  }

  async function ensureField(modelId, definition) {
    const fields = await getExistingFieldMap(modelId);
    const existing = fields.get(definition.apiKey);
    if (existing) {
      if (definition.localized !== undefined && Boolean(existing.localized) !== Boolean(definition.localized)) {
        return json("PATCH", `/api/models/${modelId}/fields/${existing.id}`, {
          localized: Boolean(definition.localized),
        });
      }
      return existing;
    }
    return json("POST", `/api/models/${modelId}/fields`, definition);
  }

  async function upsertRecord(modelApiKey, id, data, { publish = true, overrides } = {}) {
    const createResult = await request("POST", "/api/records", {
      id,
      modelApiKey,
      data,
      ...(overrides ? { overrides } : {}),
    });

    if (!createResult.ok && createResult.status !== 409) {
      throw new Error(`POST /api/records failed (${createResult.status}): ${JSON.stringify(createResult.body)}`);
    }

    if (createResult.status === 409) {
      const patchResult = await request("PATCH", `/api/records/${id}`, {
        modelApiKey,
        data,
        ...(overrides ? { overrides } : {}),
      });
      if (!patchResult.ok) {
        throw new Error(`PATCH /api/records/${id} failed (${patchResult.status}): ${JSON.stringify(patchResult.body)}`);
      }
    }

    if (publish) {
      const publishResult = await request("POST", `/api/records/${id}/publish?modelApiKey=${modelApiKey}`);
      if (!publishResult.ok && publishResult.status !== 409) {
        throw new Error(`Publish ${modelApiKey}/${id} failed (${publishResult.status}): ${JSON.stringify(publishResult.body)}`);
      }
    }
  }

  async function publishRecord(modelApiKey, id) {
    const publishResult = await request("POST", `/api/records/${id}/publish?modelApiKey=${modelApiKey}`);
    if (!publishResult.ok && publishResult.status !== 409) {
      throw new Error(`Publish ${modelApiKey}/${id} failed (${publishResult.status}): ${JSON.stringify(publishResult.body)}`);
    }
  }

  async function patchRecordOverrides(modelApiKey, id, overrides) {
    const patchResult = await request("PATCH", `/api/records/${id}`, {
      modelApiKey,
      data: {},
      overrides,
    });
    if (!patchResult.ok) {
      throw new Error(`Patch overrides ${modelApiKey}/${id} failed (${patchResult.status}): ${JSON.stringify(patchResult.body)}`);
    }
  }

  return {
    request,
    requestEffect,
    json,
    jsonEffect,
    listModels,
    listFields,
    listLocales,
    getExistingModelMap,
    getExistingFieldMap,
    ensureLocale,
    ensureModel,
    ensureField,
    upsertRecord,
    publishRecord,
    patchRecordOverrides,
  };
}
