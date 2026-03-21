import { Effect, Layer } from "effect";
import { SqlClient } from "@effect/sql";
import {
  Kind,
  parse,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
  type SelectionNode,
  type SelectionSetNode,
  type ValueNode,
} from "graphql";
import type { AssetRow, FieldRow, ModelRow, ParsedFieldRow } from "../db/row-types.js";
import { parseFieldValidators } from "../db/row-types.js";
import { getLinkTargets, getLinksTargets } from "../db/validators.js";
import { extractBlockIds, extractInlineBlockIds, extractLinkIds } from "../dast/index.js";
import { compileFilterToSql, compileOrderBy, type FilterCompilerOpts } from "./filter-compiler.js";
import { decodeJsonIfString } from "../json.js";
import { batchResolveLinkedRecordsCached } from "./structured-text-resolver.js";
import { decodeSnapshot, pluralize, toCamelCase, toContentTypeName, toTypeName } from "./gql-utils.js";
import { mergeAssetWithMediaReference, parseMediaFieldReference, parseMediaGalleryReferences } from "../media-field.js";
import type { AssetObject } from "./gql-types.js";
import { getRegistryDef } from "./gql-utils.js";
import { buildResponsiveImage } from "./responsive-image.js";

interface GraphqlFastPathRequest {
  readonly query: string;
  readonly variables?: Record<string, unknown>;
  readonly operationName?: string | null;
}

interface AssetSelectionPlan {
  readonly fields: readonly {
    readonly responseKey: string;
    readonly fieldName: string;
  }[];
  readonly responsiveImage:
    | {
        readonly responseKey: string;
        readonly args: Record<string, unknown>;
        readonly fields: readonly {
          readonly responseKey: string;
          readonly fieldName: string;
        }[];
      }
    | null;
}

interface LatLonSelectionPlan {
  readonly fields: readonly {
    readonly responseKey: string;
    readonly fieldName: "latitude" | "longitude";
  }[];
}

interface StructuredTextBlocksPlanGeneric {
  readonly kind: "generic";
}

interface StructuredTextBlocksPlanTyped {
  readonly kind: "typed";
  readonly includeTypename: boolean;
  readonly selectionsByBlockApiKey: ReadonlyMap<string, readonly SelectionPlan[]>;
}

type StructuredTextBlocksPlan = StructuredTextBlocksPlanGeneric | StructuredTextBlocksPlanTyped;

