/**
 * Auto-generates an agent-cms ImportSchemaInput from a DatoCMS project
 * by reading its CMA API. Replaces hand-written schema files.
 */

const FIELD_TYPE_MAP = {
  string: "string",
  text: "text",
  boolean: "boolean",
  integer: "integer",
  float: "float",
  date: "date",
  date_time: "date_time",
  slug: "slug",
  color: "color",
  json: "json",
  file: "media",
  gallery: "media_gallery",
  video: "video",
  link: "link",
  links: "links",
  structured_text: "structured_text",
  rich_text: "rich_text",
  seo: "seo",
  lat_lon: "lat_lon",
};

/**
 * Generates an ImportSchemaInput object from a DatoCMS project.
 *
 * @param {ReturnType<import('./datocms.mjs').createDatoClient>} datoClient
 * @returns {Promise<import('../../src/services/input-schemas.ts').ImportSchemaInput>}
 */
export async function generateSchema(datoClient) {
  // Fetch site for locales
  const site = await datoClient.getSite();
  const siteLocales = site.attributes?.locales ?? [];

  // Fetch all item types (populates internal cache too)
  const itemTypeMap = await datoClient.getItemTypes();

  // Build id → api_key lookup from the cache
  const itemTypeIdToApiKey = new Map(itemTypeMap.entries());

  // Fetch full item type objects for metadata (singleton, modular_block, etc.)
  const itemTypesResponse = await datoClient.cmaRequest("/item-types", {
    "page[limit]": 200,
  });
  const itemTypes = itemTypesResponse.data ?? [];

  // Build field id → api_key lookup for slug_title_field_id resolution
  const fieldIdToApiKey = new Map();

  // Fetch fields for each item type
  const itemTypeFields = new Map();
  for (const itemType of itemTypes) {
    const fieldsResponse = await datoClient.cmaRequest(
      `/item-types/${itemType.id}/fields`,
    );
    const fields = fieldsResponse.data ?? [];
    itemTypeFields.set(itemType.id, fields);
    for (const field of fields) {
      fieldIdToApiKey.set(field.id, field.attributes.api_key);
    }
  }

  // Build models
  const models = [];

  for (const itemType of itemTypes) {
    const attrs = itemType.attributes;
    const fields = itemTypeFields.get(itemType.id) ?? [];

    // Sort fields by position
    const sortedFields = [...fields].sort(
      (a, b) => (a.attributes.position ?? 0) - (b.attributes.position ?? 0),
    );

    const mappedFields = [];

    for (const field of sortedFields) {
      const fa = field.attributes;

      // Skip unsupported field types
      if (fa.field_type === "single_block") {
        continue;
      }

      const agentFieldType = FIELD_TYPE_MAP[fa.field_type];
      if (!agentFieldType) {
        console.warn(
          `[schema-codegen] Unmapped field type "${fa.field_type}" on ${attrs.api_key}.${fa.api_key} — skipping`,
        );
        continue;
      }

      // Map validators
      const validators = {};
      const datoValidators = fa.validators ?? {};

      if (datoValidators.required != null) {
        validators.required = true;
      }

      if (datoValidators.slug_title_field_id != null) {
        const sourceApiKey = fieldIdToApiKey.get(
          datoValidators.slug_title_field_id,
        );
        if (sourceApiKey) {
          validators.slug_source = sourceApiKey;
        }
      }

      if (datoValidators.items_item_type?.item_types?.length) {
        validators.items_item_type =
          datoValidators.items_item_type.item_types.map(
            (id) => itemTypeIdToApiKey.get(id) ?? id,
          );
      }

      if (datoValidators.item_item_type?.item_types?.length) {
        validators.item_item_type =
          datoValidators.item_item_type.item_types.map(
            (id) => itemTypeIdToApiKey.get(id) ?? id,
          );
      }

      if (datoValidators.structured_text_blocks?.item_types?.length) {
        validators.structured_text_blocks =
          datoValidators.structured_text_blocks.item_types.map(
            (id) => itemTypeIdToApiKey.get(id) ?? id,
          );
      }

      if (datoValidators.rich_text_blocks?.item_types?.length) {
        validators.rich_text_blocks =
          datoValidators.rich_text_blocks.item_types.map(
            (id) => itemTypeIdToApiKey.get(id) ?? id,
          );
      }

      if (datoValidators.enum?.values?.length) {
        validators.enum = datoValidators.enum.values;
      }

      if (datoValidators.length != null) {
        const lengthValidator = {};
        if (datoValidators.length.min != null) {
          lengthValidator.min = datoValidators.length.min;
        }
        if (datoValidators.length.max != null) {
          lengthValidator.max = datoValidators.length.max;
        }
        if (Object.keys(lengthValidator).length > 0) {
          validators.length = lengthValidator;
        }
      }

      mappedFields.push({
        label: fa.label,
        apiKey: fa.api_key,
        fieldType: agentFieldType,
        position: fa.position ?? 0,
        localized: fa.localized ?? false,
        validators,
        hint: fa.hint ?? null,
      });
    }

    models.push({
      name: attrs.name,
      apiKey: attrs.api_key,
      isBlock: attrs.modular_block ?? false,
      singleton: attrs.singleton ?? false,
      sortable: attrs.sortable ?? false,
      tree: attrs.tree ?? false,
      hasDraft: true,
      fields: mappedFields,
    });
  }

  // Build locales
  const locales = siteLocales.map((code, index) => ({
    code: code.replace(/-/g, "_"),
    position: index,
    fallbackLocale: null,
  }));

  return {
    version: 1,
    locales,
    models,
  };
}
