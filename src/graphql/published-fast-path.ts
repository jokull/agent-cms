import { Effect, Layer } from "effect";
import { SqlClient } from "@effect/sql";
import {
  Kind,
  parse,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
  type ValueNode,
} from "graphql";
import type { FieldRow, ModelRow, ParsedFieldRow } from "../db/row-types.js";
import { parseFieldValidators } from "../db/row-types.js";
import { getLinkTargets } from "../db/validators.js";
import { compileOrderBy, type FilterCompilerOpts } from "./filter-compiler.js";
import { decodeJsonIfString } from "../json.js";
import { pluralize, toCamelCase, toTypeName } from "./gql-utils.js";

interface GraphqlFastPathRequest {
  readonly query: string;
  readonly variables?: Record<string, unknown>;
  readonly operationName?: string | null;
}

type SelectionPlan =
  | { readonly kind: "id"; readonly responseKey: string }
  | { readonly kind: "scalar"; readonly responseKey: string; readonly field: ParsedFieldRow }
  | {
      readonly kind: "link";
      readonly responseKey: string;
      readonly field: ParsedFieldRow;
      readonly target: FastPathModelMeta;
      readonly nested: readonly SelectionPlan[];
    };

type IntArgPlan =
  | { readonly kind: "const"; readonly value: number }
  | { readonly kind: "var"; readonly name: string }
  | null;

type StringListArgPlan =
  | { readonly kind: "const"; readonly value: string[] }
  | { readonly kind: "var"; readonly name: string }
  | null
  | undefined;

type RootPlan =
  | { readonly kind: "meta"; readonly responseKey: string; readonly meta: FastPathModelMeta }
  | {
      readonly kind: "singleton" | "list";
      readonly responseKey: string;
      readonly meta: FastPathModelMeta;
      readonly orderBy: StringListArgPlan;
      readonly first: IntArgPlan;
      readonly skip: IntArgPlan;
      readonly objectSql: string;
    };

interface CompiledFastPathPlan {
  readonly roots: readonly RootPlan[];
}

interface FastPathModelMeta {
  readonly model: ModelRow;
  readonly tableName: string;
  readonly singleName: string;
  readonly listName: string;
  readonly metaName: string;
  readonly fieldsByGqlName: Map<string, ParsedFieldRow>;
  readonly fieldNameMap: Record<string, string>;
  readonly localizedCamelKeys: Set<string>;
  readonly localizedDbColumns: string[];
  readonly jsonArrayFields: Set<string>;
  readonly jsonObjectIdFields: Set<string>;
}

interface PublishedFastPathMetadata {
  readonly modelsByRootField: Map<string, FastPathModelMeta>;
}

function isSupportedQueryText(query: string): boolean {
  return !query.includes("...")
    && !query.includes("content")
    && !query.includes("defaultSeo")
    && !query.includes("_seoMetaTags")
    && !query.includes("responsiveImage")
    && !query.includes(" blocks ")
    && !query.includes(" blocks{")
    && !query.includes(" blocks\n")
    && !query.includes("value {")
    && !query.includes("filter:")
    && !query.includes(" id:")
    && !query.includes("locale:")
    && !query.includes("fallbackLocales:")
    && !query.includes("excludeInvalid:");
}

function buildFragments(document: DocumentNode) {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }
  return fragments;
}

function getOperation(document: DocumentNode, operationName?: string | null): OperationDefinitionNode | null {
  const operations = document.definitions.filter((definition): definition is OperationDefinitionNode => definition.kind === Kind.OPERATION_DEFINITION);
  if (operations.length === 0) return null;
  if (!operationName) return operations.length === 1 ? operations[0] : null;
  return operations.find((operation) => operation.name?.value === operationName) ?? null;
}

function collectFields(selectionSet: FieldNode["selectionSet"], fragments: Map<string, FragmentDefinitionNode>): FieldNode[] {
  if (!selectionSet) return [];
  const result: FieldNode[] = [];
  for (const selection of selectionSet.selections) {
    switch (selection.kind) {
      case Kind.FIELD:
        result.push(selection);
        break;
      case Kind.INLINE_FRAGMENT:
        return [];
      case Kind.FRAGMENT_SPREAD: {
        const fragment = fragments.get(selection.name.value);
        if (!fragment) return [];
        for (const nested of fragment.selectionSet.selections) {
          if (nested.kind !== Kind.FIELD) return [];
          result.push(nested);
        }
        break;
      }
    }
  }
  return result;
}

function getArgumentValueNode(fieldNode: FieldNode, name: string): ValueNode | null {
  return fieldNode.arguments?.find((entry) => entry.name.value === name)?.value ?? null;
}