type SelectionPlan =
  | { readonly kind: "id"; readonly responseKey: string }
  | { readonly kind: "scalar"; readonly responseKey: string; readonly field: ParsedFieldRow }
  | {
      readonly kind: "link";
      readonly responseKey: string;
      readonly field: ParsedFieldRow;
      readonly targetApiKeys: readonly string[];
      readonly nested: readonly SelectionPlan[];
    }
  | {
      readonly kind: "links";
      readonly responseKey: string;
      readonly field: ParsedFieldRow;
      readonly targetApiKeys: readonly string[];
      readonly nested: readonly SelectionPlan[];
    }
  | {
      readonly kind: "lat_lon";
      readonly responseKey: string;
      readonly field: ParsedFieldRow;
      readonly nested: LatLonSelectionPlan;
    }
  | {
      readonly kind: "media";
      readonly responseKey: string;
      readonly field: ParsedFieldRow;
      readonly nested: AssetSelectionPlan;
    }
  | {
      readonly kind: "media_gallery";
      readonly responseKey: string;
      readonly field: ParsedFieldRow;
      readonly nested: AssetSelectionPlan;
    }
  | {
      readonly kind: "structured_text";
      readonly responseKey: string;
      readonly field: ParsedFieldRow;
      readonly valueSelected: boolean;
      readonly blocksPlan: StructuredTextBlocksPlan | null;
      readonly inlineBlocksPlan: StructuredTextBlocksPlan | null;
      readonly linksSelected: boolean;
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

type StringArgPlan =
  | { readonly kind: "const"; readonly value: string }
  | { readonly kind: "var"; readonly name: string }
  | null
  | undefined;

type ValueArgPlan =
  | { readonly kind: "const"; readonly value: string | number | boolean | null }
  | { readonly kind: "var"; readonly name: string };

type FilterValuePlan =
  | ValueArgPlan
  | { readonly kind: "list"; readonly items: readonly FilterValuePlan[] }
  | { readonly kind: "object"; readonly fields: Readonly<Record<string, FilterValuePlan>> };

type FilterPlan = Extract<FilterValuePlan, { readonly kind: "object" }>;

type RootPlan =
  | { readonly kind: "meta"; readonly responseKey: string; readonly meta: FastPathModelMeta; readonly filter: FilterPlan | null }
  | {
      readonly kind: "singleton" | "list";
      readonly responseKey: string;
      readonly meta: FastPathModelMeta;
      readonly orderBy: StringListArgPlan;
      readonly locale: StringArgPlan;
      readonly fallbackLocales: StringListArgPlan;
      readonly first: IntArgPlan;
      readonly skip: IntArgPlan;
      readonly filter: FilterPlan | null;
      readonly selectionPlan: readonly SelectionPlan[];
      readonly objectSql: string | null;
    };

interface CompiledFastPathPlan {
  readonly roots: readonly RootPlan[];
}

interface FastPathModelMeta {
  readonly model: ModelRow;
  readonly apiKey: string;
  readonly tableName: string;
  readonly gqlTypeName: string;
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
  readonly contentModelsByApiKey: Map<string, FastPathModelMeta>;
  readonly blockModelsByApiKey: Map<string, FastPathModelMeta>;
  readonly blockModelsByGqlTypeName: Map<string, FastPathModelMeta>;
  readonly contentTypeNames: Map<string, string>;
  readonly contentApiKeys: readonly string[];
  readonly defaultLocale: string | null;
}

interface PublishedFastPathOptions {
  readonly assetBaseUrl?: string;
  readonly isProduction?: boolean;
}

interface FastPathSupportAnalysis {
  readonly supported: boolean;
  readonly reason?: string;
}

type FastPathSqlCategory = "metadata" | "root" | "meta" | "linked_record" | "asset";

interface FastPathSqlMetrics {
  statementCount: number;
  totalDurationMs: number;
  byCategory: Partial<Record<FastPathSqlCategory, { statementCount: number; totalDurationMs: number }>>;
}

interface FastPathExecutionResult {
  readonly response: { data: Record<string, unknown> };
  readonly metrics: FastPathSqlMetrics;
}

interface FastPathExecutionContext {
  readonly sqlLayer: Layer.Layer<SqlClient.SqlClient>;
  readonly metadata: PublishedFastPathMetadata;
  readonly assetBaseUrl: string;
  readonly isProduction: boolean;
  readonly defaultLocale: string | null;
  readonly assetCache: Map<string, AssetRow | null>;
  readonly linkedRecordCache: Map<string, Promise<Record<string, unknown> | null>>;
  readonly metrics: FastPathSqlMetrics;
}

interface PendingLinkRequest {
  readonly targetApiKeys: readonly string[];
  readonly ids: Set<string>;
  readonly nestedPlans: (readonly SelectionPlan[])[];
}

interface DependencyAccumulator {
  readonly linkRequests: Map<string, PendingLinkRequest>;
  readonly assetIds: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return decodeJsonIfString(value);
}

function isStructuredTextEnvelope(value: unknown): value is { value: Record<string, unknown>; blocks: Record<string, unknown> } {
  if (!isRecord(value)) return false;
  const rawValue = Reflect.get(value, "value");
  const rawBlocks = Reflect.get(value, "blocks");
  return isRecord(rawValue) && isRecord(rawBlocks);
}

interface DastLikeDocument {
  readonly document: {
    readonly children: readonly unknown[];
  };
}

function isDastLikeDocument(value: unknown): value is DastLikeDocument {
  if (!isRecord(value)) return false;
  const document = Reflect.get(value, "document");
  if (!isRecord(document)) return false;
  const children = Reflect.get(document, "children");
  return Array.isArray(children);
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

function sqlQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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

function createFastPathSqlMetrics(): FastPathSqlMetrics {
  return {
    statementCount: 0,
    totalDurationMs: 0,
    byCategory: {},
  };
}

function recordFastPathSqlMetrics(metrics: FastPathSqlMetrics, category: FastPathSqlCategory, durationMs: number) {
  metrics.statementCount += 1;
  metrics.totalDurationMs = Number((metrics.totalDurationMs + durationMs).toFixed(3));
  const bucket = metrics.byCategory[category] ?? { statementCount: 0, totalDurationMs: 0 };
  bucket.statementCount += 1;
  bucket.totalDurationMs = Number((bucket.totalDurationMs + durationMs).toFixed(3));
  metrics.byCategory[category] = bucket;
}

function getOperation(document: DocumentNode, operationName?: string | null): OperationDefinitionNode | null {
  const operations = document.definitions.filter((definition): definition is OperationDefinitionNode => definition.kind === Kind.OPERATION_DEFINITION);
  if (operations.length === 0) return null;
  if (!operationName) return operations.length === 1 ? operations[0] : null;
  return operations.find((operation) => operation.name?.value === operationName) ?? null;
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

function compileStringArg(fieldNode: FieldNode, name: string): StringArgPlan {
  const value = getArgumentValueNode(fieldNode, name);
  if (!value) return undefined;
  if (value.kind === Kind.STRING || value.kind === Kind.ENUM) return { kind: "const", value: value.value };
  if (value.kind === Kind.VARIABLE) return { kind: "var", name: value.name.value };
  return null;
}

function compileValueArg(value: ValueNode): ValueArgPlan | null {
  switch (value.kind) {
    case Kind.STRING:
      return { kind: "const", value: value.value };
    case Kind.INT:
      return { kind: "const", value: Number(value.value) };
    case Kind.FLOAT:
      return { kind: "const", value: Number(value.value) };
    case Kind.BOOLEAN:
      return { kind: "const", value: value.value };
    case Kind.NULL:
      return { kind: "const", value: null };
    case Kind.VARIABLE:
      return { kind: "var", name: value.name.value };
    default:
      return null;
  }
}

function compileFilterValuePlan(value: ValueNode): FilterValuePlan | null {
  const scalar = compileValueArg(value);
  if (scalar) return scalar;
  if (value.kind === Kind.LIST) {
    const items: FilterValuePlan[] = [];
    for (const item of value.values) {
      const compiled = compileFilterValuePlan(item);
      if (!compiled) return null;
      items.push(compiled);
    }
    return { kind: "list", items };
  }
  if (value.kind === Kind.OBJECT) {
    const fields: Record<string, FilterValuePlan> = {};
    for (const field of value.fields) {
      const compiled = compileFilterValuePlan(field.value);
      if (!compiled) return null;
      fields[field.name.value] = compiled;
    }
    return { kind: "object", fields };
  }
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

function resolveStringArg(plan: StringArgPlan, variables: Record<string, unknown>): string | undefined {
  if (plan === undefined || plan === null) return undefined;
  if (plan.kind === "const") return plan.value;
  const value = variables[plan.name];
  return typeof value === "string" ? value : undefined;
}

function resolveValueArg(plan: ValueArgPlan, variables: Record<string, unknown>): unknown {
  return plan.kind === "const" ? plan.value : variables[plan.name];
}

function resolveFilterValuePlan(plan: FilterValuePlan, variables: Record<string, unknown>): unknown {
  if (plan.kind === "const" || plan.kind === "var") {
    return resolveValueArg(plan, variables);
  }
  if (plan.kind === "list") {
    return plan.items.map((item) => resolveFilterValuePlan(item, variables));
  }
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(plan.fields)) {
    resolved[key] = resolveFilterValuePlan(value, variables);
  }
  return resolved;
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

function buildPublishedFilterOpts(meta: FastPathModelMeta): FilterCompilerOpts {
  const fieldSqlExprMap: Record<string, string> = { id: "row_data.id" };
  for (const [gqlName, field] of meta.fieldsByGqlName) {
    fieldSqlExprMap[gqlName] = `json_extract(row_data."_published_snapshot", '$.${field.api_key}')`;
  }

  return {
    ...buildFilterOpts(meta),
    fieldSqlExprMap,
  };
}

function pickLocalizedFastPathValue(
  rawValue: unknown,
  locale: string | undefined,
  fallbackLocales: readonly string[] | undefined,
  defaultLocale: string | null,
): unknown {
  if (rawValue === null || rawValue === undefined) return rawValue;
  const localeMap = parseJsonValue(rawValue);
  if (!isRecord(localeMap)) return rawValue;

  if (locale) {
    const localeValue = Reflect.get(localeMap, locale);
    if (localeValue !== undefined && localeValue !== null && localeValue !== "") return localeValue;
  }
  for (const fallback of fallbackLocales ?? []) {
    const fallbackValue = Reflect.get(localeMap, fallback);
    if (fallbackValue !== undefined && fallbackValue !== null && fallbackValue !== "") return fallbackValue;
  }
  if (defaultLocale) {
    const defaultValue = Reflect.get(localeMap, defaultLocale);
    if (defaultValue !== undefined) return defaultValue;
  }
  const firstEntry = Object.entries(localeMap)[0];
  return firstEntry ? firstEntry[1] : null;
}

function isSupportedPublishedFilterField(field: ParsedFieldRow): boolean {
  return !field.localized && ![
    "structured_text",
    "seo",
    "video",
    "color",
  ].includes(field.field_type);
}

function validateFilterPlanValue(
  value: FilterValuePlan,
  meta: FastPathModelMeta,
): boolean {
  if (value.kind === "const" || value.kind === "var") return true;
  if (value.kind === "list") return value.items.every((item) => validateFilterPlanValue(item, meta));

  for (const [key, nested] of Object.entries(value.fields)) {
    if (key === "AND" || key === "OR") {
      if (nested.kind !== "list") return false;
      if (!nested.items.every((item) => item.kind === "object" && validateFilterPlanValue(item, meta))) return false;
      continue;
    }

    if (key === "_locales") return false;
    if (key === "id") {
      if (nested.kind !== "object") return false;
      for (const operator of Object.keys(nested.fields)) {
        if (!["eq", "neq", "in", "notIn", "exists", "isBlank", "isPresent"].includes(operator)) return false;
      }
      continue;
    }

    const field = meta.fieldsByGqlName.get(key);
    if (!field || !isSupportedPublishedFilterField(field)) return false;
    if (nested.kind !== "object") return false;
    if (field.field_type === "lat_lon") {
      for (const operator of Object.keys(nested.fields)) {
        if (operator !== "near" && operator !== "exists") return false;
      }
      continue;
    }
    for (const operator of Object.keys(nested.fields)) {
      if (![
        "eq",
        "neq",
        "gt",
        "lt",
        "gte",
        "lte",
        "in",
        "notIn",
        "matches",
        "notMatches",
        "isBlank",
        "isPresent",
        "exists",
        "allIn",
        "anyIn",
      ].includes(operator)) return false;
    }
  }

  return true;
}

function compileFilterArg(fieldNode: FieldNode): FilterPlan | null {
  const filterValue = getArgumentValueNode(fieldNode, "filter");
  if (!filterValue) return null;
  const plan = compileFilterValuePlan(filterValue);
  return plan?.kind === "object" ? plan : null;
}

function collectObjectSelections(
  selectionSet: SelectionSetNode | undefined,
  fragments: Map<string, FragmentDefinitionNode>,
  typeName: string,
): readonly SelectionNode[] | null {
  if (!selectionSet) return [];
  const result: SelectionNode[] = [];
  for (const selection of selectionSet.selections) {
    switch (selection.kind) {
      case Kind.FIELD:
        result.push(selection);
        break;
      case Kind.INLINE_FRAGMENT:
        if (selection.typeCondition && selection.typeCondition.name.value !== typeName) return null;
        {
          const nested = collectObjectSelections(selection.selectionSet, fragments, typeName);
          if (!nested) return null;
          result.push(...nested);
        }
        break;
      case Kind.FRAGMENT_SPREAD: {
        const fragment = fragments.get(selection.name.value);
        if (!fragment) return null;
        if (fragment.typeCondition.name.value !== typeName) return null;
        const nested = collectObjectSelections(fragment.selectionSet, fragments, typeName);
        if (!nested) return null;
        result.push(...nested);
        break;
      }
    }
  }
  return result;
}

function buildAssetSelectionPlan(
  fieldNode: FieldNode,
  fragments: Map<string, FragmentDefinitionNode>,
): AssetSelectionPlan | null {
  const selections = collectObjectSelections(fieldNode.selectionSet, fragments, "Asset");
  if (!selections || selections.length === 0) return null;
  const fields: Array<{ responseKey: string; fieldName: string }> = [];
  let responsiveImage: AssetSelectionPlan["responsiveImage"] = null;

  for (const selection of selections) {
    if (selection.kind !== Kind.FIELD) return null;
    if (selection.name.value === "responsiveImage") {
      if (!selection.selectionSet) return null;
      const nestedSelections = collectObjectSelections(selection.selectionSet, fragments, "ResponsiveImage");
      if (!nestedSelections || nestedSelections.length === 0) return null;
      const nestedFields: Array<{ responseKey: string; fieldName: string }> = [];
      for (const nested of nestedSelections) {
        if (nested.kind !== Kind.FIELD || nested.selectionSet) return null;
        if (![
          "src",
          "srcSet",
          "webpSrcSet",
          "width",
          "height",
          "aspectRatio",
          "alt",
          "title",
          "base64",
          "bgColor",
          "sizes",
        ].includes(nested.name.value)) return null;
        nestedFields.push({
          responseKey: nested.alias?.value ?? nested.name.value,
          fieldName: nested.name.value,
        });
      }
      const args: Record<string, unknown> = {};
      for (const arg of selection.arguments ?? []) {
        if (!["transforms", "cfImagesParams", "imgixParams"].includes(arg.name.value)) return null;
        const compiled = resolveFilterValuePlan(compileFilterValuePlan(arg.value) ?? { kind: "const", value: null }, {});
        if (compiled === null && compileFilterValuePlan(arg.value) === null) return null;
        args[arg.name.value] = compiled;
      }
      responsiveImage = {
        responseKey: selection.alias?.value ?? selection.name.value,
        args,
        fields: nestedFields,
      };
      continue;
    }
    if (selection.selectionSet) return null;
    const fieldName = selection.name.value;
    if (![
      "id",
      "filename",
      "mimeType",
      "size",
      "width",
      "height",
      "alt",
      "title",
      "blurhash",
      "focalPoint",
      "customData",
      "url",
      "_createdAt",
      "_updatedAt",
      "_createdBy",
      "_updatedBy",
    ].includes(fieldName)) return null;
    fields.push({
      responseKey: selection.alias?.value ?? fieldName,
      fieldName,
    });
  }

  return { fields, responsiveImage };
}

function buildLatLonSelectionPlan(
  fieldNode: FieldNode,
  fragments: Map<string, FragmentDefinitionNode>,
): LatLonSelectionPlan | null {
  const selections = collectObjectSelections(fieldNode.selectionSet, fragments, "LatLonField");
  if (!selections || selections.length === 0) return null;
  const fields: Array<{ responseKey: string; fieldName: "latitude" | "longitude" }> = [];

  for (const selection of selections) {
    if (selection.kind !== Kind.FIELD) return null;
    if (selection.selectionSet) return null;
    if (selection.name.value !== "latitude" && selection.name.value !== "longitude") return null;
    fields.push({
      responseKey: selection.alias?.value ?? selection.name.value,
      fieldName: selection.name.value,
    });
  }

  return { fields };
}

function buildStructuredTextBlocksPlan(
  fieldNode: FieldNode,
  metadata: PublishedFastPathMetadata,
  fragments: Map<string, FragmentDefinitionNode>,
): StructuredTextBlocksPlan | null {
  if (!fieldNode.selectionSet) return { kind: "generic" };

  let includeTypename = false;
  const rawSelectionsByType = new Map<string, SelectionNode[]>();

  function collectUnionSelections(selectionSet: SelectionSetNode): boolean {
    for (const selection of selectionSet.selections) {
      switch (selection.kind) {
        case Kind.FIELD:
          if (selection.name.value !== "__typename" || selection.selectionSet) return false;
          includeTypename = true;
          break;
        case Kind.INLINE_FRAGMENT: {
          if (!selection.typeCondition) return false;
          const typeName = selection.typeCondition.name.value;
          const existing = rawSelectionsByType.get(typeName) ?? [];
          existing.push(...selection.selectionSet.selections);
          rawSelectionsByType.set(typeName, existing);
          break;
        }
        case Kind.FRAGMENT_SPREAD: {
          const fragment = fragments.get(selection.name.value);
          if (!fragment) return false;
          const existing = rawSelectionsByType.get(fragment.typeCondition.name.value) ?? [];
          existing.push(...fragment.selectionSet.selections);
          rawSelectionsByType.set(fragment.typeCondition.name.value, existing);
          break;
        }
      }
    }
    return true;
  }

  if (!collectUnionSelections(fieldNode.selectionSet)) return null;

  const selectionsByBlockApiKey = new Map<string, readonly SelectionPlan[]>();
  for (const [typeName, selections] of rawSelectionsByType) {
    const blockMeta = metadata.blockModelsByGqlTypeName.get(typeName);
    if (!blockMeta) return null;
    const nested = buildSelectionPlanFromSelections(blockMeta, selections, metadata, fragments);
    if (!nested) return null;
    selectionsByBlockApiKey.set(blockMeta.apiKey, nested);
  }

  return {
    kind: "typed",
    includeTypename,
    selectionsByBlockApiKey,
  };
}

function buildStructuredTextPlan(
  field: ParsedFieldRow,
  fieldNode: FieldNode,
  metadata: PublishedFastPathMetadata,
  fragments: Map<string, FragmentDefinitionNode>,
): SelectionPlan | null {
  const selections = collectObjectSelections(fieldNode.selectionSet, fragments, "StructuredText");
  if (!selections) return null;

  let valueSelected = false;
  let blocksPlan: StructuredTextBlocksPlan | null = null;
  let inlineBlocksPlan: StructuredTextBlocksPlan | null = null;
  let linksSelected = false;

  for (const selection of selections) {
    if (selection.kind !== Kind.FIELD) return null;
    const fieldName = selection.name.value;
    if (fieldName === "value") {
      if (selection.selectionSet) return null;
      valueSelected = true;
      continue;
    }
    if (fieldName === "links") {
      if (selection.selectionSet) return null;
      linksSelected = true;
      continue;
    }
    if (fieldName === "blocks") {
      blocksPlan = buildStructuredTextBlocksPlan(selection, metadata, fragments);
      if (!blocksPlan) return null;
      continue;
    }
    if (fieldName === "inlineBlocks") {
      inlineBlocksPlan = buildStructuredTextBlocksPlan(selection, metadata, fragments);
      if (!inlineBlocksPlan) return null;
      continue;
    }
    return null;
  }

  return {
    kind: "structured_text",
    responseKey: fieldNode.alias?.value ?? fieldNode.name.value,
    field,
    valueSelected,
    blocksPlan,
    inlineBlocksPlan,
    linksSelected,
  };
}

function buildSelectionPlanFromSelections(
  meta: FastPathModelMeta,
  selections: readonly SelectionNode[],
  metadata: PublishedFastPathMetadata,
  fragments: Map<string, FragmentDefinitionNode>,
): readonly SelectionPlan[] | null {
  const plan: SelectionPlan[] = [];

  for (const selection of selections) {
    if (selection.kind !== Kind.FIELD) return null;
    const responseKey = selection.alias?.value ?? selection.name.value;

    if (selection.name.value === "id") {
      if (selection.selectionSet) return null;
      plan.push({ kind: "id", responseKey });
      continue;
    }

    if (selection.name.value === "__typename" || selection.name.value.startsWith("_")) {
      return null;
    }

    const field = meta.fieldsByGqlName.get(selection.name.value);
    if (!field) return null;

    const registryDef = getRegistryDef(field.field_type);

    if (isSimpleScalarField(field) || (field.localized && registryDef?.localizable && selection.selectionSet == null)) {
      if (selection.selectionSet) return null;
      plan.push({ kind: "scalar", responseKey, field });
      continue;
    }

    if (field.field_type === "structured_text") {
      const structuredTextPlan = buildStructuredTextPlan(field, selection, metadata, fragments);
      if (!structuredTextPlan) return null;
      plan.push(structuredTextPlan);
      continue;
    }

    if (field.field_type === "lat_lon") {
      const latLonPlan = buildLatLonSelectionPlan(selection, fragments);
      if (!latLonPlan) return null;
      plan.push({ kind: "lat_lon", responseKey, field, nested: latLonPlan });
      continue;
    }

    if (field.field_type === "link") {
      if (!selection.selectionSet) return null;
      const targets = getLinkTargets(field.validators);
      if (!targets || targets.length !== 1) return null;
      const targetMeta = metadata.contentModelsByApiKey.get(targets[0]);
      if (!targetMeta) return null;
      const nestedSelections = collectObjectSelections(selection.selectionSet, fragments, targetMeta.gqlTypeName);
      if (!nestedSelections) return null;
      const nested = buildSelectionPlanFromSelections(targetMeta, nestedSelections, metadata, fragments);
      if (!nested) return null;
      plan.push({ kind: "link", responseKey, field, targetApiKeys: targets, nested });
      continue;
    }

    if (field.field_type === "links") {
      if (!selection.selectionSet) return null;
      const targets = getLinksTargets(field.validators);
      if (!targets || targets.length !== 1) return null;
      const targetMeta = metadata.contentModelsByApiKey.get(targets[0]);
      if (!targetMeta) return null;
      const nestedSelections = collectObjectSelections(selection.selectionSet, fragments, targetMeta.gqlTypeName);
      if (!nestedSelections) return null;
      const nested = buildSelectionPlanFromSelections(targetMeta, nestedSelections, metadata, fragments);
      if (!nested) return null;
      plan.push({ kind: "links", responseKey, field, targetApiKeys: targets, nested });
      continue;
    }

    if (field.field_type === "media") {
      const assetPlan = buildAssetSelectionPlan(selection, fragments);
      if (!assetPlan) return null;
      plan.push({ kind: "media", responseKey, field, nested: assetPlan });
      continue;
    }

    if (field.field_type === "media_gallery") {
      const assetPlan = buildAssetSelectionPlan(selection, fragments);
      if (!assetPlan) return null;
      plan.push({ kind: "media_gallery", responseKey, field, nested: assetPlan });
      continue;
    }

    return null;
  }

  return plan;
}

function buildSelectionPlan(
  meta: FastPathModelMeta,
  fieldNode: FieldNode,
  metadata: PublishedFastPathMetadata,
  fragments: Map<string, FragmentDefinitionNode>,
): readonly SelectionPlan[] | null {
  const selections = collectObjectSelections(fieldNode.selectionSet, fragments, meta.gqlTypeName);
  if (!selections || selections.length === 0) return null;
  return buildSelectionPlanFromSelections(meta, selections, metadata, fragments);
}

function buildSnapshotValueSql(tableAlias: string, field: ParsedFieldRow) {
  const raw = `json_extract(${tableAlias}."_published_snapshot", '$.${field.api_key}')`;
  if (field.field_type === "boolean") {
    return `CASE ${raw} WHEN 1 THEN json('true') WHEN 0 THEN json('false') ELSE NULL END`;
  }
  return raw;
}

function buildJsonObjectSql(
  tableAlias: string,
  plan: readonly SelectionPlan[],
  metadata: PublishedFastPathMetadata,
): string | null {
  const parts: string[] = [];

  for (const selection of plan) {
    switch (selection.kind) {
      case "id":
        parts.push(`${sqlQuote(selection.responseKey)}, ${tableAlias}.id`);
        break;
      case "scalar":
        if (selection.field.localized) return null;
        parts.push(`${sqlQuote(selection.responseKey)}, ${buildSnapshotValueSql(tableAlias, selection.field)}`);
        break;
      case "link": {
        const targetMeta = metadata.contentModelsByApiKey.get(selection.targetApiKeys[0]);
        if (!targetMeta) return null;
        const nestedSql = buildJsonObjectSql("linked", selection.nested, metadata);
        if (!nestedSql) return null;
        parts.push(
          `${sqlQuote(selection.responseKey)}, (` +
          `SELECT ${nestedSql} FROM "${targetMeta.tableName}" linked ` +
          `WHERE linked.id = json_extract(${tableAlias}."_published_snapshot", '$.${selection.field.api_key}') ` +
          `AND linked."_status" IN ('published', 'updated') LIMIT 1)`
        );
        break;
      }
      case "links":
      case "lat_lon":
      case "media":
      case "media_gallery":
      case "structured_text":
        return null;
    }
  }

  return parts.length > 0 ? `json_object(${parts.join(", ")})` : null;
}

async function loadMetadata(sqlLayer: Layer.Layer<SqlClient.SqlClient>): Promise<PublishedFastPathMetadata> {
  return loadMetadataWithMetrics(sqlLayer);
}

async function loadMetadataWithMetrics(
  sqlLayer: Layer.Layer<SqlClient.SqlClient>,
  metrics?: FastPathSqlMetrics,
): Promise<PublishedFastPathMetadata> {
  const loaded = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const modelsStartedAt = performance.now();
      const models = yield* sql.unsafe<ModelRow>("SELECT * FROM models ORDER BY created_at");
      if (metrics) {
        recordFastPathSqlMetrics(metrics, "metadata", Number((performance.now() - modelsStartedAt).toFixed(3)));
      }
      const fieldsStartedAt = performance.now();
      const fields = yield* sql.unsafe<FieldRow>("SELECT * FROM fields ORDER BY position");
      if (metrics) {
        recordFastPathSqlMetrics(metrics, "metadata", Number((performance.now() - fieldsStartedAt).toFixed(3)));
      }
      const localesStartedAt = performance.now();
      const locales = yield* sql.unsafe<{ code: string }>("SELECT code FROM locales ORDER BY position");
      if (metrics) {
        recordFastPathSqlMetrics(metrics, "metadata", Number((performance.now() - localesStartedAt).toFixed(3)));
      }
      return { models, fields, locales };
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
  const contentModelsByApiKey = new Map<string, FastPathModelMeta>();
  const blockModelsByApiKey = new Map<string, FastPathModelMeta>();
  const blockModelsByGqlTypeName = new Map<string, FastPathModelMeta>();
  const contentTypeNames = new Map<string, string>();

  for (const model of loaded.models) {
    const fields = fieldsByModelId.get(model.id) ?? [];
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

    const gqlTypeName = model.is_block === 1 ? `${toTypeName(model.api_key)}Record` : toContentTypeName(model.api_key);
    const baseTypeName = toTypeName(model.api_key);
    const meta: FastPathModelMeta = {
      model,
      apiKey: model.api_key,
      tableName: `${model.is_block === 1 ? "block" : "content"}_${model.api_key}`,
      gqlTypeName,
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

    if (model.is_block === 1) {
      blockModelsByApiKey.set(meta.apiKey, meta);
      blockModelsByGqlTypeName.set(meta.gqlTypeName, meta);
      continue;
    }

    contentTypeNames.set(meta.apiKey, meta.gqlTypeName);
    contentModelsByApiKey.set(meta.apiKey, meta);
    modelsByRootField.set(meta.singleName, meta);
    modelsByRootField.set(meta.listName, meta);
    modelsByRootField.set(meta.metaName, meta);
  }

  return {
    modelsByRootField,
    contentModelsByApiKey,
    blockModelsByApiKey,
    blockModelsByGqlTypeName,
    contentTypeNames,
    contentApiKeys: [...contentModelsByApiKey.keys()],
    defaultLocale: loaded.locales[0]?.code ?? null,
  };
}

function compilePlan(request: GraphqlFastPathRequest, metadata: PublishedFastPathMetadata): CompiledFastPathPlan | null {
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
    const filter = compileFilterArg(selection);
    if (filter && !validateFilterPlanValue(filter, meta)) return null;
    const locale = compileStringArg(selection, "locale");
    const fallbackLocales = compileStringListArg(selection, "fallbackLocales");
    if (locale === null || fallbackLocales === null) return null;

    if (selection.name.value === meta.metaName) {
      const supportedArgCount = (filter ? 1 : 0);
      if ((selection.arguments?.length ?? 0) > supportedArgCount) return null;
      roots.push({ kind: "meta", responseKey, meta, filter });
      continue;
    }

    const selectionPlan = buildSelectionPlan(meta, selection, metadata, fragments);
    if (!selectionPlan) return null;
    const objectSql = buildJsonObjectSql("row_data", selectionPlan, metadata);

    if (selection.name.value === meta.listName) {
      const first = compileIntArg(selection, "first");
      const skip = compileIntArg(selection, "skip");
      const orderBy = compileStringListArg(selection, "orderBy");
      if (orderBy === null) return null;
      const supportedArgCount = (filter ? 1 : 0)
        + (orderBy !== undefined ? 1 : 0)
        + (first ? 1 : 0)
        + (skip ? 1 : 0)
        + (locale !== undefined ? 1 : 0)
        + (fallbackLocales !== undefined ? 1 : 0);
      if ((selection.arguments?.length ?? 0) > supportedArgCount) return null;
      roots.push({
        kind: "list",
        responseKey,
        meta,
        orderBy,
        locale,
        fallbackLocales,
        first,
        skip,
        filter,
        selectionPlan,
        objectSql,
      });
      continue;
    }

    const supportedArgCount = (filter ? 1 : 0)
      + (locale !== undefined ? 1 : 0)
      + (fallbackLocales !== undefined ? 1 : 0);
    if ((selection.arguments?.length ?? 0) > supportedArgCount && meta.model.singleton !== 1) return null;
    roots.push({
      kind: "singleton",
      responseKey,
      meta,
      orderBy: undefined,
      locale,
      fallbackLocales,
      first: null,
      skip: null,
      filter,
      selectionPlan,
      objectSql,
    });
  }

  return { roots };
}

function findFallbackReasonInSelectionSet(selectionSet: SelectionSetNode | undefined): string | undefined {
  if (!selectionSet) return undefined;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      if (selection.name.value === "responsiveImage") return "field_responsiveImage";
      if (selection.name.value.startsWith("_allReferencing")) return "reverse_ref";
      if (selection.arguments?.some((argument) => argument.name.value === "locale")) return "localized_arg";
      const nested = findFallbackReasonInSelectionSet(selection.selectionSet);
      if (nested) return nested;
      continue;
    }
    if (selection.kind === Kind.INLINE_FRAGMENT || selection.kind === Kind.FRAGMENT_SPREAD) {
      const nested = selection.kind === Kind.INLINE_FRAGMENT
        ? findFallbackReasonInSelectionSet(selection.selectionSet)
        : undefined;
      if (nested) return nested;
    }
  }
  return undefined;
}

function analyzeSupport(
  request: GraphqlFastPathRequest,
  metadata: PublishedFastPathMetadata,
  executionOptions: { includeDrafts: boolean; excludeInvalid: boolean },
): FastPathSupportAnalysis {
  if (executionOptions.includeDrafts || executionOptions.excludeInvalid) {
    return { supported: false, reason: "draft_or_invalid_context" };
  }

  const document = parse(request.query);
  const operation = getOperation(document, request.operationName);
  if (!operation) return { supported: false, reason: "operation_not_found" };
  if (operation.operation !== "query") return { supported: false, reason: "operation_not_query" };

  const fragments = buildFragments(document);
  for (const selection of operation.selectionSet.selections) {
    if (selection.kind !== Kind.FIELD) {
      return { supported: false, reason: "top_level_fragment" };
    }

    const meta = metadata.modelsByRootField.get(selection.name.value);
    if (!meta) {
      return { supported: false, reason: "unknown_root" };
    }

    const filterValue = getArgumentValueNode(selection, "filter");
    const filter = compileFilterArg(selection);
    if (filterValue && (!filter || !validateFilterPlanValue(filter, meta))) {
      return { supported: false, reason: "unsupported_filter" };
    }

    if (selection.name.value === meta.metaName) {
      const supportedArgCount = filter ? 1 : 0;
      if ((selection.arguments?.length ?? 0) > supportedArgCount) {
        return { supported: false, reason: "unsupported_meta_args" };
      }
      continue;
    }

    if (selection.name.value === meta.listName) {
      const orderBy = compileStringListArg(selection, "orderBy");
      if (orderBy === null) return { supported: false, reason: "unsupported_order_by" };
    }

    const selectionPlan = buildSelectionPlan(meta, selection, metadata, fragments);
    if (!selectionPlan) {
      return {
        supported: false,
        reason: findFallbackReasonInSelectionSet(selection.selectionSet) ?? "unsupported_selection",
      };
    }

    const supportedArgCount = (filter ? 1 : 0)
      + (getArgumentValueNode(selection, "locale") ? 1 : 0)
      + (getArgumentValueNode(selection, "fallbackLocales") ? 1 : 0)
      + (selection.name.value === meta.listName && getArgumentValueNode(selection, "orderBy") ? 1 : 0)
      + (selection.name.value === meta.listName && getArgumentValueNode(selection, "first") ? 1 : 0)
      + (selection.name.value === meta.listName && getArgumentValueNode(selection, "skip") ? 1 : 0);
    if ((selection.arguments?.length ?? 0) > supportedArgCount && meta.model.singleton !== 1) {
      return { supported: false, reason: "unsupported_root_args" };
    }
  }

  return { supported: true };
}

async function runSql<A extends object>(
  sqlLayer: Layer.Layer<SqlClient.SqlClient>,
  sqlText: string,
  params: readonly unknown[],
  options?: { readonly metrics?: FastPathSqlMetrics; readonly category?: FastPathSqlCategory },
): Promise<readonly A[]> {
  const startedAt = performance.now();
  return Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.unsafe<A>(sqlText, params);
      if (options?.metrics && options.category) {
        recordFastPathSqlMetrics(options.metrics, options.category, Number((performance.now() - startedAt).toFixed(3)));
      }
      return rows;
    }).pipe(Effect.provide(sqlLayer), Effect.orDie),
  );
}

