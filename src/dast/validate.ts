import { isNumber, isObjectRecord, isString } from "../dynamic/row-types.js";
import { Cause, Option, Schema, SchemaIssue } from "effect";


import { DastDocumentSchema } from "./schema.js";
import type {
  BlockLevelNode,
  DastDocument,
  InlineNode,
  ParagraphNode,
  RootNode,
} from "./types.js";

export interface ValidationError {
  path: string;
  message: string;
}

function formatIssuePath(path: ReadonlyArray<unknown>): string {
  return path.reduce<string>((acc, segment) => {
    if (isNumber(segment)) return `${acc}[${segment}]`;
    if (isString(segment)) {
      if (acc.length === 0) return segment;
      return `${acc}.${segment}`;
    }
    return acc;
  }, "");
}

/**
 * Validate a DAST document structure.
 * Returns an array of errors (empty = valid).
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- schema validator: accepts arbitrary JSON input; the DastDocumentSchema decode IS the boundary parse.
export function validateDast(doc: unknown): ValidationError[] {
  const result = Schema.decodeUnknownExit(DastDocumentSchema)(doc);

  if (result._tag === "Success") return [];

  const error = Cause.findErrorOption(result.cause).pipe(Option.getOrThrow);
  const formatted = SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues;
  return formatted.map((issue) => ({
    path: formatIssuePath(issue.path ?? []),
    message: issue.message,
  }));
}

/**
 * Validate that a DAST document only contains block nodes at root level.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- schema validator: accepts arbitrary JSON input; the DastDocumentSchema decode IS the boundary parse.
export function validateBlocksOnly(doc: unknown): ValidationError[] {
  const decoded = Schema.decodeUnknownExit(DastDocumentSchema)(doc);
  if (decoded._tag === "Failure") return [];

  return decoded.value.document.children.flatMap((child, index) =>
    child.type === "block"
      ? []
      : [{
          path: `document.children[${index}]`,
          message: `Only block nodes are allowed at root level in a blocks-only field. Found "${child.type}" node.`,
        }],
  );
}

type DastLikeDocument = {
  document: {
    children: readonly unknown[];
    type?: string;
  };
};
type DastNode = RootNode | BlockLevelNode | InlineNode;

const BLOCK_LEVEL_NODE_TYPES = new Set<string>([
  "paragraph",
  "heading",
  "list",
  "blockquote",
  "code",
  "thematicBreak",
  "block",
  "table",
]);

/** Narrow unknown to a block-level DAST node via its type discriminant. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- runtime type guard: the discriminant check IS the boundary parse for raw DAST JSON nodes.
function isBlockLevelNode(value: unknown): value is BlockLevelNode {
  return isObjectRecord(value)
    && isString(value.type)
    && BLOCK_LEVEL_NODE_TYPES.has(value.type);
}

function visitDastNode(node: DastNode, visit: (node: DastNode) => void): void {
  visit(node);

  if ("children" in node) {
    for (const child of node.children) {
      if (!isObjectRecord(child)) continue;
      // SAFETY: every child of a DAST node is itself a DastNode per the
      // @agent-cms/dast node definitions (all children arrays hold DastNode members).
      visitDastNode(child as DastNode, visit);
    }
  }
}

// --- Extraction utilities (operate on validated or raw data) ---

/**
 * Extract all block-level block IDs (type "block") from a DAST document.
 */
export function extractBlockIds(doc: DastLikeDocument): string[] {
  const ids: string[] = [];
  visitDastNode({ type: "root", children: doc.document.children.filter(isBlockLevelNode) }, (node) => {
    if (node.type === "block") {
      ids.push(node.item);
    }
  });
  return ids;
}

/**
 * Extract all inline block IDs (type "inlineBlock") from a DAST document.
 */