function compileIntArg(fieldNode: FieldNode, name: string): IntArgPlan {
  const value = getArgumentValueNode(fieldNode, name);
  if (!value) return null;
  if (value.kind === Kind.INT) return { kind: "const", value: Number(value.value) };
  if (value.kind === Kind.VARIABLE) return { kind: "var", name: value.name.value };
  return null;
}

function compileStringListArg(fieldNode: FieldNode, name: string): StringListArgPlan {
  const value = getArgumentValueNode(fieldNode, name);
  if (!value) return undefined;
  if (value.kind === Kind.LIST) {
    const result: string[] = [];
    for (const item of value.values) {
      if (item.kind !== Kind.ENUM && item.kind !== Kind.STRING) return null;
      result.push(item.value);
    }
    return { kind: "const", value: result };
  }
  if (value.kind === Kind.VARIABLE) return { kind: "var", name: value.name.value };
  return null;
}

function resolveIntArg(plan: IntArgPlan, variables: Record<string, unknown>): number | null {
  if (!plan) return null;
  if (plan.kind === "const") return plan.value;
  const value = variables[plan.name];
  return typeof value === "number" ? value : null;
}

function resolveStringListArg(plan: StringListArgPlan, variables: Record<string, unknown>): string[] | undefined {
  if (plan === undefined || plan === null) return undefined;
  if (plan.kind === "const") return plan.value;
  const value = variables[plan.name];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function buildFilterOpts(meta: FastPathModelMeta): FilterCompilerOpts {
  return {
    fieldIsLocalized: (fieldName) => meta.localizedCamelKeys.has(fieldName),
    fieldNameMap: meta.fieldNameMap,
    localizedDbColumns: meta.localizedDbColumns,
    jsonArrayFields: meta.jsonArrayFields,
    jsonObjectIdFields: meta.jsonObjectIdFields,
  };
}

function sqlQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return decodeJsonIfString(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSimpleScalarField(field: ParsedFieldRow): boolean {
  return !field.localized && ![
    "link",
    "links",
    "structured_text",
    "seo",
    "media",
    "media_gallery",
    "video",
    "lat_lon",
    "color",
  ].includes(field.field_type);
}

function buildSelectionPlan(
  meta: FastPathModelMeta,
  fieldNode: FieldNode,
  metadata: PublishedFastPathMetadata,
  fragments: Map<string, FragmentDefinitionNode>,
): readonly SelectionPlan[] | null {
  const selectedFields = collectFields(fieldNode.selectionSet, fragments);
  if (selectedFields.length === 0) return null;

  const plan: SelectionPlan[] = [];
  for (const selectedField of selectedFields) {
    const responseKey = selectedField.alias?.value ?? selectedField.name.value;

    if (selectedField.name.value === "id") {
      if (selectedField.selectionSet) return null;
      plan.push({ kind: "id", responseKey });
      continue;
    }

    if (selectedField.name.value === "__typename" || selectedField.name.value.startsWith("_")) {
      return null;
    }

    const field = meta.fieldsByGqlName.get(selectedField.name.value);
    if (!field) return null;

    if (field.field_type === "link") {
      if (!selectedField.selectionSet) return null;
      const targets = getLinkTargets(field.validators);
      if (!targets || targets.length !== 1) return null;
      const targetMeta = metadata.modelsByRootField.get(toCamelCase(targets[0]));
      if (!targetMeta) return null;
      const nested = buildSelectionPlan(targetMeta, selectedField, metadata, fragments);
      if (!nested || nested.some((selection) => selection.kind === "link")) return null;
      plan.push({ kind: "link", responseKey, field, target: targetMeta, nested });
      continue;
    }

    if (selectedField.selectionSet || !isSimpleScalarField(field)) return null;
    plan.push({ kind: "scalar", responseKey, field });
  }

  return plan;
}

function buildSnapshotValueSql(tableAlias: string, field: ParsedFieldRow) {
  const raw = `json_extract(${tableAlias}."_published_snapshot", '$.${field.api_key}')`;
  if (field.field_type === "boolean") {
    return `CASE ${raw} WHEN 1 THEN json('true') WHEN 0 THEN json('false') ELSE NULL END`;
  }
  return raw;
}

function buildJsonObjectSql(tableAlias: string, plan: readonly SelectionPlan[]): string | null {
  const parts: string[] = [];
  for (const selection of plan) {
    switch (selection.kind) {
      case "id":
        parts.push(`${sqlQuote(selection.responseKey)}, ${tableAlias}.id`);
        break;
      case "scalar":
        parts.push(`${sqlQuote(selection.responseKey)}, ${buildSnapshotValueSql(tableAlias, selection.field)}`);
        break;
      case "link": {
        const nestedSql = buildJsonObjectSql("linked", selection.nested);
        if (!nestedSql) return null;
        parts.push(
          `${sqlQuote(selection.responseKey)}, (` +
          `SELECT ${nestedSql} FROM "${selection.target.tableName}" linked ` +
          `WHERE linked.id = json_extract(${tableAlias}."_published_snapshot", '$.${selection.field.api_key}') ` +
          `AND linked."_status" IN ('published', 'updated') LIMIT 1)`
        );
        break;
      }
    }
  }
  return parts.length > 0 ? `json_object(${parts.join(", ")})` : null;
}

async function loadMetadata(sqlLayer: Layer.Layer<SqlClient.SqlClient>): Promise<PublishedFastPathMetadata> {
  const loaded = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const models = yield* sql.unsafe<ModelRow>("SELECT * FROM models WHERE is_block = 0 ORDER BY created_at");
      const fields = yield* sql.unsafe<FieldRow>("SELECT * FROM fields ORDER BY position");
      return { models, fields };
    }).pipe(Effect.provide(sqlLayer), Effect.orDie),
  );

  const fieldsByModelId = new Map<string, ParsedFieldRow[]>();
  for (const field of loaded.fields) {
    const parsed = parseFieldValidators(field);
    const list = fieldsByModelId.get(field.model_id) ?? [];
    list.push(parsed);
    fieldsByModelId.set(field.model_id, list);
  }

  const modelsByRootField = new Map<string, FastPathModelMeta>();
  for (const model of loaded.models) {
    const fields = fieldsByModelId.get(model.id) ?? [];
    const baseTypeName = toTypeName(model.api_key);
    const fieldsByGqlName = new Map<string, ParsedFieldRow>();
    const fieldNameMap: Record<string, string> = {};
    const localizedCamelKeys = new Set<string>();
    const jsonArrayFields = new Set<string>();
    const jsonObjectIdFields = new Set<string>();

    for (const field of fields) {
      const gqlName = toCamelCase(field.api_key);
      fieldsByGqlName.set(gqlName, field);
      fieldNameMap[gqlName] = field.api_key;
      if (field.localized) localizedCamelKeys.add(gqlName);
      if (field.field_type === "links" || field.field_type === "media_gallery") jsonArrayFields.add(gqlName);
      if (field.field_type === "media") jsonObjectIdFields.add(gqlName);
    }

    const meta: FastPathModelMeta = {
      model,
      tableName: `content_${model.api_key}`,
      singleName: toCamelCase(model.api_key),
      listName: `all${pluralize(baseTypeName)}`,
      metaName: `_all${pluralize(baseTypeName)}Meta`,
      fieldsByGqlName,
      fieldNameMap,
      localizedCamelKeys,
      localizedDbColumns: fields.filter((field) => field.localized).map((field) => field.api_key),
      jsonArrayFields,
      jsonObjectIdFields,
    };

    modelsByRootField.set(meta.singleName, meta);
    modelsByRootField.set(meta.listName, meta);
    modelsByRootField.set(meta.metaName, meta);
  }

  return { modelsByRootField };
}