function buildFilterSql(
  filter: FilterPlan | null,
  variables: Record<string, unknown>,
  meta: FastPathModelMeta,
  locale?: string,
) {
  if (!filter) return { sql: "", params: [] as unknown[] };
  const resolved = resolveFilterValuePlan(filter, variables);
  if (!isRecord(resolved)) return { sql: "", params: [] as unknown[] };
  const compiled = compileFilterToSql(resolved, { ...buildPublishedFilterOpts(meta), locale });
  if (!compiled) return { sql: "", params: [] as unknown[] };
  return {
    sql: ` AND ${compiled.where}`,
    params: compiled.params,
  };
}

function buildAssetUrl(assetBaseUrl: string, r2Key: string): string {
  return `${assetBaseUrl}/${r2Key}`;
}

function buildCfImageUrl(
  assetBaseUrl: string,
  isProduction: boolean,
  assetPath: string,
  params: Record<string, string | number>,
): string {
  if (isProduction) {
    const opts = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(",");
    return `${assetBaseUrl}/cdn-cgi/image/${opts}${assetPath}`;
  }
  const qs = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&");
  return `${assetBaseUrl}${assetPath}?${qs}`;
}

async function fetchAssetMap(ctx: FastPathExecutionContext, ids: readonly string[]) {
  const uniqueIds = [...new Set(ids.filter((id) => !ctx.assetCache.has(id)))];
  if (uniqueIds.length > 0) {
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = await runSql<AssetRow>(
      ctx.sqlLayer,
      `SELECT * FROM assets WHERE id IN (${placeholders})`,
      uniqueIds,
      { metrics: ctx.metrics, category: "asset" },
    );
    const foundIds = new Set<string>();
    for (const row of rows) {
      ctx.assetCache.set(row.id, row);
      foundIds.add(row.id);
    }
    for (const id of uniqueIds) {
      if (!foundIds.has(id)) ctx.assetCache.set(id, null);
    }
  }

  const result = new Map<string, AssetRow>();
  for (const id of ids) {
    const asset = ctx.assetCache.get(id);
    if (asset) result.set(id, asset);
  }
  return result;
}

