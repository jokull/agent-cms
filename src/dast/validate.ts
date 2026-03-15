import type {
  DastDocument,
  RootNode,
  BlockLevelNode,
  InlineNode,
  ListItemNode,
  Mark,
} from "./types.js";

const VALID_MARKS: Set<string> = new Set([
  "strong", "emphasis", "underline", "strikethrough", "code", "highlight",
]);

const VALID_BLOCK_LEVEL_TYPES: Set<string> = new Set([
  "paragraph", "heading", "list", "blockquote", "code", "thematicBreak", "block",
]);

const VALID_INLINE_TYPES: Set<string> = new Set([
  "span", "link", "itemLink", "inlineItem", "inlineBlock",
]);

export interface ValidationError {
  path: string;
  message: string;
}

/**
 * Validate a DAST document structure.
 * Returns an array of errors (empty = valid).
 */
export function validateDast(doc: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!doc || typeof doc !== "object") {
    errors.push({ path: "", message: "Document must be an object" });
    return errors;
  }

  const d = doc as any;

  if (d.schema !== "dast") {
    errors.push({ path: "schema", message: 'schema must be "dast"' });
  }

  if (!d.document || typeof d.document !== "object") {
    errors.push({ path: "document", message: "document is required and must be an object" });
    return errors;
  }

  validateRoot(d.document, "document", errors);
  return errors;
}

function validateRoot(node: any, path: string, errors: ValidationError[]) {
  if (node.type !== "root") {
    errors.push({ path, message: 'Root node must have type "root"' });
    return;
  }

  if (!Array.isArray(node.children)) {
    errors.push({ path: `${path}.children`, message: "Root children must be an array" });
    return;
  }

  for (let i = 0; i < node.children.length; i++) {
    validateBlockLevelNode(node.children[i], `${path}.children[${i}]`, errors);
  }
}

function validateBlockLevelNode(node: any, path: string, errors: ValidationError[]) {
  if (!node || typeof node !== "object") {
    errors.push({ path, message: "Block-level node must be an object" });
    return;
  }

  if (!VALID_BLOCK_LEVEL_TYPES.has(node.type)) {
    errors.push({ path, message: `Invalid block-level node type: "${node.type}". Must be one of: ${[...VALID_BLOCK_LEVEL_TYPES].join(", ")}` });
    return;
  }

  switch (node.type) {
    case "paragraph":
      validateInlineChildren(node, path, errors);
      break;
    case "heading":
      if (typeof node.level !== "number" || node.level < 1 || node.level > 6) {
        errors.push({ path: `${path}.level`, message: "Heading level must be 1-6" });
      }
      validateInlineChildren(node, path, errors);
      break;
    case "list":
      if (node.style !== "bulleted" && node.style !== "numbered") {
        errors.push({ path: `${path}.style`, message: 'List style must be "bulleted" or "numbered"' });
      }
      if (!Array.isArray(node.children)) {
        errors.push({ path: `${path}.children`, message: "List children must be an array" });
      } else {
        for (let i = 0; i < node.children.length; i++) {
          validateListItem(node.children[i], `${path}.children[${i}]`, errors);
        }
      }
      break;
    case "blockquote":
      if (!Array.isArray(node.children)) {
        errors.push({ path: `${path}.children`, message: "Blockquote children must be an array" });
      } else {
        for (let i = 0; i < node.children.length; i++) {
          if (node.children[i]?.type !== "paragraph") {
            errors.push({ path: `${path}.children[${i}]`, message: "Blockquote children must be paragraphs" });
          } else {
            validateInlineChildren(node.children[i], `${path}.children[${i}]`, errors);
          }
        }
      }
      break;
    case "code":
      if (typeof node.code !== "string") {
        errors.push({ path: `${path}.code`, message: "Code node must have a code string" });
      }
      break;
    case "thematicBreak":
      // No additional validation needed
      break;
    case "block":
      if (typeof node.item !== "string" || !node.item) {
        errors.push({ path: `${path}.item`, message: "Block node must have an item ID string" });
      }
      break;
  }
}