function compilePlan(request: GraphqlFastPathRequest, metadata: PublishedFastPathMetadata): CompiledFastPathPlan | null {
  if (!isSupportedQueryText(request.query)) return null;

  const document = parse(request.query);
  const operation = getOperation(document, request.operationName);
  if (!operation || operation.operation !== "query") return null;

  const fragments = buildFragments(document);
  const roots: RootPlan[] = [];

  for (const selection of operation.selectionSet.selections) {
    if (selection.kind !== Kind.FIELD) return null;
    const responseKey = selection.alias?.value ?? selection.name.value;
    const meta = metadata.modelsByRootField.get(selection.name.value);
    if (!meta) return null;

    if (selection.name.value === meta.metaName) {
      if (selection.arguments && selection.arguments.length > 0) return null;
      roots.push({ kind: "meta", responseKey, meta });
      continue;
    }

    const selectionPlan = buildSelectionPlan(meta, selection, metadata, fragments);
    const objectSql = selectionPlan ? buildJsonObjectSql("row_data", selectionPlan) : null;
    if (!selectionPlan || !objectSql) return null;

    if (selection.name.value === meta.listName) {
      const first = compileIntArg(selection, "first");
      const skip = compileIntArg(selection, "skip");
      const orderBy = compileStringListArg(selection, "orderBy");
      if (orderBy === null) return null;
      roots.push({
        kind: "list",
        responseKey,
        meta,
        orderBy,
        first,
        skip,
        objectSql,
      });
      continue;
    }

    if (selection.arguments && selection.arguments.length > 0 && meta.model.singleton !== 1) return null;
    roots.push({
      kind: "singleton",
      responseKey,
      meta,
      orderBy: undefined,
      first: null,
      skip: null,
      objectSql,
    });
  }

  return { roots };
}