function getLinkedRecordCacheKey(targetApiKeys: readonly string[], id: string) {
  return `published:${targetApiKeys.join(",")}:${id}`;
}

function createDependencyAccumulator(): DependencyAccumulator {
  return {
    linkRequests: new Map(),
    assetIds: new Set(),
  };
}

function addPendingLinkRequest(
  pending: DependencyAccumulator,
  targetApiKeys: readonly string[],
  ids: readonly string[],
  nestedPlan?: readonly SelectionPlan[],
) {
  if (ids.length === 0) return;
  const key = targetApiKeys.join(",");
  const existing = pending.linkRequests.get(key) ?? {
    targetApiKeys,
    ids: new Set<string>(),
    nestedPlans: [],
  };
  for (const id of ids) {
    if (id.length > 0) existing.ids.add(id);
  }
  if (nestedPlan && !existing.nestedPlans.some((plan) => plan === nestedPlan)) {
    existing.nestedPlans.push(nestedPlan);
  }
  pending.linkRequests.set(key, existing);
}

function collectStructuredTextDependencies(
  metadata: PublishedFastPathMetadata,
  rawValue: unknown,
  plan: Extract<SelectionPlan, { kind: "structured_text" }>,
  pending: DependencyAccumulator,
): void {
  const parsed = parseJsonValue(rawValue);
  if (!isStructuredTextEnvelope(parsed)) return;

  const dast = parsed.value;
  const envelopeBlocks = parsed.blocks;
  if (!isDastLikeDocument(dast)) return;

  if (plan.blocksPlan?.kind === "typed") {
    for (const id of extractBlockIds(dast)) {
      const rawBlock = envelopeBlocks[id];
      if (!isRecord(rawBlock)) continue;
      const blockApiKey = Reflect.get(rawBlock, "_type");
      if (typeof blockApiKey !== "string") continue;
      const nestedPlan = plan.blocksPlan.selectionsByBlockApiKey.get(blockApiKey);
      if (nestedPlan) {
        collectModelDependencies(metadata, rawBlock, nestedPlan, pending);
      }
    }
  }

  if (plan.inlineBlocksPlan?.kind === "typed") {
    for (const id of extractInlineBlockIds(dast)) {
      const rawBlock = envelopeBlocks[id];
      if (!isRecord(rawBlock)) continue;
      const blockApiKey = Reflect.get(rawBlock, "_type");
      if (typeof blockApiKey !== "string") continue;
      const nestedPlan = plan.inlineBlocksPlan.selectionsByBlockApiKey.get(blockApiKey);
      if (nestedPlan) {
        collectModelDependencies(metadata, rawBlock, nestedPlan, pending);
      }
    }
  }

  if (plan.linksSelected) {
    addPendingLinkRequest(pending, metadata.contentApiKeys, extractLinkIds(dast));
  }
}