function validateListItem(node: any, path: string, errors: ValidationError[]) {
  if (!node || node.type !== "listItem") {
    errors.push({ path, message: 'List item must have type "listItem"' });
    return;
  }
  if (!Array.isArray(node.children)) {
    errors.push({ path: `${path}.children`, message: "ListItem children must be an array" });
    return;
  }
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child?.type === "paragraph") {
      validateInlineChildren(child, `${path}.children[${i}]`, errors);
    } else if (child?.type === "list") {
      validateBlockLevelNode(child, `${path}.children[${i}]`, errors);
    } else {
      errors.push({ path: `${path}.children[${i}]`, message: "ListItem children must be paragraph or list" });
    }
  }
}

function validateInlineChildren(node: any, path: string, errors: ValidationError[]) {
  if (!Array.isArray(node.children)) {
    errors.push({ path: `${path}.children`, message: "Node children must be an array" });
    return;
  }
  for (let i = 0; i < node.children.length; i++) {
    validateInlineNode(node.children[i], `${path}.children[${i}]`, errors);
  }
}

function validateInlineNode(node: any, path: string, errors: ValidationError[]) {
  if (!node || typeof node !== "object") {
    errors.push({ path, message: "Inline node must be an object" });
    return;
  }

  if (!VALID_INLINE_TYPES.has(node.type)) {
    errors.push({ path, message: `Invalid inline node type: "${node.type}"` });
    return;
  }

  switch (node.type) {
    case "span":
      if (typeof node.value !== "string") {
        errors.push({ path: `${path}.value`, message: "Span must have a value string" });
      }
      if (node.marks) {
        if (!Array.isArray(node.marks)) {
          errors.push({ path: `${path}.marks`, message: "Marks must be an array" });
        } else {
          for (const mark of node.marks) {
            if (!VALID_MARKS.has(mark)) {
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
    case "itemLink":
      if (typeof node.item !== "string" || !node.item) {
        errors.push({ path: `${path}.item`, message: "ItemLink must have an item ID string" });
      }
      validateInlineChildren(node, path, errors);
      break;
    case "inlineItem":
      if (typeof node.item !== "string" || !node.item) {
        errors.push({ path: `${path}.item`, message: "InlineItem must have an item ID string" });
      }
      break;
    case "inlineBlock":
      if (typeof node.item !== "string" || !node.item) {
        errors.push({ path: `${path}.item`, message: "InlineBlock must have an item ID string" });
      }
      break;
  }
}

/**
 * Validate that a DAST document only contains block nodes at root level.
 * Used for "modular content" / page-builder fields where prose is not allowed.
 * Returns an array of errors (empty = valid).
 */
export function validateBlocksOnly(doc: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!doc || typeof doc !== "object") {
    errors.push({ path: "", message: "Document must be an object" });
    return errors;
  }

  const d = doc as any;
  if (!d.document?.children || !Array.isArray(d.document.children)) {
    return errors; // Let validateDast catch structural issues
  }

  for (let i = 0; i < d.document.children.length; i++) {
    const child = d.document.children[i];
    if (child?.type !== "block") {
      errors.push({
        path: `document.children[${i}]`,
        message: `Only block nodes are allowed at root level in a blocks-only field. Found "${child?.type ?? "unknown"}" node.`,
      });
    }
  }

  return errors;
}

/**
 * Extract all block IDs referenced in a DAST document.
 * Finds all `block` and `inlineBlock` node `item` values.
 */
export function extractBlockIds(doc: DastDocument): string[] {
  const ids: string[] = [];
  walkNodes(doc.document.children, ids);
  return ids;
}

function walkNodes(nodes: any[], ids: string[]) {
  for (const node of nodes) {
    if (node.type === "block" || node.type === "inlineBlock") {
      if (node.item) ids.push(node.item);
    }
    if (Array.isArray(node.children)) {
      walkNodes(node.children, ids);
    }
  }
}

/**
 * Extract all record link IDs referenced in a DAST document.
 * Finds all `itemLink` and `inlineItem` node `item` values.
 */
export function extractLinkIds(doc: DastDocument): string[] {
  const ids: string[] = [];
  walkLinkNodes(doc.document.children, ids);
  return ids;
}

function walkLinkNodes(nodes: any[], ids: string[]) {
  for (const node of nodes) {
    if (node.type === "itemLink" || node.type === "inlineItem") {
      if (node.item) ids.push(node.item);
    }
    if (Array.isArray(node.children)) {
      walkLinkNodes(node.children, ids);
    }
  }
}
