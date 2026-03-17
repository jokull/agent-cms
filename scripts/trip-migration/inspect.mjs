import { datoQuery, writeJson } from "./common.mjs";

const COUNTS_QUERY = `
  query MigrationInspect {
    _site { locales }
    _allArticlesMeta { count }
    _allLocationsMeta { count }
    _allGuidesMeta { count }
    _allPlacesMeta { count }
    _allToursMeta { count }
    _allTripsMeta { count }
  }
`;

const data = await datoQuery(COUNTS_QUERY);
const outPath = await writeJson("inspect.json", data);

console.log("Trip migration inspection");
console.log(`  locales: ${data._site.locales.join(", ")}`);
console.log(`  articles: ${data._allArticlesMeta.count}`);
console.log(`  locations: ${data._allLocationsMeta.count}`);
console.log(`  guides: ${data._allGuidesMeta.count}`);
console.log(`  places: ${data._allPlacesMeta.count}`);
console.log(`  tours: ${data._allToursMeta.count}`);
console.log(`  trips: ${data._allTripsMeta.count}`);
console.log(`Saved ${outPath}`);