function collectModelDependencies(
  metadata: PublishedFastPathMetadata,
  source: Record<string, unknown>,
  plan: readonly SelectionPlan[],
  pending: DependencyAccumulator,
  localeOptions?: { readonly locale?: string; readonly fallbackLocales?: readonly string[]; readonly defaultLocale?: string | null },
): void {
  for (const selection of plan) {
    const rawFieldValue = "field" in selection
      ? (selection.field.localized
        ? pickLocalizedFastPathValue(
          Reflect.get(source, selection.field.api_key),
          localeOptions?.locale,
          localeOptions?.fallbackLocales,
          localeOptions?.defaultLocale ?? metadata.defaultLocale,
        )
        : Reflect.get(source, selection.field.api_key))
      : undefined;
    switch (selection.kind) {
      case "id":
      case "scalar":
        break;
      case "link": {
        const rawId = rawFieldValue;
        if (typeof rawId === "string" && rawId.length > 0) {
          addPendingLinkRequest(pending, selection.targetApiKeys, [rawId], selection.nested);
        }
        break;
      }
      case "links": {
        const rawValue = parseJsonValue(rawFieldValue);
        if (!Array.isArray(rawValue)) break;
        addPendingLinkRequest(
          pending,
          selection.targetApiKeys,
          rawValue.filter((entry): entry is string => typeof entry === "string"),
          selection.nested,
        );
        break;
      }
      case "lat_lon":
        break;
      case "media": {
        const reference = parseMediaFieldReference(rawFieldValue);
        if (reference) pending.assetIds.add(reference.uploadId);
        break;
      }
      case "media_gallery": {
        for (const reference of parseMediaGalleryReferences(rawFieldValue)) {
          pending.assetIds.add(reference.uploadId);
        }
        break;
      }
      case "structured_text":
        collectStructuredTextDependencies(metadata, rawFieldValue, selection, pending);
        break;
    }
  }
}

