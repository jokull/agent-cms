export async function fetchDatoSchemaMetadata(datoClient) {
  const itemTypesResponse = await datoClient.cmaRequest("/item-types", {
    "page[limit]": 200,
  });
  const allItemTypes = itemTypesResponse.data ?? [];

  const itemTypeIdToApiKey = new Map();
  const itemTypes = allItemTypes.map((itemType) => {
    const apiKey = itemType.attributes.api_key;
    itemTypeIdToApiKey.set(itemType.id, apiKey);
    return {
      id: itemType.id,
      apiKey,
      modularBlock: itemType.attributes.modular_block ?? false,
      singleton: itemType.attributes.singleton ?? false,
      sortable: itemType.attributes.sortable ?? false,
      tree: itemType.attributes.tree ?? false,
      name: itemType.attributes.name ?? apiKey,
    };
  });

  const fieldMap = new Map();

  for (const itemType of allItemTypes) {
    const fieldsResponse = await datoClient.cmaRequest(`/item-types/${itemType.id}/fields`);
    const fields = (fieldsResponse.data ?? []).map((field) => ({
      api_key: field.attributes.api_key,
      field_type: field.attributes.field_type,
      localized: field.attributes.localized ?? false,
      validators: field.attributes.validators ?? {},
      label: field.attributes.label,
      position: field.attributes.position ?? 0,
    }));
    fieldMap.set(itemType.attributes.api_key, fields);
  }

  return {
    itemTypes,
    itemTypeIdToApiKey,
    fieldMap,
  };
}
