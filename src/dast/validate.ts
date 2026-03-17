const VALID_MARKS: Set<string> = new Set([
  "strong", "emphasis", "underline", "strikethrough", "code", "highlight",
]);

const VALID_BLOCK_LEVEL_TYPES: Set<string> = new Set([
  "paragraph", "heading", "list", "blockquote", "code", "thematicBreak", "block", "table",
]);

const VALID_INLINE_TYPES: Set<string> = new Set([
  "span", "link", "itemLink", "inlineItem", "inlineBlock",
]);

export interface ValidationError {
  path: string;
  message: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function getNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === "number" ? v : undefined;
}

function getArray(obj: Record<string, unknown>, key: string): unknown[] | undefined {
  const v = obj[key];
  return Array.isArray(v) ? v : undefined;
}

/**
 * Validate a DAST document structure.
 * Returns an array of errors (empty = valid).
 */
export function validateDast(doc: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!isRecord(doc)) {
    errors.push({ path: "", message: "Document must be an object" });
    return errors;
  }

  if (doc.schema !== "dast") {
    errors.push({ path: "schema", message: 'schema must be "dast"' });
  }

  if (!isRecord(doc.document)) {
    errors.push({ path: "document", message: "document is required and must be an object" });
    return errors;
  }

  validateRoot(doc.document, "document", errors);
  return errors;
}

function validateRoot(node: Record<string, unknown>, path: string, errors: ValidationError[]) {
  if (node.type !== "root") {
    errors.push({ path, message: 'Root node must have type "root"' });
    return;
  }

  const children = getArray(node, "children");
  if (!children) {
    errors.push({ path: `${path}.children`, message: "Root children must be an array" });
    return;
  }

  for (let i = 0; i < children.length; i++) {
    validateBlockLevelNode(children[i], `${path}.children[${i}]`, errors);
  }
}

function validateBlockLevelNode(node: unknown, path: string, errors: ValidationError[]) {
  if (!isRecord(node)) {
    errors.push({ path, message: "Block-level node must be an object" });
    return;
  }

  const type = getString(node, "type");
  if (!type || !VALID_BLOCK_LEVEL_TYPES.has(type)) {
    errors.push({ path, message: `Invalid block-level node type: "${type ?? "unknown"}". Must be one of: ${[...VALID_BLOCK_LEVEL_TYPES].join(", ")}` });
    return;
  }

  switch (type) {
    case "paragraph":
      validateInlineChildren(node, path, errors);
      break;
    case "heading": {
      const level = getNumber(node, "level");
      if (level === undefined || level < 1 || level > 6) {
        errors.push({ path: `${path}.level`, message: "Heading level must be 1-6" });
      }
      validateInlineChildren(node, path, errors);
      break;
    }
    case "list": {
      const style = getString(node, "style");
      if (style !== "bulleted" && style !== "numbered") {
        errors.push({ path: `${path}.style`, message: 'List style must be "bulleted" or "numbered"' });
      }
      const children = getArray(node, "children");
      if (!children) {
        errors.push({ path: `${path}.children`, message: "List children must be an array" });
      } else {
        for (let i = 0; i < children.length; i++) {
          validateListItem(children[i], `${path}.children[${i}]`, errors);
        }
      }
      break;
    }
    case "blockquote": {
      const children = getArray(node, "children");
      if (!children) {
        errors.push({ path: `${path}.children`, message: "Blockquote children must be an array" });
      } else {
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          if (!isRecord(child) || child.type !== "paragraph") {
            errors.push({ path: `${path}.children[${i}]`, message: "Blockquote children must be paragraphs" });
          } else {
            validateInlineChildren(child, `${path}.children[${i}]`, errors);
          }
        }
      }
      break;
    }
    case "code":
      if (typeof node.code !== "string") {
        errors.push({ path: `${path}.code`, message: "Code node must have a code string" });
      }
      break;
    case "thematicBreak":
      break;
    case "block": {
      const item = getString(node, "item");
      if (!item) {
        errors.push({ path: `${path}.item`, message: "Block node must have an item ID string" });
      }
      break;
    }
    case "table": {
      const children = getArray(node, "children");
      if (!children || children.length === 0) {
        errors.push({ path: `${path}.children`, message: "Table must have at least one row" });
      } else {
        for (let i = 0; i < children.length; i++) {
          validateTableRow(children[i], `${path}.children[${i}]`, errors);
        }
      }
      break;
    }
  }
}

