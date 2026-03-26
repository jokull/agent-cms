/**
 * Declarative HttpApi definition for the agent-cms REST API.
 *
 * Composes all endpoint groups and generates the OpenAPI 3.1.0 spec
 * via `OpenApi.fromApi()`. The spec is served at /openapi.json by
 * the router.
 */
import { HttpApi, OpenApi } from "@effect/platform";
import { modelsGroup } from "./models.js";
import { fieldsGroup } from "./fields.js";
import { recordsGroup } from "./records.js";
import { assetsGroup } from "./assets.js";
import { localesGroup } from "./locales.js";
import { schemaGroup } from "./schema-io.js";
import { searchGroup } from "./search.js";
import { tokensGroup } from "./tokens.js";
import { previewTokensGroup } from "./preview-tokens.js";
import { pathsGroup } from "./paths.js";

export const cmsApi = HttpApi.make("agent-cms")
  .annotate(OpenApi.Title, "Agent CMS API")
  .annotate(OpenApi.Version, "1.0.0")
  .annotate(OpenApi.Description, "Headless CMS REST API for content management")
  .add(modelsGroup)
  .add(fieldsGroup)
  .add(recordsGroup)
  .add(assetsGroup)
  .add(localesGroup)
  .add(schemaGroup)
  .add(searchGroup)
  .add(tokensGroup)
  .add(previewTokensGroup)
  .add(pathsGroup);

/** Pre-generated OpenAPI 3.1.0 specification */
export const openApiSpec = OpenApi.fromApi(cmsApi);
