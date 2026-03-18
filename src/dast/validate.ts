import { ParseResult, Schema } from "effect";
import { DastDocumentSchema } from "./schema.js";

export interface ValidationError {
  path: string;
  message: string;
}

function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === "number") return `${acc}[${segment}]`;
    if (typeof segment === "symbol") return acc;
    if (acc.length === 0) return String(segment);
    return `${acc}.${String(segment)}`;
  }, "");
}

/**
 * Validate a DAST document structure.
 * Returns an array of errors (empty = valid).
 */
export function validateDast(doc: unknown): ValidationError[] {
  const result = Schema.decodeUnknownEither(DastDocumentSchema)(doc);

  if (result._tag === "Right") return [];

  const formatted = ParseResult.ArrayFormatter.formatErrorSync(result.left);
  return formatted.map((issue) => ({
    path: formatIssuePath(issue.path),
    message: issue.message,
  }));
}

/**
 * Validate that a DAST document only contains block nodes at root level.
 */
export function validateBlocksOnly(doc: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!isRecord(doc)) {
    errors.push({ path: "", message: "Document must be an object" });
    return errors;
  }

  const document = isRecord(doc.document) ? doc.document : undefined;
  if (!document) return errors;

  const children = getArray(document, "children");
  if (!children) return errors;

  for (let i = 0; i < children.length; i++) {
    const raw = children[i];
    const child = isRecord(raw) ? raw : undefined;
    if (!child || child.type !== "block") {
      errors.push({
        path: `document.children[${i}]`,
        message: `Only block nodes are allowed at root level in a blocks-only field. Found "${child?.type ?? "unknown"}" node.`,
      });
    }
  }

  return errors;
}

// --- Helpers used by extraction/pruning utilities ---

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function getArray(obj: Record<string, unknown>, key: string): unknown[] | undefined {
  const v = obj[key];
  return Array.isArray(v) ? v : undefined;
}

// --- Extraction utilities (operate on validated or raw data) ---

/**
 * Extract all block-level block IDs (type "block") from a DAST document.
 */
export function extractBlockIds(doc: { document: { children: readonly unknown[] } }): string[] {
  const ids: string[] = [];
  walkNodesForType([...doc.document.children], "block", ids);
  return ids;
}

/**
 * Extract all inline block IDs (type "inlineBlock") from a DAST document.
 */
export function extractInlineBlockIds(doc: { document: { children: readonly unknown[] } }): string[] {
  const ids: string[] = [];
  walkNodesForType([...doc.document.children], "inlineBlock", ids);
  return ids;
}

/**
 * Extract ALL block IDs (both "block" and "inlineBlock") from a DAST document.
 * Used for write orchestration where both types need to be stored.
 */
export function extractAllBlockIds(doc: { document: { children: readonly unknown[] } }): string[] {
  const ids: string[] = [];
  walkNodesForTypes([...doc.document.children], ["block", "inlineBlock"], ids);
  return ids;
}

function walkNodesForType(nodes: unknown[], targetType: string, ids: string[]) {
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    if (node.type === targetType && typeof node.item === "string") {
      ids.push(node.item);
    }
    const children = getArray(node, "children");
    if (children) walkNodesForType(children, targetType, ids);
  }
}

function walkNodesForTypes(nodes: unknown[], targetTypes: string[], ids: string[]) {
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    if (typeof node.type === "string" && targetTypes.includes(node.type) && typeof node.item === "string") {
      ids.push(node.item);
    }
    const children = getArray(node, "children");
    if (children) walkNodesForTypes(children, targetTypes, ids);
  }
}

/**
 * Extract all record link IDs referenced in a DAST document.
 */
export function extractLinkIds(doc: { document: { children: readonly unknown[] } }): string[] {
  const ids: string[] = [];
  walkLinkNodes([...doc.document.children], ids);
  return ids;
}

function walkLinkNodes(nodes: unknown[], ids: string[]) {
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    if ((node.type === "itemLink" || node.type === "inlineItem") && typeof node.item === "string") {
      ids.push(node.item);
    }
    const children = getArray(node, "children");
    if (children) walkLinkNodes(children, ids);
  }
}

/**
 * Remove block/inlineBlock nodes whose item ID is in the given set.
 * Returns a deep-cloned document with those nodes pruned from the tree.
 */
export function pruneBlockNodes(
  doc: { schema: string; document: { type: string; children: readonly unknown[] } },
  blockIdsToRemove: ReadonlySet<string>
): { schema: string; document: { type: string; children: unknown[] } } {
  function filterChildren(nodes: readonly unknown[]): unknown[] {
    const result: unknown[] = [];
    for (const node of nodes) {
      if (!isRecord(node)) {
        result.push(node);
        continue;
      }
      if (
        (node.type === "block" || node.type === "inlineBlock") &&
        typeof node.item === "string" &&
        blockIdsToRemove.has(node.item)
      ) {
        continue; // prune
      }
      const children = getArray(node, "children");
      if (children) {
        const filtered = filterChildren(children);
        result.push({ ...node, children: filtered });
      } else {
        result.push(node);
      }
    }
    return result;
  }

  return {
    schema: doc.schema,
    document: {
      type: doc.document.type,
      children: filterChildren(doc.document.children),
    },
  };
}