function pickAssetField(asset: AssetObject, fieldName: string): unknown {
  switch (fieldName) {
    case "mimeType":
      return asset.mimeType;
    case "focalPoint":
      return asset.focalPoint;
    case "customData":
      return asset.customData;
    case "_createdAt":
      return asset._createdAt;
    case "_updatedAt":
      return asset._updatedAt;
    case "_createdBy":
      return asset._createdBy;
    case "_updatedBy":
      return asset._updatedBy;
    default:
      return Reflect.get(asset, fieldName);
  }
}

function projectLatLonField(
  rawValue: unknown,
  plan: LatLonSelectionPlan,
): Record<string, unknown> | null {
  const parsed = parseJsonValue(rawValue);
  if (!isRecord(parsed)) return null;
  const result: Record<string, unknown> = {};
  for (const field of plan.fields) {
    result[field.responseKey] = Reflect.get(parsed, field.fieldName) ?? null;
  }
  return result;
}

async function projectAsset(
  ctx: FastPathExecutionContext,
  rawValue: unknown,
  plan: AssetSelectionPlan,
): Promise<Record<string, unknown> | null> {
  const reference = parseMediaFieldReference(rawValue);
  if (!reference) return null;
  const assetMap = await fetchAssetMap(ctx, [reference.uploadId]);
  const asset = assetMap.get(reference.uploadId);
  if (!asset) return null;
  const mergedAsset = mergeAssetWithMediaReference(asset, reference, (r2Key) => buildAssetUrl(ctx.assetBaseUrl, r2Key));
  const result: Record<string, unknown> = {};
  for (const field of plan.fields) {
    result[field.responseKey] = pickAssetField(mergedAsset, field.fieldName);
  }
  if (plan.responsiveImage) {
    const responsiveImage = buildResponsiveImage(
      mergedAsset,
      plan.responsiveImage.args,
      (assetPath, params) => buildCfImageUrl(ctx.assetBaseUrl, ctx.isProduction, assetPath, params),
    );
    result[plan.responsiveImage.responseKey] = responsiveImage
      ? Object.fromEntries(plan.responsiveImage.fields.map((field) => [field.responseKey, Reflect.get(responsiveImage, field.fieldName) ?? null]))
      : null;
  }
  return result;
}

async function projectAssetGallery(
  ctx: FastPathExecutionContext,
  rawValue: unknown,
  plan: AssetSelectionPlan,
): Promise<readonly Record<string, unknown>[]> {
  const references = parseMediaGalleryReferences(rawValue);
  if (references.length === 0) return [];
  const assetMap = await fetchAssetMap(ctx, references.map((reference) => reference.uploadId));
  const result: Record<string, unknown>[] = [];

  for (const reference of references) {
    const asset = assetMap.get(reference.uploadId);
    if (!asset) continue;
    const mergedAsset = mergeAssetWithMediaReference(asset, reference, (r2Key) => buildAssetUrl(ctx.assetBaseUrl, r2Key));
    const projected: Record<string, unknown> = {};
    for (const field of plan.fields) {
      projected[field.responseKey] = pickAssetField(mergedAsset, field.fieldName);
    }
    if (plan.responsiveImage) {
      const responsiveImage = buildResponsiveImage(
        mergedAsset,
        plan.responsiveImage.args,
        (assetPath, params) => buildCfImageUrl(ctx.assetBaseUrl, ctx.isProduction, assetPath, params),
      );
      projected[plan.responsiveImage.responseKey] = responsiveImage
        ? Object.fromEntries(plan.responsiveImage.fields.map((field) => [field.responseKey, Reflect.get(responsiveImage, field.fieldName) ?? null]))
        : null;
    }
    result.push(projected);
  }

  return result;
}

async function loadLinkedRecordMap(
  ctx: FastPathExecutionContext,
  targetApiKeys: readonly string[],
  ids: readonly string[],
): Promise<Map<string, Record<string, unknown>>> {
  return batchResolveLinkedRecordsCached({
    runSql: <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) => {
      const startedAt = performance.now();
      return Effect.runPromise(effect.pipe(Effect.provide(ctx.sqlLayer), Effect.orDie)).then((value) => {
        recordFastPathSqlMetrics(ctx.metrics, "linked_record", Number((performance.now() - startedAt).toFixed(3)));
        return value;
      });
    },
    targetApiKeys: [...targetApiKeys],
    ids: [...ids],
    typeNames: ctx.metadata.contentTypeNames,
    includeDrafts: false,
    cache: ctx.linkedRecordCache,
  });
}

async function preloadDependencies(
  ctx: FastPathExecutionContext,
  sources: readonly {
    readonly source: Record<string, unknown>;
    readonly plan: readonly SelectionPlan[];
    readonly localeOptions?: { readonly locale?: string; readonly fallbackLocales?: readonly string[] };
  }[],
): Promise<void> {
  const pending = createDependencyAccumulator();
  for (const entry of sources) {
    collectModelDependencies(ctx.metadata, entry.source, entry.plan, pending, {
      ...entry.localeOptions,
      defaultLocale: ctx.defaultLocale,
    });
  }

  while (true) {
    const uncachedAssetIds = [...pending.assetIds].filter((id) => !ctx.assetCache.has(id));
    const uncachedLinkRequests = [...pending.linkRequests.values()].map((request) => ({
      targetApiKeys: request.targetApiKeys,
      nestedPlans: request.nestedPlans,
      ids: [...request.ids].filter((id) => !ctx.linkedRecordCache.has(getLinkedRecordCacheKey(request.targetApiKeys, id))),
    })).filter((request) => request.ids.length > 0);

    if (uncachedAssetIds.length === 0 && uncachedLinkRequests.length === 0) {
      return;
    }

    if (uncachedAssetIds.length > 0) {
      await fetchAssetMap(ctx, uncachedAssetIds);
    }

    for (const request of uncachedLinkRequests) {
        const fetched = await loadLinkedRecordMap(ctx, request.targetApiKeys, request.ids);
        if (request.nestedPlans.length === 0) continue;
        for (const record of fetched.values()) {
          for (const nestedPlan of request.nestedPlans) {
            collectModelDependencies(ctx.metadata, record, nestedPlan, pending, {
              defaultLocale: ctx.defaultLocale,
            });
          }
        }
      }
  }
}