export function extractInlineBlockIds(doc: DastLikeDocument): string[] {
  const ids: string[] = [];
  visitDastNode({ type: "root", children: doc.document.children.filter(isBlockLevelNode) }, (node) => {
    if (node.type === "inlineBlock") {
      ids.push(node.item);
    }
  });
  return ids;
}

/**
 * Extract ALL block IDs (both "block" and "inlineBlock") from a DAST document.
 * Used for write orchestration where both types need to be stored.
 */
export function extractAllBlockIds(doc: DastLikeDocument): string[] {
  const ids: string[] = [];
  visitDastNode({ type: "root", children: doc.document.children.filter(isBlockLevelNode) }, (node) => {
    if (node.type === "block" || node.type === "inlineBlock") {
      ids.push(node.item);
    }
  });
  return ids;
}

/**
 * Extract all record link IDs referenced in a DAST document.
 */
export function extractLinkIds(doc: DastLikeDocument): string[] {
  const ids: string[] = [];
  visitDastNode({ type: "root", children: doc.document.children.filter(isBlockLevelNode) }, (node) => {
    if (node.type === "itemLink" || node.type === "inlineItem") {
      ids.push(node.item);
    }
  });
  return ids;
}

/**
 * Remove block/inlineBlock nodes whose item ID is in the given set.
 * Returns a deep-cloned document with those nodes pruned from the tree.
 */
function mapNonEmpty<A, B>(
  arr: readonly [A, ...A[]],
  f: (a: A) => B
): readonly [B, ...B[]] {
  const [head, ...tail] = arr;
  return [f(head), ...tail.map(f)];
}

export function pruneBlockNodes(
  doc: {
    schema: string;
    document: {
      type: string;
      children: readonly unknown[];
    };
  },
  blockIdsToRemove: ReadonlySet<string>
): DastDocument {
  function isSpanOnlyChildren(node: InlineNode): node is Extract<InlineNode, { children: readonly unknown[] }> {
    return node.type === "link" || node.type === "itemLink";
  }

  function pruneInlineNode(node: InlineNode): InlineNode | null {
    if (node.type === "inlineBlock" && blockIdsToRemove.has(node.item)) {
      return null;
    }
    if (isSpanOnlyChildren(node)) {
      return node;
    }
    return node;
  }

  function pruneParagraphNode(node: ParagraphNode): ParagraphNode {
    return {
      ...node,
      children: node.children.map((child) => pruneInlineNode(child)).filter((child): child is InlineNode => child !== null),
    };
  }

  function pruneBlockLevelNode(node: BlockLevelNode): BlockLevelNode | null {
    if (node.type === "block" && blockIdsToRemove.has(node.item)) {
      return null;
    }

    switch (node.type) {
      case "paragraph":
        return pruneParagraphNode(node);
      case "heading":
        return {
          ...node,
          children: node.children.map((child) => pruneInlineNode(child)).filter((child): child is InlineNode => child !== null),
        };
      case "list":
        return {
          ...node,
          children: node.children.map((child) => ({
            ...child,
            children: child.children
              .map((nested) => pruneBlockLevelNode(nested))
              .filter((nested): nested is ParagraphNode | Extract<BlockLevelNode, { type: "list" }> => nested !== null && (nested.type === "paragraph" || nested.type === "list")),
          })),
        };
      case "blockquote":
        return {
          ...node,
          children: node.children.map((child) => pruneParagraphNode(child)),
        };
      case "table":
        return {
          ...node,
          children: mapNonEmpty(node.children, (row) => ({
            ...row,
            children: mapNonEmpty(row.children, (cell) => ({
              ...cell,
              children: mapNonEmpty(cell.children, pruneParagraphNode),
            })),
          })),
        };
      default:
        return node;
    }
  }

  return {
    schema: "dast",
    document: {
      type: "root",
      children: doc.document.children
        .filter(isBlockLevelNode)
        .map((child) => pruneBlockLevelNode(child))
        .filter((child): child is BlockLevelNode => child !== null),
    },
  };
}
