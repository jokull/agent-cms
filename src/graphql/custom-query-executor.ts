import { SqlClient } from "@effect/sql";
import { Effect, Layer } from "effect";
import {
  Kind,
  type ArgumentNode,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
  type SelectionNode,
  type SelectionSetNode,
  type ValueNode,
  type GraphQLSchema,
} from "graphql";
import type { FieldRow, ModelRow, ParsedFieldRow } from "../db/row-types.js";
import { parseFieldValidators } from "../db/row-types.js";
import { getLinkTargets } from "../db/validators.js";
import { extractBlockIds, extractInlineBlockIds } from "../dast/index.js";
import { runBatchedQueries, type BatchedQuery } from "../db/run-batched-queries.js";
import {
  materializeStructuredTextValues,
  type StructuredTextEnvelope,
  type StructuredTextMaterializePlan,
} from "../services/structured-text-service.js";
import { compileFilterToSql, compileOrderBy, type FilterCompilerOpts } from "./filter-compiler.js";
import type { DynamicRow, DastDocInput } from "./gql-types.js";
import { decodeSnapshot, deserializeRecord, pluralize, toCamelCase, toContentTypeName, toTypeName } from "./gql-utils.js";
import { recordSqlMetrics } from "./sql-metrics.js";

interface CustomQueryContext {
  readonly includeDrafts: boolean;
  readonly excludeInvalid: boolean;
}

interface LocaleProjectionOptions {
  readonly locale?: string;
  readonly fallbackLocales?: readonly string[];
}

interface CustomExecutionResult {
  readonly data: unknown;
  readonly _trace: {
    readonly path: "custom";
    readonly rootPaths: Record<string, string>;
  };
}

interface RootModelMeta {
  readonly model: ModelRow;
  readonly tableName: string;
  readonly typeName: string;
  readonly singleName: string;
  readonly listName: string;
  readonly fields: readonly ParsedFieldRow[];
  readonly fieldsByGqlName: ReadonlyMap<string, ParsedFieldRow>;
  readonly fieldNameMap: Record<string, string>;
  readonly localizedCamelKeys: ReadonlySet<string>;
  readonly localizedDbColumns: readonly string[];
  readonly jsonArrayFields: ReadonlySet<string>;
  readonly jsonObjectIdFields: ReadonlySet<string>;
}

interface ExecutorMetadata {
  readonly contentByRootField: ReadonlyMap<string, RootModelMeta>;
  readonly contentByApiKey: ReadonlyMap<string, RootModelMeta>;
  readonly blockByApiKey: ReadonlyMap<string, BlockModelMeta>;
  readonly blockByTypeName: ReadonlyMap<string, BlockModelMeta>;
}

interface BlockModelMeta {
  readonly model: ModelRow;
  readonly typeName: string;
  readonly fields: readonly ParsedFieldRow[];
  readonly fieldsByGqlName: ReadonlyMap<string, ParsedFieldRow>;
}

type RootPlan =
  | {
      readonly responseKey: string;
      readonly kind: "list";
      readonly model: RootModelMeta;
      readonly args: {
        readonly filter?: DynamicRow;
        readonly orderBy?: readonly string[];
        readonly first?: number;
        readonly skip?: number;
        readonly locale?: string;
        readonly fallbackLocales?: readonly string[];
      };
      readonly selections: readonly FieldPlan[];
    }
  | {
      readonly responseKey: string;
      readonly kind: "single";
      readonly model: RootModelMeta;
      readonly args: {
        readonly id?: string | number;
        readonly filter?: DynamicRow;
        readonly locale?: string;
        readonly fallbackLocales?: readonly string[];
      };
      readonly selections: readonly FieldPlan[];
    };

type FieldPlan =
  | { readonly kind: "id"; readonly responseKey: string }
  | { readonly kind: "typename"; readonly responseKey: string; readonly typeName: string }
  | {
      readonly kind: "scalar";
      readonly responseKey: string;
      readonly field: ParsedFieldRow;
      readonly localeOptions?: LocaleProjectionOptions;
    }
  | {
      readonly kind: "link";
      readonly responseKey: string;
      readonly field: ParsedFieldRow;
      readonly target: RootModelMeta;
      readonly selections: readonly FieldPlan[];
    }
  | {
      readonly kind: "structured_text";
      readonly responseKey: string;
      readonly field: ParsedFieldRow;
      readonly valueSelected: boolean;
      readonly blocksPlan: StructuredTextBlocksPlan | null;
      readonly inlineBlocksPlan: StructuredTextBlocksPlan | null;
    };

interface StructuredTextBlocksPlan {
  readonly includeTypename: boolean;
  readonly selectionsByBlockApiKey: ReadonlyMap<string, readonly FieldPlan[]>;
}

interface RootLinkPrefetchSpec {
  readonly fieldApiKey: string;
  readonly sqlExpression: string;
}

interface LinkBucketQuery {
  readonly bucketKey: string;
  readonly query: BatchedQuery;
}

interface LinkBucketDescriptor {
  readonly target: RootModelMeta;
  readonly selections: readonly FieldPlan[];
}

interface RunSqlOptions {
  readonly recordMetrics?: boolean;
  readonly phase?: string;
}

type RunSqlFn = <A>(
  effect: Effect.Effect<A, unknown, SqlClient.SqlClient>,
  options?: RunSqlOptions,
) => Promise<A>;

const structuredTextBlockIdCache = new WeakMap<object, {
  readonly blockIds: readonly string[];
  readonly inlineBlockIds: readonly string[];
}>();