async function projectModelSelections(
  ctx: FastPathExecutionContext,
  meta: FastPathModelMeta,
  source: Record<string, unknown>,
  plan: readonly SelectionPlan[],
  explicitId?: string,
  localeOptions?: { readonly locale?: string; readonly fallbackLocales?: readonly string[] },
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};

  for (const selection of plan) {
    switch (selection.kind) {
      case "id":
        result[selection.responseKey] = explicitId ?? source.id ?? null;
        break;
      case "scalar":
        result[selection.responseKey] = selection.field.localized
          ? pickLocalizedFastPathValue(
            Reflect.get(source, selection.field.api_key),
            localeOptions?.locale,
            localeOptions?.fallbackLocales,
            ctx.defaultLocale,
          )
          : parseJsonValue(Reflect.get(source, selection.field.api_key));
        break;
      case "link": {
        const rawId = selection.field.localized
          ? pickLocalizedFastPathValue(Reflect.get(source, selection.field.api_key), localeOptions?.locale, localeOptions?.fallbackLocales, ctx.defaultLocale)
          : Reflect.get(source, selection.field.api_key);
        if (typeof rawId !== "string" || rawId.length === 0) {
          result[selection.responseKey] = null;
          break;
        }
        const linkedMap = await loadLinkedRecordMap(ctx, selection.targetApiKeys, [rawId]);
        const linked = linkedMap.get(rawId);
        result[selection.responseKey] = linked
          ? await projectModelSelections(
            ctx,
            ctx.metadata.contentModelsByApiKey.get(selection.targetApiKeys[0]) ?? meta,
            linked,
            selection.nested,
            undefined,
          )
          : null;
        break;
      }
      case "links": {
        const rawValue = selection.field.localized
          ? pickLocalizedFastPathValue(Reflect.get(source, selection.field.api_key), localeOptions?.locale, localeOptions?.fallbackLocales, ctx.defaultLocale)
          : parseJsonValue(Reflect.get(source, selection.field.api_key));
        if (!Array.isArray(rawValue)) {
          result[selection.responseKey] = [];
          break;
        }
        const ids = rawValue.filter((entry): entry is string => typeof entry === "string");
        const linkedMap = await loadLinkedRecordMap(ctx, selection.targetApiKeys, ids);
        const projected: Record<string, unknown>[] = [];
        const targetMeta = ctx.metadata.contentModelsByApiKey.get(selection.targetApiKeys[0]);
        if (!targetMeta) {
          result[selection.responseKey] = [];
          break;
        }
        for (const id of ids) {
          const linked = linkedMap.get(id);
          if (!linked) continue;
          projected.push(await projectModelSelections(ctx, targetMeta, linked, selection.nested, undefined));
        }
        result[selection.responseKey] = projected;
        break;
      }
      case "lat_lon":
        result[selection.responseKey] = projectLatLonField(
          selection.field.localized
            ? pickLocalizedFastPathValue(Reflect.get(source, selection.field.api_key), localeOptions?.locale, localeOptions?.fallbackLocales, ctx.defaultLocale)
            : Reflect.get(source, selection.field.api_key),
          selection.nested,
        );
        break;
      case "media":
        result[selection.responseKey] = await projectAsset(
          ctx,
          selection.field.localized
            ? pickLocalizedFastPathValue(Reflect.get(source, selection.field.api_key), localeOptions?.locale, localeOptions?.fallbackLocales, ctx.defaultLocale)
            : Reflect.get(source, selection.field.api_key),
          selection.nested,
        );
        break;
      case "media_gallery":
        result[selection.responseKey] = await projectAssetGallery(
          ctx,
          selection.field.localized
            ? pickLocalizedFastPathValue(Reflect.get(source, selection.field.api_key), localeOptions?.locale, localeOptions?.fallbackLocales, ctx.defaultLocale)
            : Reflect.get(source, selection.field.api_key),
          selection.nested,
        );
        break;
      case "structured_text":
        result[selection.responseKey] = await projectStructuredText(
          ctx,
          selection.field.localized
            ? pickLocalizedFastPathValue(Reflect.get(source, selection.field.api_key), localeOptions?.locale, localeOptions?.fallbackLocales, ctx.defaultLocale)
            : Reflect.get(source, selection.field.api_key),
          selection,
        );
        break;
    }
  }

  return result;
}

async function projectStructuredTextBlockArray(
  ctx: FastPathExecutionContext,
  envelopeBlocks: Record<string, unknown>,
  ids: readonly string[],
  plan: StructuredTextBlocksPlan,
): Promise<readonly unknown[]> {
  const result: unknown[] = [];

  for (const id of ids) {
    const raw = envelopeBlocks[id];
    if (!isRecord(raw)) continue;
    const blockApiKeyValue = Reflect.get(raw, "_type");
    const typename = typeof blockApiKeyValue === "string" ? `${toTypeName(blockApiKeyValue)}Record` : undefined;

    if (plan.kind === "generic") {
      result.push({
        id,
        ...raw,
        ...(typename ? { __typename: typename } : {}),
      });
      continue;
    }

    const projected: Record<string, unknown> = {};
    if (plan.includeTypename && typename) {
      projected.__typename = typename;
    }

    if (typeof blockApiKeyValue === "string") {
      const blockMeta = ctx.metadata.blockModelsByApiKey.get(blockApiKeyValue);
      const nestedPlan = plan.selectionsByBlockApiKey.get(blockApiKeyValue);
      if (blockMeta && nestedPlan) {
        const nestedObject = await projectModelSelections(ctx, blockMeta, raw, nestedPlan, id);
        for (const [key, value] of Object.entries(nestedObject)) {
          projected[key] = value;
        }
      }
    }

    result.push(projected);
  }

  return result;
}

async function projectStructuredText(
  ctx: FastPathExecutionContext,
  rawValue: unknown,
  plan: Extract<SelectionPlan, { kind: "structured_text" }>,
): Promise<Record<string, unknown> | null> {
  const parsed = parseJsonValue(rawValue);
  if (!isStructuredTextEnvelope(parsed)) return null;

  const dast = parsed.value;
  const envelopeBlocks = parsed.blocks;
  if (!isDastLikeDocument(dast)) return null;
  const result: Record<string, unknown> = {};

  if (plan.valueSelected) {
    result.value = dast;
  }

  if (plan.blocksPlan) {
    result.blocks = await projectStructuredTextBlockArray(
      ctx,
      envelopeBlocks,
      extractBlockIds(dast),
      plan.blocksPlan,
    );
  }

  if (plan.inlineBlocksPlan) {
    result.inlineBlocks = await projectStructuredTextBlockArray(
      ctx,
      envelopeBlocks,
      extractInlineBlockIds(dast),
      plan.inlineBlocksPlan,
    );
  }

  if (plan.linksSelected) {
    const linkIds = extractLinkIds(dast);
    const linkedMap = await loadLinkedRecordMap(ctx, ctx.metadata.contentApiKeys, linkIds);
    result.links = linkIds.map((id) => linkedMap.get(id) ?? null).filter((value): value is Record<string, unknown> => value !== null);
  }

  return result;
}

async function projectFetchedContentRoot(
  ctx: FastPathExecutionContext,
  root: Extract<RootPlan, { kind: "list" | "singleton" }>,
  variables: Record<string, unknown>,
  fetched:
    | { readonly kind: "list"; readonly sources: readonly Record<string, unknown>[] }
    | { readonly kind: "singleton"; readonly sources: readonly Record<string, unknown>[]; readonly source: Record<string, unknown> | null },
): Promise<unknown> {
  const localeOptions = {
    locale: resolveStringArg(root.locale, variables),
    fallbackLocales: resolveStringListArg(root.fallbackLocales, variables) ?? [],
  };
  if (root.kind === "list") {
    const result: Record<string, unknown>[] = [];
    for (const merged of fetched.sources) {
      result.push(await projectModelSelections(ctx, root.meta, merged, root.selectionPlan, undefined, localeOptions));
    }
    return result;
  }

  if (!("source" in fetched) || !fetched.source) return null;
  return projectModelSelections(ctx, root.meta, fetched.source, root.selectionPlan, undefined, localeOptions);
}

