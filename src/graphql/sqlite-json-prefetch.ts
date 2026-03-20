import type { GraphQLResolveInfo, SelectionNode, SelectionSetNode } from "graphql";
import { getLinkTargets } from "../db/validators.js";
import type { ParsedFieldRow } from "../db/row-types.js";
import { toCamelCase } from "./gql-utils.js";
import type { SchemaBuilderContext } from "./gql-types.js";

interface LinkPrefetchSpec {
  rootFieldApiKey: string;
  sqlExpression: string;
}

function collectSelectionSetFields(
  selectionSet: SelectionSetNode | undefined,
  info: GraphQLResolveInfo,
  names: Set<string>
) {
  if (!selectionSet) return;

  for (const selection of selectionSet.selections) {
    collectSelectionField(selection, info, names);
  }
}

function collectSelectionField(
  selection: SelectionNode,
  info: GraphQLResolveInfo,
  names: Set<string>
) {
  switch (selection.kind) {
    case "Field":
      names.add(selection.name.value);
      return;
    case "InlineFragment":
      collectSelectionSetFields(selection.selectionSet, info, names);
      return;
    case "FragmentSpread": {
      const fragment = info.fragments[selection.name.value];
      collectSelectionSetFields(fragment?.selectionSet, info, names);
      return;
    }
  }
}

function collectImmediateSelectionMapFromSet(
  selectionSet: SelectionSetNode | undefined,
  info: GraphQLResolveInfo,
  result: Map<string, Set<string>>
) {
  if (!selectionSet) return;

  for (const selection of selectionSet.selections) {
    collectImmediateSelectionMapFromNode(selection, info, result);
  }
}

function collectImmediateSelectionMapFromNode(
  selection: SelectionNode,
  info: GraphQLResolveInfo,
  result: Map<string, Set<string>>
) {
  switch (selection.kind) {
    case "Field": {
      const fieldName = selection.name.value;
      let nested = result.get(fieldName);
      if (!nested) {
        nested = new Set<string>();
        result.set(fieldName, nested);
      }
      collectSelectionSetFields(selection.selectionSet, info, nested);
      return;
    }
    case "InlineFragment":
      collectImmediateSelectionMapFromSet(selection.selectionSet, info, result);
      return;
    case "FragmentSpread": {
      const fragment = info.fragments[selection.name.value];
      collectImmediateSelectionMapFromSet(fragment?.selectionSet, info, result);
      return;
    }
  }
}

export function collectImmediateSelectionMap(info: GraphQLResolveInfo) {
  const result = new Map<string, Set<string>>();
  for (const fieldNode of info.fieldNodes) {
    collectImmediateSelectionMapFromSet(fieldNode.selectionSet, info, result);
  }
  return result;
}

function isSimplePrefetchableField(field: ParsedFieldRow) {
  return ![
    "link",
    "links",
    "structured_text",
    "media",
    "media_gallery",
    "seo",
    "lat_lon",
    "color",
    "video",
  ].includes(field.field_type);
}

const METADATA_FIELD_SQL = new Map<string, (targetApiKey: string, tableAlias: string) => string>([
  ["id", (_targetApiKey, tableAlias) => `'id', ${tableAlias}.id`],
  ["_status", (_targetApiKey, tableAlias) => `'_status', ${tableAlias}._status`],
  ["_createdAt", (_targetApiKey, tableAlias) => `'_created_at', ${tableAlias}._created_at`],
  ["_updatedAt", (_targetApiKey, tableAlias) => `'_updated_at', ${tableAlias}._updated_at`],
  ["_publishedAt", (_targetApiKey, tableAlias) => `'_published_at', ${tableAlias}._published_at`],
  ["_firstPublishedAt", (_targetApiKey, tableAlias) => `'_first_published_at', ${tableAlias}._first_published_at`],
  ["_position", (_targetApiKey, tableAlias) => `'_position', ${tableAlias}._position`],
  ["_parentId", (_targetApiKey, tableAlias) => `'_parent_id', ${tableAlias}._parent_id`],
  ["_modelApiKey", (targetApiKey) => `'_modelApiKey', '${targetApiKey}'`],
]);

export function buildLinkPrefetchSpecs(params: {
  ctx: SchemaBuilderContext;
  rootFields: readonly ParsedFieldRow[];
  info: GraphQLResolveInfo;
  tableName: string;
}) {
  const selectionMap = collectImmediateSelectionMap(params.info);
  const specs: LinkPrefetchSpec[] = [];

  for (const rootField of params.rootFields) {
    if (rootField.field_type !== "link") continue;

    const gqlFieldName = toCamelCase(rootField.api_key);
    const nestedSelections = selectionMap.get(gqlFieldName);
    if (!nestedSelections || nestedSelections.size === 0) continue;

    const targets = getLinkTargets(rootField.validators);
    if (!targets || targets.length !== 1) continue;

    const targetApiKey = targets[0];
    const targetModel = params.ctx.models.find((model) => model.api_key === targetApiKey);
    if (!targetModel) continue;

    const targetFields = params.ctx.fieldsByModelId.get(targetModel.id) ?? [];
    const targetFieldByGqlName = new Map(targetFields.map((field) => [toCamelCase(field.api_key), field] as const));
    const jsonParts = [`'id', linked.id`, `'_published_snapshot', linked._published_snapshot`];
    let supported = true;

    for (const nestedSelection of nestedSelections) {
      if (nestedSelection === "__typename") continue;
      if (nestedSelection === "id") continue;

      const metadataSql = METADATA_FIELD_SQL.get(nestedSelection);
      if (metadataSql) {
        jsonParts.push(metadataSql(targetApiKey, "linked"));
        continue;
      }

      const targetField = targetFieldByGqlName.get(nestedSelection);
      if (!targetField || !isSimplePrefetchableField(targetField)) {
        supported = false;
        break;
      }

      jsonParts.push(`'${targetField.api_key}', linked."${targetField.api_key}"`);
    }

    if (!supported) continue;

    specs.push({
      rootFieldApiKey: rootField.api_key,
      sqlExpression: `(SELECT json_object(${jsonParts.join(", ")}) FROM "content_${targetApiKey}" linked WHERE linked.id = "${params.tableName}"."${rootField.api_key}" LIMIT 1) AS "__prefetch_${rootField.api_key}"`,
    });
  }

  return specs;
}