function validateTableRow(node: unknown, path: string, errors: ValidationError[]) {
  if (!isRecord(node) || node.type !== "tableRow") {
    errors.push({ path, message: 'Table children must have type "tableRow"' });
    return;
  }
  const children = getArray(node, "children");
  if (!children || children.length === 0) {
    errors.push({ path: `${path}.children`, message: "Table row must have at least one cell" });
    return;
  }
  for (let i = 0; i < children.length; i++) {
    validateTableCell(children[i], `${path}.children[${i}]`, errors);
  }
}

function validateTableCell(node: unknown, path: string, errors: ValidationError[]) {
  if (!isRecord(node) || node.type !== "tableCell") {
    errors.push({ path, message: 'Table row children must have type "tableCell"' });
    return;
  }
  // Cells contain inline content (paragraphs with spans/links)
  const children = getArray(node, "children");
  if (!children) {
    errors.push({ path: `${path}.children`, message: "Table cell must have children" });
    return;
  }
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (isRecord(child) && child.type === "paragraph") {
      validateInlineChildren(child, `${path}.children[${i}]`, errors);
    } else {
      // Cells can also contain simple inline nodes directly
      validateInlineNode(child, `${path}.children[${i}]`, errors);
    }
  }
}

function validateListItem(node: unknown, path: string, errors: ValidationError[]) {
  if (!isRecord(node) || node.type !== "listItem") {
    errors.push({ path, message: 'List item must have type "listItem"' });
    return;
  }
  const children = getArray(node, "children");
  if (!children) {
    errors.push({ path: `${path}.children`, message: "ListItem children must be an array" });
    return;
  }
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (isRecord(child) && child.type === "paragraph") {
      validateInlineChildren(child, `${path}.children[${i}]`, errors);
    } else if (isRecord(child) && child.type === "list") {
      validateBlockLevelNode(child, `${path}.children[${i}]`, errors);
    } else {
      errors.push({ path: `${path}.children[${i}]`, message: "ListItem children must be paragraph or list" });
    }
  }
}

function validateInlineChildren(node: Record<string, unknown>, path: string, errors: ValidationError[]) {
  const children = getArray(node, "children");
  if (!children) {
    errors.push({ path: `${path}.children`, message: "Node children must be an array" });
    return;
  }
  for (let i = 0; i < children.length; i++) {
    validateInlineNode(children[i], `${path}.children[${i}]`, errors);
  }
}

function validateInlineNode(node: unknown, path: string, errors: ValidationError[]) {
  if (!isRecord(node)) {
    errors.push({ path, message: "Inline node must be an object" });
    return;
  }

  const type = getString(node, "type");
  if (!type || !VALID_INLINE_TYPES.has(type)) {
    errors.push({ path, message: `Invalid inline node type: "${type ?? "unknown"}"` });
    return;
  }

  switch (type) {
    case "span":
      if (typeof node.value !== "string") {
        errors.push({ path: `${path}.value`, message: "Span must have a value string" });
      }
      if (node.marks !== undefined) {
        const marks = getArray(node, "marks");
        if (!marks) {
          errors.push({ path: `${path}.marks`, message: "Marks must be an array" });
        } else {
          for (const mark of marks) {
            if (typeof mark !== "string" || !VALID_MARKS.has(mark)) {
              errors.push({ path: `${path}.marks`, message: `Invalid mark: "${mark}"` });
            }
          }
        }
      }
      break;
    case "link":
      if (typeof node.url !== "string" || !node.url) {
        errors.push({ path: `${path}.url`, message: "Link must have a url string" });
      }
      validateInlineChildren(node, path, errors);
      break;
    case "itemLink": {
      const item = getString(node, "item");
      if (!item) errors.push({ path: `${path}.item`, message: "ItemLink must have an item ID string" });
      validateInlineChildren(node, path, errors);
      break;
    }
    case "inlineItem": {
      const item = getString(node, "item");
      if (!item) errors.push({ path: `${path}.item`, message: "InlineItem must have an item ID string" });
      break;
    }
    case "inlineBlock": {
      const item = getString(node, "item");
      if (!item) errors.push({ path: `${path}.item`, message: "InlineBlock must have an item ID string" });
      break;
    }
  }
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