function buildRootResultSql(
  root: RootPlan,
  variables: Record<string, unknown>,
): { readonly sql: string; readonly params: readonly unknown[] } | null {
  if (root.kind === "meta") {
    const filter = buildFilterSql(root.filter, variables, root.meta);
    return {
      sql: `(SELECT json_object('count', COUNT(*)) FROM "${root.meta.tableName}" row_data WHERE row_data."_status" IN ('published', 'updated')${filter.sql})`,
      params: filter.params,
    };
  }

  if (!root.objectSql) return null;

  if (root.kind === "list") {
    const orderBy = resolveStringListArg(root.orderBy, variables);
    const locale = resolveStringArg(root.locale, variables);
    const compiledOrderBy = compileOrderBy(
      orderBy ?? (typeof root.meta.model.ordering === "string" ? [root.meta.model.ordering] : undefined),
      { ...buildFilterOpts(root.meta), locale },
    );
    const filter = buildFilterSql(root.filter, variables, root.meta, locale);
    let innerSql = `SELECT ${root.objectSql} AS item_json FROM "${root.meta.tableName}" row_data WHERE row_data."_status" IN ('published', 'updated')${filter.sql}`;
    if (compiledOrderBy) {
      innerSql += ` ORDER BY ${compiledOrderBy}`;
    }
    const params: unknown[] = [...filter.params, Math.min(resolveIntArg(root.first, variables) ?? 20, 500)];
    innerSql += " LIMIT ?";
    const skip = resolveIntArg(root.skip, variables);
    if (skip && skip > 0) {
      innerSql += " OFFSET ?";
      params.push(skip);
    }
    return {
      sql: `(SELECT COALESCE(json_group_array(json(item_json)), '[]') FROM (${innerSql}) ordered_rows)`,
      params,
    };
  }

  const filter = buildFilterSql(root.filter, variables, root.meta, resolveStringArg(root.locale, variables));
  return {
    sql: `(SELECT ${root.objectSql} FROM "${root.meta.tableName}" row_data WHERE row_data."_status" IN ('published', 'updated')${filter.sql} LIMIT 1)`,
    params: filter.params,
  };
}

function buildRecursiveRootFetchSql(
  root: Extract<RootPlan, { kind: "list" | "singleton" }>,
  variables: Record<string, unknown>,
): { readonly sql: string; readonly params: readonly unknown[] } {
  const locale = resolveStringArg(root.locale, variables);
  const filter = buildFilterSql(root.filter, variables, root.meta, locale);

  if (root.kind === "list") {
    const orderBy = resolveStringListArg(root.orderBy, variables);
    const compiledOrderBy = compileOrderBy(
      orderBy ?? (typeof root.meta.model.ordering === "string" ? [root.meta.model.ordering] : undefined),
      { ...buildFilterOpts(root.meta), locale },
    );
    let innerSql =
      `SELECT json_object('id', row_data.id, '_published_snapshot', row_data."_published_snapshot") AS item_json ` +
      `FROM "${root.meta.tableName}" row_data WHERE row_data."_status" IN ('published', 'updated')${filter.sql}`;
    if (compiledOrderBy) {
      innerSql += ` ORDER BY ${compiledOrderBy}`;
    }
    const params: unknown[] = [...filter.params, Math.min(resolveIntArg(root.first, variables) ?? 20, 500)];
    innerSql += " LIMIT ?";
    const skip = resolveIntArg(root.skip, variables);
    if (skip && skip > 0) {
      innerSql += " OFFSET ?";
      params.push(skip);
    }
    return {
      sql: `(SELECT COALESCE(json_group_array(json(item_json)), '[]') FROM (${innerSql}) fetched_rows)`,
      params,
    };
  }

  return {
    sql:
      `(SELECT json_object('id', row_data.id, '_published_snapshot', row_data."_published_snapshot") ` +
      `FROM "${root.meta.tableName}" row_data WHERE row_data."_status" IN ('published', 'updated')${filter.sql} LIMIT 1)`,
    params: filter.params,
  };
}

async function executePlan(
  sqlLayer: Layer.Layer<SqlClient.SqlClient>,
  metadata: PublishedFastPathMetadata,
  plan: CompiledFastPathPlan,
  variables: Record<string, unknown>,
  metrics: FastPathSqlMetrics,
  options?: PublishedFastPathOptions,
): Promise<FastPathExecutionResult> {
  const ctx: FastPathExecutionContext = {
    sqlLayer,
    metadata,
    assetBaseUrl: (options?.assetBaseUrl ?? "").replace(/\/$/, ""),
    isProduction: options?.isProduction ?? false,
    defaultLocale: metadata.defaultLocale,
    assetCache: new Map(),
    linkedRecordCache: new Map(),
    metrics,
  };
  const data: Record<string, unknown> = {};
  const sqlRoots: RootPlan[] = [];
  const recursiveRoots: Extract<RootPlan, { kind: "list" | "singleton" }>[] = [];

  for (const root of plan.roots) {
    if (root.kind === "meta" || root.objectSql) {
      sqlRoots.push(root);
    } else {
      recursiveRoots.push(root);
    }
  }

  const jsonParts: string[] = [];
  const params: unknown[] = [];

  for (const root of sqlRoots) {
    const resultSql = buildRootResultSql(root, variables);
    if (!resultSql) continue;
    jsonParts.push(`${sqlQuote(root.responseKey)}, json(COALESCE(${resultSql.sql}, 'null'))`);
    params.push(...resultSql.params);
  }

  for (const root of recursiveRoots) {
    const fetchSql = buildRecursiveRootFetchSql(root, variables);
    jsonParts.push(`${sqlQuote(`__rows__${root.responseKey}`)}, json(COALESCE(${fetchSql.sql}, 'null'))`);
    params.push(...fetchSql.params);
  }

  const fetchedRecursiveRoots: Array<{
    readonly root: Extract<RootPlan, { kind: "list" | "singleton" }>;
    readonly fetched:
      | { readonly kind: "list"; readonly sources: readonly Record<string, unknown>[] }
      | { readonly kind: "singleton"; readonly sources: readonly Record<string, unknown>[]; readonly source: Record<string, unknown> | null };
  }> = [];

  if (jsonParts.length > 0) {
    const rows = await runSql<{ result: string }>(
      sqlLayer,
      `SELECT json_object(${jsonParts.join(", ")}) AS result`,
      params,
      {
        metrics: ctx.metrics,
        category: plan.roots.every((root) => root.kind === "meta") ? "meta" : "root",
      },
    );
    const sqlData = parseJsonValue(rows[0]?.result);
    if (isRecord(sqlData)) {
      for (const root of sqlRoots) {
        if (Object.prototype.hasOwnProperty.call(sqlData, root.responseKey)) {
          data[root.responseKey] = Reflect.get(sqlData, root.responseKey);
        }
      }
      for (const root of recursiveRoots) {
        const rawPayload = Reflect.get(sqlData, `__rows__${root.responseKey}`);
        if (root.kind === "list") {
          const rowsPayload = Array.isArray(rawPayload)
            ? rawPayload.filter((entry): entry is Record<string, unknown> => isRecord(entry))
            : [];
          const sources = rowsPayload.map((row) => decodeSnapshot(row, false));
          fetchedRecursiveRoots.push({
            root,
            fetched: { kind: "list", sources },
          });
        } else {
          const source = isRecord(rawPayload) ? decodeSnapshot(rawPayload, false) : null;
          fetchedRecursiveRoots.push({
            root,
            fetched: {
              kind: "singleton",
              sources: source ? [source] : [],
              source,
            },
          });
        }
      }
    }
  }

  if (fetchedRecursiveRoots.length > 0) {
    await preloadDependencies(
      ctx,
      fetchedRecursiveRoots.flatMap(({ root, fetched }) =>
        fetched.sources.map((source) => ({
          source,
          plan: root.selectionPlan,
          localeOptions: {
            locale: resolveStringArg(root.locale, variables),
            fallbackLocales: resolveStringListArg(root.fallbackLocales, variables) ?? [],
          },
        })),
      ),
    );
  }

  for (const entry of fetchedRecursiveRoots) {
    data[entry.root.responseKey] = await projectFetchedContentRoot(ctx, entry.root, variables, entry.fetched);
  }

  return { response: { data }, metrics: ctx.metrics };
}

export function createPublishedFastPath(sqlLayer: Layer.Layer<SqlClient.SqlClient>, options?: PublishedFastPathOptions) {
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
    async analyze(request: GraphqlFastPathRequest, executionOptions: { includeDrafts: boolean; excludeInvalid: boolean }) {
      const metadata = metadataPromise
        ? await getMetadata()
        : await loadMetadata(sqlLayer).then((loaded) => {
          metadataPromise = Promise.resolve(loaded);
          return loaded;
        }).catch((error) => {
          metadataPromise = null;
          throw error;
        });
      return analyzeSupport(request, metadata, executionOptions);
    },
    async tryExecute(request: GraphqlFastPathRequest, executionOptions: { includeDrafts: boolean; excludeInvalid: boolean }) {
      if (executionOptions.includeDrafts || executionOptions.excludeInvalid) return null;
      const metrics = createFastPathSqlMetrics();
      const metadata = metadataPromise
        ? await getMetadata()
        : await loadMetadataWithMetrics(sqlLayer, metrics).then((loaded) => {
          metadataPromise = Promise.resolve(loaded);
          return loaded;
        }).catch((error) => {
          metadataPromise = null;
          throw error;
        });
      const plan = await compile(request);
      if (!plan) return null;
      return executePlan(sqlLayer, metadata, plan, request.variables ?? {}, metrics, options);
    },
  };
}
