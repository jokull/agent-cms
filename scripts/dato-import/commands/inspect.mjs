import { resolve } from "node:path";

import { createDatoClient } from "../core/datocms.mjs";
import { writeJson } from "../core/runtime.mjs";

export async function runInspect({
  outDir = resolve(process.cwd(), "scripts/dato-import/out"),
  token = process.env.DATOCMS_API_TOKEN,
} = {}) {
  const dato = createDatoClient({ token });
  const site = await dato.getSite();
  const itemTypes = await dato.cmaRequest("/item-types", {
    "page[limit]": 500,
  });

  const summary = {
    site: {
      id: site.id,
      name: site.attributes?.name ?? null,
      locales: site.attributes?.locales ?? [],
      theme: site.attributes?.theme ?? null,
    },
    itemTypes: (itemTypes.data ?? []).map((itemType) => ({
      id: itemType.id,
      apiKey: itemType.attributes?.api_key ?? null,
      name: itemType.attributes?.name ?? null,
      singleton: Boolean(itemType.attributes?.singleton),
      modularBlock: Boolean(itemType.attributes?.modular_block),
      sortable: Boolean(itemType.attributes?.sortable),
      tree: Boolean(itemType.attributes?.tree),
      orderingDirection: itemType.attributes?.ordering_direction ?? null,
    })),
  };

  const outPath = await writeJson(outDir, "inspect.json", summary);
  return { summary, outPath };
}