function getLinkBucketKey(fieldApiKey: string, targetApiKey: string) {
  return `${fieldApiKey}:${targetApiKey}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isDastDocument(value: unknown): value is DastDocInput {
  if (!isRecord(value)) return false;
  const document = Reflect.get(value, "document");
  if (!isRecord(document)) return false;
  return Array.isArray(Reflect.get(document, "children"));
}

function isStructuredTextEnvelope(value: unknown): value is StructuredTextEnvelope {
  if (!isRecord(value)) return false;
  return isDastDocument(Reflect.get(value, "value")) && isRecord(Reflect.get(value, "blocks"));
}

function getStructuredTextBlockIds(value: StructuredTextEnvelope) {
  const cached = structuredTextBlockIdCache.get(value);
  if (cached) return cached;

  const rootValue = value.value;
  const computed = {
    blockIds: isDastDocument(rootValue) ? extractBlockIds(rootValue) : [],
    inlineBlockIds: isDastDocument(rootValue) ? extractInlineBlockIds(rootValue) : [],
  };
  structuredTextBlockIdCache.set(value, computed);
  return computed;
}

function parseBooleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === 1) return true;
  if (value === 0) return false;
  return null;
}

function pickLocalizedValue(
  rawValue: unknown,
  localeOptions: LocaleProjectionOptions,
): unknown {
  if (!isRecord(rawValue)) return rawValue ?? null;

  const locale = localeOptions.locale;
  if (locale) {
    const localized = Reflect.get(rawValue, locale);
    if (localized !== undefined && localized !== null) return localized;
  }

  for (const fallback of localeOptions.fallbackLocales ?? []) {
    const localized = Reflect.get(rawValue, fallback);
    if (localized !== undefined && localized !== null) return localized;
  }

  const firstDefined = Object.values(rawValue).find((value) => value !== undefined && value !== null);
  return firstDefined ?? null;
}

function buildFieldNameMap(fields: readonly ParsedFieldRow[]) {
  return Object.fromEntries(fields.map((field) => [toCamelCase(field.api_key), field.api_key]));
}

function buildFieldsByGqlName(fields: readonly ParsedFieldRow[]) {
  return new Map(fields.map((field) => [toCamelCase(field.api_key), field]));
}

function getOperation(document: DocumentNode): OperationDefinitionNode | null {
  const operations = document.definitions.filter((definition): definition is OperationDefinitionNode => definition.kind === Kind.OPERATION_DEFINITION);
  return operations.length === 1 ? operations[0] : null;
}

function buildFragmentMap(document: DocumentNode) {
  return new Map(
    document.definitions
      .filter((definition): definition is FragmentDefinitionNode => definition.kind === Kind.FRAGMENT_DEFINITION)
      .map((definition) => [definition.name.value, definition]),
  );
}

function resolveValueNode(node: ValueNode, variables: Record<string, unknown> | undefined): unknown {
  switch (node.kind) {
    case Kind.VARIABLE:
      return variables?.[node.name.value];
    case Kind.NULL:
      return null;
    case Kind.INT:
      return Number.parseInt(node.value, 10);
    case Kind.FLOAT:
      return Number.parseFloat(node.value);
    case Kind.STRING:
    case Kind.ENUM:
      return node.value;
    case Kind.BOOLEAN:
      return node.value;
    case Kind.LIST:
      return node.values.map((value) => resolveValueNode(value, variables));
    case Kind.OBJECT:
      return Object.fromEntries(node.fields.map((field) => [field.name.value, resolveValueNode(field.value, variables)]));
  }
}

function getArgumentValue(
  args: readonly ArgumentNode[] | undefined,
  name: string,
  variables: Record<string, unknown> | undefined,
): unknown {
  const node = args?.find((arg) => arg.name.value === name);
  return node ? resolveValueNode(node.value, variables) : undefined;
}

function collectSelections(
  selectionSet: SelectionSetNode | undefined,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
): readonly SelectionNode[] | null {
  if (!selectionSet) return [];
  const selections: SelectionNode[] = [];
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const fragment = fragments.get(selection.name.value);
      if (!fragment) return null;
      const fragmentSelections = collectSelections(fragment.selectionSet, fragments);
      if (!fragmentSelections) return null;
      selections.push(...fragmentSelections);
      continue;
    }
    selections.push(selection);
  }
  return selections;
}

function isScalarField(field: ParsedFieldRow) {
  return !["link", "links", "structured_text", "media", "media_gallery", "lat_lon", "seo", "color", "video"].includes(field.field_type);
}

function buildStructuredTextBlocksPlan(
  selection: FieldNode,
  metadata: ExecutorMetadata,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  variables: Record<string, unknown> | undefined,
): StructuredTextBlocksPlan | null {
  const selections = collectSelections(selection.selectionSet, fragments);
  if (!selections) return null;

  let includeTypename = false;
  const selectionsByBlockApiKey = new Map<string, readonly FieldPlan[]>();

  for (const entry of selections) {
    if (entry.kind === Kind.FIELD) {
      if (entry.name.value === "__typename" && !entry.selectionSet) {
        includeTypename = true;
        continue;
      }
      return null;
    }
    if (entry.kind !== Kind.INLINE_FRAGMENT || !entry.typeCondition) return null;
    const blockMeta = metadata.blockByTypeName.get(entry.typeCondition.name.value);
    if (!blockMeta) return null;
    const nestedSelections = buildFieldPlans(blockMeta, entry.selectionSet, metadata, fragments, variables);
    if (!nestedSelections) return null;
    selectionsByBlockApiKey.set(blockMeta.model.api_key, nestedSelections);
  }

  return {
    includeTypename,
    selectionsByBlockApiKey,
  };
}

function buildFieldPlans(
  model: RootModelMeta | BlockModelMeta,
  selectionSet: SelectionSetNode | undefined,
  metadata: ExecutorMetadata,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  variables: Record<string, unknown> | undefined,
): readonly FieldPlan[] | null {
  const selections = collectSelections(selectionSet, fragments);
  if (!selections) return null;

  const plans: FieldPlan[] = [];
  for (const selection of selections) {
    if (selection.kind !== Kind.FIELD) return null;
    if (selection.name.value === "id") {
      if (selection.selectionSet) return null;
      plans.push({ kind: "id", responseKey: selection.alias?.value ?? selection.name.value });
      continue;
    }
    if (selection.name.value === "__typename") {
      if (selection.selectionSet) return null;
      plans.push({
        kind: "typename",
        responseKey: selection.alias?.value ?? selection.name.value,
        typeName: model.typeName,
      });
      continue;
    }
    if (selection.name.value.startsWith("_")) return null;

    const field = model.fieldsByGqlName.get(selection.name.value);
    if (!field) return null;
    const responseKey = selection.alias?.value ?? selection.name.value;

    if (isScalarField(field)) {
      if (selection.selectionSet) return null;
      const locale = getArgumentValue(selection.arguments, "locale", variables);
      const fallbackLocales = getArgumentValue(selection.arguments, "fallbackLocales", variables);
      plans.push({
        kind: "scalar",
        responseKey,
        field,
        localeOptions: typeof locale === "string" || isStringArray(fallbackLocales)
          ? {
              locale: typeof locale === "string" ? locale : undefined,
              fallbackLocales: isStringArray(fallbackLocales) ? fallbackLocales : undefined,
            }
          : undefined,
      });
      continue;
    }

    if (field.field_type === "link") {
      const targets = getLinkTargets(field.validators);
      if (!targets || targets.length !== 1 || !selection.selectionSet) return null;
      const target = metadata.contentByApiKey.get(targets[0]);
      if (!target) return null;
      const nestedSelections = buildFieldPlans(target, selection.selectionSet, metadata, fragments, variables);
      if (!nestedSelections) return null;
      plans.push({
        kind: "link",
        responseKey,
        field,
        target,
        selections: nestedSelections,
      });
      continue;
    }

    if (field.field_type === "structured_text") {
      const nestedSelections = collectSelections(selection.selectionSet, fragments);
      if (!nestedSelections) return null;
      let valueSelected = false;
      let blocksPlan: StructuredTextBlocksPlan | null = null;
      let inlineBlocksPlan: StructuredTextBlocksPlan | null = null;
      for (const nestedSelection of nestedSelections) {
        if (nestedSelection.kind !== Kind.FIELD) return null;
        if (nestedSelection.name.value === "value" && !nestedSelection.selectionSet) {
          valueSelected = true;
          continue;
        }
        if (nestedSelection.name.value === "blocks") {
          blocksPlan = buildStructuredTextBlocksPlan(nestedSelection, metadata, fragments, variables);
          if (!blocksPlan) return null;
          continue;
        }
        if (nestedSelection.name.value === "inlineBlocks") {
          inlineBlocksPlan = buildStructuredTextBlocksPlan(nestedSelection, metadata, fragments, variables);
          if (!inlineBlocksPlan) return null;
          continue;
        }
        return null;
      }
      plans.push({
        kind: "structured_text",
        responseKey,
        field,
        valueSelected,
        blocksPlan,
        inlineBlocksPlan,
      });
      continue;
    }

    return null;
  }

  return plans;
}

function buildRootPlan(
  document: DocumentNode,
  variables: Record<string, unknown> | undefined,
  metadata: ExecutorMetadata,
): RootPlan | null {
  const operation = getOperation(document);
  if (!operation || operation.operation !== "query") return null;
  if (operation.selectionSet.selections.length !== 1) return null;
  const rootSelection = operation.selectionSet.selections[0];
  if (rootSelection.kind !== Kind.FIELD) return null;
  const model = metadata.contentByRootField.get(rootSelection.name.value);
  if (!model) return null;

  const fragments = buildFragmentMap(document);
  const selections = buildFieldPlans(model, rootSelection.selectionSet, metadata, fragments, variables);
  if (!selections) return null;

  const responseKey = rootSelection.alias?.value ?? rootSelection.name.value;
  if (rootSelection.name.value === model.listName) {
    const first = getArgumentValue(rootSelection.arguments, "first", variables);
    const skip = getArgumentValue(rootSelection.arguments, "skip", variables);
    const orderBy = getArgumentValue(rootSelection.arguments, "orderBy", variables);
    const filter = getArgumentValue(rootSelection.arguments, "filter", variables);
    const locale = getArgumentValue(rootSelection.arguments, "locale", variables);
    const fallbackLocales = getArgumentValue(rootSelection.arguments, "fallbackLocales", variables);
    return {
      responseKey,
      kind: "list",
      model,
      args: {
        filter: isRecord(filter) ? filter : undefined,
        orderBy: isStringArray(orderBy) ? orderBy : undefined,
        first: typeof first === "number" ? first : undefined,
        skip: typeof skip === "number" ? skip : undefined,
        locale: typeof locale === "string" ? locale : undefined,
        fallbackLocales: isStringArray(fallbackLocales) ? fallbackLocales : undefined,
      },
      selections,
    };
  }

  const filter = getArgumentValue(rootSelection.arguments, "filter", variables);
  const id = getArgumentValue(rootSelection.arguments, "id", variables);
  const locale = getArgumentValue(rootSelection.arguments, "locale", variables);
  const fallbackLocales = getArgumentValue(rootSelection.arguments, "fallbackLocales", variables);
  return {
    responseKey,
    kind: "single",
    model,
    args: {
      filter: isRecord(filter) ? filter : undefined,
      id: typeof id === "string" || typeof id === "number" ? id : undefined,
      locale: typeof locale === "string" ? locale : undefined,
      fallbackLocales: isStringArray(fallbackLocales) ? fallbackLocales : undefined,
    },
    selections,
  };
}

function scalarValue(field: ParsedFieldRow, row: DynamicRow, localeOptions: LocaleProjectionOptions): unknown {
  const value = row[field.api_key];
  if (field.field_type === "boolean") return parseBooleanValue(value);
  if (field.localized) return pickLocalizedValue(value, localeOptions);
  return value ?? null;
}

function mergeLocaleOptions(
  base: LocaleProjectionOptions,
  override: LocaleProjectionOptions | undefined,
): LocaleProjectionOptions {
  if (!override) return base;
  return {
    locale: override.locale ?? base.locale,
    fallbackLocales: override.fallbackLocales ?? base.fallbackLocales,
  };
}

function projectStructuredText(
  value: StructuredTextEnvelope,
  plan: Extract<FieldPlan, { kind: "structured_text" }>,
  linkBuckets: ReadonlyMap<string, ReadonlyMap<string, DynamicRow>>,
  localeOptions: LocaleProjectionOptions,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (plan.valueSelected) {
    result.value = value.value;
  }

  if (plan.blocksPlan) {
    const { blockIds } = getStructuredTextBlockIds(value);
    result.blocks = blockIds
      .map((blockId) => projectBlock(blockId, value.blocks[blockId], plan.blocksPlan!, linkBuckets, localeOptions))
      .filter((entry) => entry !== null);
  }

  if (plan.inlineBlocksPlan) {
    const { inlineBlockIds } = getStructuredTextBlockIds(value);
    result.inlineBlocks = inlineBlockIds
      .map((blockId) => projectBlock(blockId, value.blocks[blockId], plan.inlineBlocksPlan!, linkBuckets, localeOptions))
      .filter((entry) => entry !== null);
  }

  return result;
}

function projectBlock(
  blockId: string,
  rawBlock: unknown,
  plan: StructuredTextBlocksPlan,
  linkBuckets: ReadonlyMap<string, ReadonlyMap<string, DynamicRow>>,
  localeOptions: LocaleProjectionOptions,
): Record<string, unknown> | null {
  if (!isRecord(rawBlock)) return null;
  const blockType = Reflect.get(rawBlock, "_type");
  if (typeof blockType !== "string") return null;
  const blockSelections = plan.selectionsByBlockApiKey.get(blockType) ?? [];
  const result: Record<string, unknown> = {};

  if (plan.includeTypename) {
    result.__typename = `${toTypeName(blockType)}Record`;
  }

  for (const selection of blockSelections) {
    if (selection.kind === "id") {
      result[selection.responseKey] = blockId;
      continue;
    }
    if (selection.kind === "typename") {
      result[selection.responseKey] = selection.typeName;
      continue;
    }
    if (selection.kind === "scalar") {
      result[selection.responseKey] = scalarValue(selection.field, rawBlock, mergeLocaleOptions(localeOptions, selection.localeOptions));
      continue;
    }
    if (selection.kind === "structured_text") {
      const nestedValue = Reflect.get(rawBlock, selection.field.api_key);
      if (!isStructuredTextEnvelope(nestedValue)) return null;
      result[selection.responseKey] = projectStructuredText(nestedValue, selection, linkBuckets, localeOptions);
      continue;
    }
    if (selection.kind === "link") {
      const linkedId = Reflect.get(rawBlock, selection.field.api_key);
      if (typeof linkedId !== "string") {
        result[selection.responseKey] = null;
        continue;
      }
      const bucket = linkBuckets.get(getLinkBucketKey(selection.field.api_key, selection.target.model.api_key));
      const linkedRecord = bucket?.get(linkedId);
      result[selection.responseKey] = linkedRecord
        ? projectRow(linkedRecord, selection.target, selection.selections, linkBuckets, localeOptions)
        : null;
      continue;
    }
  }

  return result;
}

function projectRow(
  row: DynamicRow,
  model: RootModelMeta,
  selections: readonly FieldPlan[],
  linkBuckets: ReadonlyMap<string, ReadonlyMap<string, DynamicRow>>,
  localeOptions: LocaleProjectionOptions,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === "id") {
      result[selection.responseKey] = row.id ?? null;
      continue;
    }
    if (selection.kind === "typename") {
      result[selection.responseKey] = selection.typeName;
      continue;
    }
    if (selection.kind === "scalar") {
      result[selection.responseKey] = scalarValue(selection.field, row, mergeLocaleOptions(localeOptions, selection.localeOptions));
      continue;
    }
    if (selection.kind === "link") {
      const prefetched = row[`__prefetch_${selection.field.api_key}`];
      if (isRecord(prefetched)) {
        result[selection.responseKey] = projectRow(
          decodeSnapshot(prefetched, false),
          selection.target,
          selection.selections,
          linkBuckets,
          localeOptions,
        );
        continue;
      }
      const linkedId = row[selection.field.api_key];
      if (typeof linkedId !== "string") {
        result[selection.responseKey] = null;
        continue;
      }
      const bucket = linkBuckets.get(getLinkBucketKey(selection.field.api_key, selection.target.model.api_key));
      const linkedRecord = bucket?.get(linkedId);
      result[selection.responseKey] = linkedRecord
        ? projectRow(linkedRecord, selection.target, selection.selections, linkBuckets, localeOptions)
        : null;
      continue;
    }
    if (selection.kind === "structured_text") {
      const rawValue = row[selection.field.api_key];
      const value = selection.field.localized
        ? pickLocalizedValue(rawValue, localeOptions)
        : rawValue;
      result[selection.responseKey] = isStructuredTextEnvelope(value)
        ? projectStructuredText(value, selection, linkBuckets, localeOptions)
        : null;
    }
  }
  return result;
}

function collectRootLinkPlans(selections: readonly FieldPlan[]) {
  return selections.filter((selection): selection is Extract<FieldPlan, { kind: "link" }> => selection.kind === "link");
}

function collectStructuredTextPlans(selections: readonly FieldPlan[]) {
  return selections.filter((selection): selection is Extract<FieldPlan, { kind: "structured_text" }> => selection.kind === "structured_text");
}

function buildLinkedRecordSelectClause(
  model: RootModelMeta,
  selections: readonly FieldPlan[],
  includeDrafts: boolean,
) {
  const columns = new Set<string>(["id"]);
  if (!includeDrafts) {
    columns.add("_published_snapshot");
  }

  for (const selection of selections) {
    if (selection.kind === "scalar" || selection.kind === "link" || selection.kind === "structured_text") {
      columns.add(selection.field.api_key);
    }
  }

  return `SELECT ${[...columns].map((column) => `"${model.tableName}"."${column}"`).join(", ")}`;
}

function buildRootSelectClause(
  plan: RootPlan,
  includeDrafts: boolean,
) {
  const columns = new Set<string>(["id"]);
  if (!includeDrafts) {
    columns.add("_published_snapshot");
  }

  for (const selection of plan.selections) {
    if (selection.kind === "scalar" || selection.kind === "link" || selection.kind === "structured_text") {
      columns.add(selection.field.api_key);
    }
  }

  const baseColumns = [...columns].map((column) => `"${plan.model.tableName}"."${column}"`);
  const linkPrefetchSpecs = buildRootLinkPrefetchSpecs(plan);
  const selectParts = [
    ...baseColumns,
    ...linkPrefetchSpecs.map((spec) => spec.sqlExpression),
  ];
  return `SELECT ${selectParts.join(", ")}`;
}

function mergeStructuredTextMaterializePlan(
  target: Map<string, Map<string, StructuredTextMaterializePlan>>,
  source: StructuredTextMaterializePlan,
) {
  for (const [blockApiKey, fieldPlans] of source.fieldsByBlockApiKey) {
    const targetFieldPlans = target.get(blockApiKey) ?? new Map<string, StructuredTextMaterializePlan>();
    for (const [fieldApiKey, nestedPlan] of fieldPlans) {
      const existing = targetFieldPlans.get(fieldApiKey);
      if (existing) {
        const merged = new Map<string, Map<string, StructuredTextMaterializePlan>>();
        mergeStructuredTextMaterializePlan(merged, existing);
        mergeStructuredTextMaterializePlan(merged, nestedPlan);
        targetFieldPlans.set(fieldApiKey, { fieldsByBlockApiKey: merged });
        continue;
      }
      targetFieldPlans.set(fieldApiKey, nestedPlan);
    }
    target.set(blockApiKey, targetFieldPlans);
  }
}

function appendStructuredTextMaterializePlan(
  target: Map<string, Map<string, StructuredTextMaterializePlan>>,
  blocksPlan: StructuredTextBlocksPlan | null,
) {
  if (!blocksPlan) return;

  for (const [blockApiKey, selections] of blocksPlan.selectionsByBlockApiKey) {
    const fieldPlans = target.get(blockApiKey) ?? new Map<string, StructuredTextMaterializePlan>();
    for (const selection of selections) {
      if (selection.kind !== "structured_text") continue;
      const nextPlan = buildStructuredTextMaterializePlan(selection);
      const existingPlan = fieldPlans.get(selection.field.api_key);
      if (existingPlan) {
        const merged = new Map<string, Map<string, StructuredTextMaterializePlan>>();
        mergeStructuredTextMaterializePlan(merged, existingPlan);
        mergeStructuredTextMaterializePlan(merged, nextPlan);
        fieldPlans.set(selection.field.api_key, { fieldsByBlockApiKey: merged });
        continue;
      }
      fieldPlans.set(selection.field.api_key, nextPlan);
    }
    if (fieldPlans.size > 0) {
      target.set(blockApiKey, fieldPlans);
    }
  }
}

function buildStructuredTextMaterializePlan(
  selection: Extract<FieldPlan, { kind: "structured_text" }>,
): StructuredTextMaterializePlan {
  const fieldsByBlockApiKey = new Map<string, Map<string, StructuredTextMaterializePlan>>();
  appendStructuredTextMaterializePlan(fieldsByBlockApiKey, selection.blocksPlan);
  appendStructuredTextMaterializePlan(fieldsByBlockApiKey, selection.inlineBlocksPlan);
  return { fieldsByBlockApiKey };
}

function createRunSql(sqlLayer: Layer.Layer<SqlClient.SqlClient>) {
  return <A>(
    effect: Effect.Effect<A, unknown, SqlClient.SqlClient>,
    options?: RunSqlOptions,
  ) => {
    const startedAt = performance.now();
    return Effect.runPromise(effect.pipe(Effect.provide(sqlLayer), Effect.orDie)).finally(() => {
      if (options?.recordMetrics === false) return;
      recordSqlMetrics(performance.now() - startedAt, { phase: options?.phase });
    });
  };
}

function buildRootLinkPrefetchSpecs(plan: RootPlan): readonly RootLinkPrefetchSpec[] {
  const specs: RootLinkPrefetchSpec[] = [];

  for (const selection of collectRootLinkPlans(plan.selections)) {
    const jsonParts = [`'id', linked.id`, `'_published_snapshot', linked._published_snapshot`];
    let supported = true;

    for (const nestedSelection of selection.selections) {
      if (nestedSelection.kind === "id" || nestedSelection.kind === "typename") continue;
      if (nestedSelection.kind !== "scalar") {
        supported = false;
        break;
      }
      jsonParts.push(`'${nestedSelection.field.api_key}', linked."${nestedSelection.field.api_key}"`);
    }

    if (!supported) continue;

    specs.push({
      fieldApiKey: selection.field.api_key,
      sqlExpression: `(SELECT json_object(${jsonParts.join(", ")}) FROM "${selection.target.tableName}" linked WHERE linked.id = "${plan.model.tableName}"."${selection.field.api_key}" LIMIT 1) AS "__prefetch_${selection.field.api_key}"`,
    });
  }

  return specs;
}

async function fetchExecutorMetadata(
  runSql: RunSqlFn,
): Promise<ExecutorMetadata> {
  const [models, blockModels, fields] = await Promise.all([
    runSql(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.unsafe<ModelRow>("SELECT * FROM models WHERE is_block = 0");
    }), { phase: "metadata" }),
    runSql(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.unsafe<ModelRow>("SELECT * FROM models WHERE is_block = 1");
    }), { phase: "metadata" }),
    runSql(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.unsafe<FieldRow>("SELECT * FROM fields ORDER BY position");
    }), { phase: "metadata" }),
  ]);

  const fieldsByModelId = new Map<string, ParsedFieldRow[]>();
  for (const field of fields) {
    const parsed = parseFieldValidators(field);
    const list = fieldsByModelId.get(field.model_id) ?? [];
    list.push(parsed);
    fieldsByModelId.set(field.model_id, list);
  }

  const contentByApiKey = new Map<string, RootModelMeta>();
  const contentByRootField = new Map<string, RootModelMeta>();
  for (const model of models) {
    const modelFields = fieldsByModelId.get(model.id) ?? [];
    const localizedCamelKeys = new Set(modelFields.filter((field) => field.localized).map((field) => toCamelCase(field.api_key)));
    const meta = {
      model,
      tableName: `content_${model.api_key}`,
      typeName: toContentTypeName(model.api_key),
      singleName: toCamelCase(model.api_key),
      listName: `all${pluralize(toTypeName(model.api_key))}`,
      fields: modelFields,
      fieldsByGqlName: buildFieldsByGqlName(modelFields),
      fieldNameMap: buildFieldNameMap(modelFields),
      localizedCamelKeys,
      localizedDbColumns: modelFields.filter((field) => field.localized).map((field) => field.api_key),
      jsonArrayFields: new Set(modelFields.filter((field) => field.field_type === "links" || field.field_type === "media_gallery").map((field) => toCamelCase(field.api_key))),
      jsonObjectIdFields: new Set(modelFields.filter((field) => field.field_type === "media").map((field) => toCamelCase(field.api_key))),
    } satisfies RootModelMeta;
    contentByApiKey.set(model.api_key, meta);
    contentByRootField.set(meta.singleName, meta);
    contentByRootField.set(meta.listName, meta);
  }

  const blockByApiKey = new Map<string, BlockModelMeta>();
  const blockByTypeName = new Map<string, BlockModelMeta>();
  for (const model of blockModels) {
    const modelFields = fieldsByModelId.get(model.id) ?? [];
    const meta = {
      model,
      typeName: `${toTypeName(model.api_key)}Record`,
      fields: modelFields,
      fieldsByGqlName: buildFieldsByGqlName(modelFields),
    } satisfies BlockModelMeta;
    blockByApiKey.set(model.api_key, meta);
    blockByTypeName.set(meta.typeName, meta);
  }

  return {
    contentByRootField,
    contentByApiKey,
    blockByApiKey,
    blockByTypeName,
  };
}

async function queryRoots(
  runSql: RunSqlFn,
  plan: RootPlan,
  context: CustomQueryContext,
): Promise<DynamicRow[] | DynamicRow | null> {
  const filterOpts: FilterCompilerOpts = {
    fieldIsLocalized: (fieldName) => plan.model.localizedCamelKeys.has(fieldName),
    fieldNameMap: plan.model.fieldNameMap,
    localizedDbColumns: [...plan.model.localizedDbColumns],
    jsonArrayFields: new Set(plan.model.jsonArrayFields),
    jsonObjectIdFields: new Set(plan.model.jsonObjectIdFields),
  };
  const selectClause = buildRootSelectClause(plan, context.includeDrafts);

  if (plan.kind === "list") {
    return runSql(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      let query = `${selectClause} FROM "${plan.model.tableName}"`;
      const conditions: string[] = [];
      let params: unknown[] = [];

      if (!context.includeDrafts) {
        conditions.push(`"_status" IN ('published', 'updated')`);
      }

      const compiled = compileFilterToSql(plan.args.filter, filterOpts);
      if (compiled) {
        conditions.push(compiled.where);
        params = compiled.params;
      }

      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(" AND ")}`;
      }

      const effectiveOrderBy = plan.args.orderBy
        ? [...plan.args.orderBy]
        : (typeof plan.model.model.ordering === "string" ? [plan.model.model.ordering] : undefined);
      const orderBy = compileOrderBy(effectiveOrderBy, filterOpts);
      if (orderBy) {
        query += ` ORDER BY ${orderBy}`;
      }

      query += ` LIMIT ?`;
      params.push(Math.min(plan.args.first ?? 20, 500));
      if (plan.args.skip && plan.args.skip > 0) {
        query += ` OFFSET ?`;
        params.push(plan.args.skip);
      }

      const rows = yield* sql.unsafe<DynamicRow>(query, params);
      return rows.map((row) => decodeSnapshot(deserializeRecord(row), context.includeDrafts));
    }), { phase: "root" });
  }

  if (plan.args.id !== undefined) {
    return runSql(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const conditions = ["id = ?"];
      if (!context.includeDrafts) {
        conditions.push(`"_status" IN ('published', 'updated')`);
      }
      const rows = yield* sql.unsafe<DynamicRow>(
        `${selectClause} FROM "${plan.model.tableName}" WHERE ${conditions.join(" AND ")}`,
        [plan.args.id],
      );
      if (rows.length === 0) return null;
      return decodeSnapshot(deserializeRecord(rows[0]), context.includeDrafts);
    }), { phase: "root" });
  }

  if (plan.args.filter) {
    const records = await runSql(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      let query = `${selectClause} FROM "${plan.model.tableName}"`;
      const conditions: string[] = [];
      let params: unknown[] = [];
      if (!context.includeDrafts) {
        conditions.push(`"_status" IN ('published', 'updated')`);
      }
      const compiled = compileFilterToSql(plan.args.filter, filterOpts);
      if (compiled) {
        conditions.push(compiled.where);
        params = compiled.params;
      }
      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(" AND ")}`;
      }
      query += ` LIMIT 1`;
      const rows = yield* sql.unsafe<DynamicRow>(query, params);
      return rows.map((row) => decodeSnapshot(deserializeRecord(row), context.includeDrafts));
    }), { phase: "root" });
    return records[0] ?? null;
  }

  if (plan.model.model.singleton) {
    const records = await runSql(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      let query = `${selectClause} FROM "${plan.model.tableName}"`;
      if (!context.includeDrafts) {
        query += ` WHERE "_status" IN ('published', 'updated')`;
      }
      query += ` LIMIT 1`;
      const rows = yield* sql.unsafe<DynamicRow>(query);
      return rows.map((row) => decodeSnapshot(deserializeRecord(row), context.includeDrafts));
    }), { phase: "root" });
    return records[0] ?? null;
  }

  return null;
}

async function materializeRootStructuredText(
  runSql: RunSqlFn,
  plan: RootPlan,
  rows: DynamicRow[],
): Promise<void> {
  const structuredTextPlans = collectStructuredTextPlans(plan.selections);
  if (structuredTextPlans.length === 0 || rows.length === 0) return;

  const requests: Array<{
    requestKey: string;
    allowedBlockApiKeys?: readonly string[];
    selectedNestedFieldsPlan?: StructuredTextMaterializePlan;
    parentContainerModelApiKey: string;
    parentBlockId: null;
    parentFieldApiKey: string;
    rootRecordId: string;
    rootFieldApiKey: string;
    rawValue: unknown;
  }> = [];

  // Track which (field, row, locale) tuples were submitted so we can reassemble locale maps
  const localizedKeys: Array<{
    rowId: string;
    fieldApiKey: string;
    locale: string;
    requestKey: string;
  }> = [];

  for (const row of rows) {
    const rowId = row.id;
    if (typeof rowId !== "string" && typeof rowId !== "number") continue;
    for (const selection of structuredTextPlans) {
      const rawValue = row[selection.field.api_key];
      if (!rawValue || isStructuredTextEnvelope(rawValue)) continue;

      if (selection.field.localized && isRecord(rawValue) && !isDastDocument(rawValue)) {
        // Localized field: rawValue is a locale map like { en: { schema, document }, is: { ... } }
        for (const [locale, localeValue] of Object.entries(rawValue)) {
          if (!localeValue || isStructuredTextEnvelope(localeValue)) continue;
          const requestKey = `${selection.field.api_key}:${locale}:${String(rowId)}`;
          requests.push({
            requestKey,
            allowedBlockApiKeys: undefined,
            selectedNestedFieldsPlan: buildStructuredTextMaterializePlan(selection),
            parentContainerModelApiKey: plan.model.model.api_key,
            parentBlockId: null,
            parentFieldApiKey: selection.field.api_key,
            rootRecordId: String(rowId),
            rootFieldApiKey: `${selection.field.api_key}:${locale}`,
            rawValue: localeValue,
          });
          localizedKeys.push({
            rowId: String(rowId),
            fieldApiKey: selection.field.api_key,
            locale,
            requestKey,
          });
        }
      } else {
        requests.push({
          requestKey: `${selection.field.api_key}:${String(rowId)}`,
          allowedBlockApiKeys: undefined,
          selectedNestedFieldsPlan: buildStructuredTextMaterializePlan(selection),
          parentContainerModelApiKey: plan.model.model.api_key,
          parentBlockId: null,
          parentFieldApiKey: selection.field.api_key,
          rootRecordId: String(rowId),
          rootFieldApiKey: selection.field.api_key,
          rawValue,
        });
      }
    }
  }

  if (requests.length === 0) return;

  const materialized = await runSql(materializeStructuredTextValues({ requests }), {
    recordMetrics: false,
    phase: "st_frontier",
  });

  // Reassemble localized envelopes into locale maps
  const localizedEnvelopes = new Map<string, Record<string, StructuredTextEnvelope | null>>();
  for (const entry of localizedKeys) {
    const mapKey = `${entry.fieldApiKey}:${entry.rowId}`;
    let localeMap = localizedEnvelopes.get(mapKey);
    if (!localeMap) {
      localeMap = {};
      localizedEnvelopes.set(mapKey, localeMap);
    }
    localeMap[entry.locale] = materialized.get(entry.requestKey) ?? null;
  }

  for (const row of rows) {
    const rowId = row.id;
    if (typeof rowId !== "string" && typeof rowId !== "number") continue;
    for (const selection of structuredTextPlans) {
      if (selection.field.localized) {
        const mapKey = `${selection.field.api_key}:${String(rowId)}`;
        const localeMap = localizedEnvelopes.get(mapKey);
        if (localeMap) {
          // Merge materialized envelopes back into the locale map, preserving any already-materialized locales
          const existing = row[selection.field.api_key];
          const merged: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
          for (const [locale, envelope] of Object.entries(localeMap)) {
            if (envelope) merged[locale] = envelope;
          }
          row[selection.field.api_key] = merged;
        }
      } else {
        const key = `${selection.field.api_key}:${String(rowId)}`;
        const envelope = materialized.get(key);
        if (envelope) {
          row[selection.field.api_key] = envelope;
        }
      }
    }
  }
}

function collectStructuredTextLinkIds(
  value: StructuredTextEnvelope,
  plan: Extract<FieldPlan, { kind: "structured_text" }>,
  idsByBucket: Map<string, Set<string>>,
  descriptorsByBucket: Map<string, LinkBucketDescriptor>,
) {
  const visitBlocks = (blockIds: readonly string[], blocksPlan: StructuredTextBlocksPlan | null) => {
    if (!blocksPlan) return;
    for (const blockId of blockIds) {
      const rawBlock = value.blocks[blockId];
      if (!isRecord(rawBlock)) continue;
      const blockType = Reflect.get(rawBlock, "_type");
      if (typeof blockType !== "string") continue;
      const blockSelections = blocksPlan.selectionsByBlockApiKey.get(blockType) ?? [];
      for (const selection of blockSelections) {
        if (selection.kind === "link") {
          const linkedId = Reflect.get(rawBlock, selection.field.api_key);
          if (typeof linkedId !== "string") continue;
          const bucketKey = getLinkBucketKey(selection.field.api_key, selection.target.model.api_key);
          const bucket = idsByBucket.get(bucketKey) ?? new Set<string>();
          bucket.add(linkedId);
          idsByBucket.set(bucketKey, bucket);
          if (!descriptorsByBucket.has(bucketKey)) {
            descriptorsByBucket.set(bucketKey, {
              target: selection.target,
              selections: selection.selections,
            });
          }
          continue;
        }
        if (selection.kind === "structured_text") {
          const nestedValue = Reflect.get(rawBlock, selection.field.api_key);
          if (!isStructuredTextEnvelope(nestedValue)) continue;
          collectStructuredTextLinkIds(nestedValue, selection, idsByBucket, descriptorsByBucket);
        }
      }
    }
  };

  const rootValue = value.value;
  if (!isDastDocument(rootValue)) return;
  const { blockIds, inlineBlockIds } = getStructuredTextBlockIds(value);
  visitBlocks(blockIds, plan.blocksPlan);
  visitBlocks(inlineBlockIds, plan.inlineBlocksPlan);
}

async function loadStructuredTextLinks(
  runSql: RunSqlFn,
  bucketQueries: readonly LinkBucketQuery[],
  context: CustomQueryContext,
): Promise<Map<string, Map<string, DynamicRow>>> {
  if (bucketQueries.length === 0) return new Map();

  const rowGroups = await runSql(
    runBatchedQueries<DynamicRow>(bucketQueries.map((entry) => entry.query), { phase: "link_frontier" }),
    { recordMetrics: false, phase: "link_frontier" },
  );
  return new Map(bucketQueries.map((entry, index) => {
    const linkedRows = (rowGroups[index] ?? []).map((row) => decodeSnapshot(deserializeRecord(row), context.includeDrafts));
    return [entry.bucketKey, new Map(
      linkedRows
        .map((row) => {
          const rowId = row.id;
          return typeof rowId === "string" ? [rowId, row] as const : null;
        })
        .filter((item): item is readonly [string, DynamicRow] => item !== null),
    )] as const;
  }));
}

function buildStructuredTextLinkQueries(
  plan: RootPlan,
  rows: readonly DynamicRow[],
  context: CustomQueryContext,
): readonly LinkBucketQuery[] {
  const idsByBucket = new Map<string, Set<string>>();
  const descriptorsByBucket = new Map<string, LinkBucketDescriptor>();

  for (const row of rows) {
    for (const selection of collectStructuredTextPlans(plan.selections)) {
      const rawValue = row[selection.field.api_key];
      if (isStructuredTextEnvelope(rawValue)) {
        collectStructuredTextLinkIds(rawValue, selection, idsByBucket, descriptorsByBucket);
      } else if (selection.field.localized && isRecord(rawValue)) {
        // Localized field: rawValue is a locale map of envelopes
        for (const localeValue of Object.values(rawValue)) {
          if (isStructuredTextEnvelope(localeValue)) {
            collectStructuredTextLinkIds(localeValue, selection, idsByBucket, descriptorsByBucket);
          }
        }
      }
    }
  }

  const queries: LinkBucketQuery[] = [];
  for (const [bucketKey, ids] of idsByBucket.entries()) {
    const [fieldApiKey, targetApiKey] = bucketKey.split(":");
    if (!fieldApiKey || !targetApiKey || ids.size === 0) {
      continue;
    }
    const descriptor = descriptorsByBucket.get(bucketKey);
    if (!descriptor) {
      continue;
    }
    const idList = [...ids];
    const placeholders = idList.map(() => "?").join(", ");
    let query = `${buildLinkedRecordSelectClause(descriptor.target, descriptor.selections, context.includeDrafts)} FROM "${descriptor.target.tableName}" WHERE id IN (${placeholders})`;
    if (!context.includeDrafts) {
      query += ` AND "_status" IN ('published', 'updated')`;
    }
    queries.push({
      bucketKey,
      query: {
        sql: query,
        params: idList,
      },
    });
  }
  return queries;
}

function buildRootLinkQueries(
  plan: RootPlan,
  rows: readonly DynamicRow[],
  context: CustomQueryContext,
): readonly LinkBucketQuery[] {
  const prefetchedFieldApiKeys = new Set(buildRootLinkPrefetchSpecs(plan).map((spec) => spec.fieldApiKey));
  const queries: LinkBucketQuery[] = [];
  for (const selection of collectRootLinkPlans(plan.selections)) {
    if (prefetchedFieldApiKeys.has(selection.field.api_key)) {
      continue;
    }
    const ids = [...new Set(rows.map((row) => row[selection.field.api_key]).filter((value): value is string => typeof value === "string"))];
    if (ids.length === 0) {
      continue;
    }

    const placeholders = ids.map(() => "?").join(", ");
    let query = `${buildLinkedRecordSelectClause(selection.target, selection.selections, context.includeDrafts)} FROM "${selection.target.tableName}" WHERE id IN (${placeholders})`;
    if (!context.includeDrafts) {
      query += ` AND "_status" IN ('published', 'updated')`;
    }

    queries.push({
      bucketKey: getLinkBucketKey(selection.field.api_key, selection.target.model.api_key),
      query: {
        sql: query,
        params: ids,
      },
    });
  }
  return queries;
}

export function createCustomQueryExecutor(sqlLayer: Layer.Layer<SqlClient.SqlClient>) {
  const runSql = createRunSql(sqlLayer);
  let metadataPromise: Promise<ExecutorMetadata> | null = null;

  function getMetadata() {
    if (!metadataPromise) {
      metadataPromise = fetchExecutorMetadata(runSql).catch((error) => {
        metadataPromise = null;
        throw error;
      });
    }
    return metadataPromise;
  }

  function invalidate() {
    metadataPromise = null;
  }

  async function tryExecute(params: {
    readonly document: DocumentNode;
    readonly schema: GraphQLSchema;
    readonly variables?: Record<string, unknown>;
    readonly context: CustomQueryContext;
  }): Promise<CustomExecutionResult | null> {
    const metadata = await getMetadata();
    const plan = buildRootPlan(params.document, params.variables, metadata);
    if (!plan) return null;

    const rootPayload = await queryRoots(runSql, plan, params.context);
    const rows = Array.isArray(rootPayload)
      ? rootPayload
      : rootPayload
        ? [rootPayload]
        : [];

    await materializeRootStructuredText(runSql, plan, rows);
    const rootLinkQueries = buildRootLinkQueries(plan, rows, params.context);
    const structuredTextLinkQueries = buildStructuredTextLinkQueries(plan, rows, params.context);
    const linkBuckets = await loadStructuredTextLinks(
      runSql,
      [...rootLinkQueries, ...structuredTextLinkQueries],
      params.context,
    );

    const data = plan.kind === "list"
      ? rows.map((row) => projectRow(row, plan.model, plan.selections, linkBuckets, {
        locale: plan.args.locale,
        fallbackLocales: plan.args.fallbackLocales,
      }))
      : rootPayload && !Array.isArray(rootPayload)
        ? projectRow(rootPayload, plan.model, plan.selections, linkBuckets, {
          locale: plan.args.locale,
          fallbackLocales: plan.args.fallbackLocales,
        })
        : null;

    return {
      data: { [plan.responseKey]: data },
      _trace: {
        path: "custom",
        rootPaths: { [plan.responseKey]: "custom" },
      },
    };
  }

  return {
    tryExecute,
    invalidate,
  };
}
