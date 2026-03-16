import { GraphQLError, Kind, parse, type DocumentNode, type FragmentDefinitionNode, type OperationDefinitionNode, type SelectionSetNode } from "graphql";

export interface QueryLimitOptions {
  readonly maxDepth: number;
  readonly maxSelections: number;
}

interface QueryMetrics {
  readonly maxDepth: number;
  readonly selectionCount: number;
}

function computeSelectionMetrics(
  selectionSet: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
  depth: number,
  visitedFragments: Set<string>,
): QueryMetrics {
  let maxDepth = depth;
  let selectionCount = 0;

  for (const selection of selectionSet.selections) {
    switch (selection.kind) {
      case Kind.FIELD: {
        selectionCount += 1;
        if (selection.selectionSet) {
          const child = computeSelectionMetrics(selection.selectionSet, fragments, depth + 1, visitedFragments);
          selectionCount += child.selectionCount;
          maxDepth = Math.max(maxDepth, child.maxDepth);
        }
        break;
      }
      case Kind.INLINE_FRAGMENT: {
        const child = computeSelectionMetrics(selection.selectionSet, fragments, depth + 1, visitedFragments);
        selectionCount += child.selectionCount;
        maxDepth = Math.max(maxDepth, child.maxDepth);
        break;
      }
      case Kind.FRAGMENT_SPREAD: {
        if (visitedFragments.has(selection.name.value)) break;
        const fragment = fragments.get(selection.name.value);
        if (!fragment) break;
        const nextVisited = new Set(visitedFragments);
        nextVisited.add(selection.name.value);
        const child = computeSelectionMetrics(fragment.selectionSet, fragments, depth + 1, nextVisited);
        selectionCount += child.selectionCount;
        maxDepth = Math.max(maxDepth, child.maxDepth);
        break;
      }
    }
  }

  return { maxDepth, selectionCount };
}

function analyzeDocument(document: DocumentNode): QueryMetrics {
  const fragments = new Map<string, FragmentDefinitionNode>();
  const operations: OperationDefinitionNode[] = [];

  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    } else if (definition.kind === Kind.OPERATION_DEFINITION) {
      operations.push(definition);
    }
  }

  let maxDepth = 0;
  let selectionCount = 0;

  for (const operation of operations) {
    const metrics = computeSelectionMetrics(operation.selectionSet, fragments, 1, new Set());
    maxDepth = Math.max(maxDepth, metrics.maxDepth);
    selectionCount = Math.max(selectionCount, metrics.selectionCount);
  }

  return { maxDepth, selectionCount };
}

export function enforceQueryLimits(query: string, options: QueryLimitOptions): GraphQLError[] {
  let document: DocumentNode;
  try {
    document = parse(query);
  } catch {
    return [];
  }

  const metrics = analyzeDocument(document);
  const errors: GraphQLError[] = [];

  if (metrics.maxDepth > options.maxDepth) {
    errors.push(new GraphQLError(
      `Query depth ${metrics.maxDepth} exceeds limit ${options.maxDepth}`,
      {
        extensions: {
          code: "QUERY_DEPTH_LIMIT_EXCEEDED",
          http: { status: 400 },
          maxDepth: options.maxDepth,
          actualDepth: metrics.maxDepth,
        },
      }
    ));
  }

  if (metrics.selectionCount > options.maxSelections) {
    errors.push(new GraphQLError(
      `Query selection count ${metrics.selectionCount} exceeds limit ${options.maxSelections}`,
      {
        extensions: {
          code: "QUERY_COMPLEXITY_LIMIT_EXCEEDED",
          http: { status: 400 },
          maxSelections: options.maxSelections,
          actualSelections: metrics.selectionCount,
        },
      }
    ));
  }

  return errors;
}