async function runSql<A extends object>(
  sqlLayer: Layer.Layer<SqlClient.SqlClient>,
  sqlText: string,
  params: readonly unknown[],
): Promise<readonly A[]> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.unsafe<A>(sqlText, params);
    }).pipe(Effect.provide(sqlLayer), Effect.orDie),
  );
}

function buildRootResultSql(root: RootPlan, variables: Record<string, unknown>) {
  if (root.kind === "meta") {
    return {
      sql: `(SELECT json_object('count', COUNT(*)) FROM "${root.meta.tableName}" WHERE "_status" IN ('published', 'updated'))`,
      params: [] as unknown[],
    };
  }

  if (root.kind === "list") {
    const orderBy = resolveStringListArg(root.orderBy, variables);
    const compiledOrderBy = compileOrderBy(orderBy ?? (typeof root.meta.model.ordering === "string" ? [root.meta.model.ordering] : undefined), buildFilterOpts(root.meta));
    let innerSql = `SELECT ${root.objectSql} AS item_json FROM "${root.meta.tableName}" row_data WHERE row_data."_status" IN ('published', 'updated')`;
    if (compiledOrderBy) {
      innerSql += ` ORDER BY ${compiledOrderBy}`;
    }
    const params: unknown[] = [Math.min(resolveIntArg(root.first, variables) ?? 20, 500)];
    innerSql += ` LIMIT ?`;
    const skip = resolveIntArg(root.skip, variables);
    if (skip && skip > 0) {
      innerSql += ` OFFSET ?`;
      params.push(skip);
    }
    return {
      sql: `(SELECT COALESCE(json_group_array(json(item_json)), '[]') FROM (${innerSql}) ordered_rows)`,
      params,
    };
  }

  return {
    sql: `(SELECT ${root.objectSql} FROM "${root.meta.tableName}" row_data WHERE row_data."_status" IN ('published', 'updated') LIMIT 1)`,
    params: [] as unknown[],
  };
}

async function executePlan(
  sqlLayer: Layer.Layer<SqlClient.SqlClient>,
  plan: CompiledFastPathPlan,
  variables: Record<string, unknown>,
): Promise<{ data: Record<string, unknown> }> {
  const jsonParts: string[] = [];
  const params: unknown[] = [];

  for (const root of plan.roots) {
    const resultSql = buildRootResultSql(root, variables);
    jsonParts.push(`${sqlQuote(root.responseKey)}, json(COALESCE(${resultSql.sql}, 'null'))`);
    params.push(...resultSql.params);
  }

  const rows = await runSql<{ result: string }>(
    sqlLayer,
    `SELECT json_object(${jsonParts.join(", ")}) AS result`,
    params,
  );
  const data = parseJsonValue(rows[0]?.result);
  return { data: isRecord(data) ? data : {} };
}

export function createPublishedFastPath(sqlLayer: Layer.Layer<SqlClient.SqlClient>) {
  let metadataPromise: Promise<PublishedFastPathMetadata> | null = null;
  const planCache = new Map<string, CompiledFastPathPlan | null>();
  const planCacheOrder: string[] = [];

  function getMetadata() {
    if (!metadataPromise) {
      metadataPromise = loadMetadata(sqlLayer).catch((error) => {
        metadataPromise = null;
        throw error;
      });
    }
    return metadataPromise;
  }

  function rememberPlan(cacheKey: string, plan: CompiledFastPathPlan | null) {
    planCache.set(cacheKey, plan);
    planCacheOrder.push(cacheKey);
    if (planCacheOrder.length > 128) {
      const oldest = planCacheOrder.shift();
      if (oldest) planCache.delete(oldest);
    }
  }

  async function compile(request: GraphqlFastPathRequest) {
    const cacheKey = `${request.operationName ?? ""}\n${request.query}`;
    if (planCache.has(cacheKey)) {
      return planCache.get(cacheKey) ?? null;
    }
    const plan = compilePlan(request, await getMetadata());
    rememberPlan(cacheKey, plan);
    return plan;
  }

  return {
    async tryExecute(request: GraphqlFastPathRequest, options: { includeDrafts: boolean; excludeInvalid: boolean }) {
      if (options.includeDrafts || options.excludeInvalid) return null;
      const plan = await compile(request);
      if (!plan) return null;
      return executePlan(sqlLayer, plan, request.variables ?? {});
    },
  };
}
