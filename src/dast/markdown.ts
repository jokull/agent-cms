/**
 * Editable DAST ↔ Markdown projection.
 *
 * This is NOT a generic serializer. Markdown is a projection of DAST for
 * editing text structure. DAST remains the source of truth.
 *
 * Contract:
 * - Block refs, inline refs survive as stable sentinels
 * - Deleting a sentinel deletes the ref; moving it reorders it
 * - Unsupported DAST metadata (link.meta, paragraph.style, heading.style,
 *   blockquote.attribution, code.highlight) is preserved in a sidecar map
 *   and re-attached on round-trip if the node is untouched
 * - No new blocks can be authored from markdown
 * - No block payloads are editable from markdown
 *
 * API:
 *   dastToEditableMarkdown(doc) → { markdown, preservation }
 *   editableMarkdownToDast(markdown, preservation) → DastDocument
 *
 * Legacy wrappers dastToMarkdown/markdownToDast are preserved for
 * non-editing use cases (export, display).
 */

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkGfm from "remark-gfm";
import type * as Mdast from "mdast";
import type {
  DastDocument,
  RootNode,
  BlockLevelNode,
  InlineNode,
  SpanNode,
  LinkNode,
  ItemLinkNode,
  Mark,
  ParagraphNode,
  HeadingNode,
  ListNode,
  ListItemNode,
  BlockquoteNode,
  CodeNode,
  TableNode,
  TableRowNode,
  TableCellNode,
} from "./types.js";

// ---------------------------------------------------------------------------
// Preservation map — stores metadata markdown cannot represent
// ---------------------------------------------------------------------------

/** Metadata for a block-level DAST node that has no markdown equivalent. */
export interface BlockNodeMeta {
  /** paragraph.style, heading.style */
  style?: string;
  /** blockquote.attribution */
  attribution?: string;
  /** code.highlight line numbers */
  highlight?: readonly number[];
}

/** Metadata for link/itemLink nodes. */
export interface LinkMeta {
  meta?: ReadonlyArray<{ id: string; value: string }>;
}

/**
 * Sidecar map preserving DAST metadata that markdown cannot represent.
 * Passed from dastToEditableMarkdown → editableMarkdownToDast.
 */
export interface PreservationMap {
  /**
   * Block-level node metadata, keyed by sentinel ID.
   * Sentinel IDs: "n0", "n1", ... assigned sequentially to every
   * block-level node during serialization.
   */
  nodes: Record<string, BlockNodeMeta>;
  /** Link metadata, keyed by URL. */
  links: Record<string, LinkMeta>;
  /** ItemLink metadata, keyed by item ID. */
  itemLinks: Record<string, LinkMeta>;
}

export interface EditableMarkdown {
  markdown: string;
  preservation: PreservationMap;
}

// ---------------------------------------------------------------------------
// Sentinel format — strict prefix to avoid collision with user HTML comments
// ---------------------------------------------------------------------------

const SENTINEL_PREFIX = "cms:";
// Block-level sentinels (standalone lines)
const BLOCK_SENTINEL_RE = /^<!--\s*cms:block:(\S+)\s*-->$/;
const NODE_SENTINEL_RE = /^<!--\s*cms:n(\d+)\s*-->$/;
// Inline sentinels
const INLINE_ITEM_SENTINEL_RE = /^<!--\s*cms:inlineItem:(\S+)\s*-->$/;
const INLINE_BLOCK_SENTINEL_RE = /^<!--\s*cms:inlineBlock:(\S+)\s*-->$/;
const LINK_META_SENTINEL_RE = /^<!--\s*cms:linkMeta:(\S+)\s*-->$/;
const ITEM_LINK_META_SENTINEL_RE = /^<!--\s*cms:itemLinkMeta:(\S+)\s*-->$/;

const ITEM_LINK_PREFIX = "itemLink:";
const MARK_RE = /^<mark>([\s\S]*)<\/mark>$/;
const UNDERLINE_RE = /^<u>([\s\S]*)<\/u>$/;

// ---------------------------------------------------------------------------
// DAST → Editable Markdown
// ---------------------------------------------------------------------------

interface SerializeContext {
  preservation: PreservationMap;
  nodeCounter: number;
  linkCounter: number;
  itemLinkCounter: number;
}

function nextNodeId(ctx: SerializeContext): string {
  return `n${ctx.nodeCounter++}`;
}

function nextLinkId(ctx: SerializeContext): string {
  return `l${ctx.linkCounter++}`;
}

function nextItemLinkId(ctx: SerializeContext): string {
  return `i${ctx.itemLinkCounter++}`;
}

function encodeSentinelValue(value: string): string {
  return encodeURIComponent(value);
}

function decodeSentinelValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function decodeHtmlText(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** Returns true if the block node has metadata worth preserving. */
function hasPreservableMeta(node: BlockLevelNode): boolean {
  switch (node.type) {
    case "paragraph":
    case "heading":
      return node.style !== undefined;
    case "blockquote":
      return node.attribution !== undefined;
    case "code":
      return node.highlight !== undefined && node.highlight.length > 0;
    default:
      return false;
  }
}

function extractBlockMeta(node: BlockLevelNode): BlockNodeMeta {
  const meta: BlockNodeMeta = {};
  switch (node.type) {
    case "paragraph":
    case "heading":
      if (node.style !== undefined) meta.style = node.style;
      break;
    case "blockquote":
      if (node.attribution !== undefined) meta.attribution = node.attribution;
      break;
    case "code":
      if (node.highlight !== undefined && node.highlight.length > 0) meta.highlight = node.highlight;
      break;
  }
  return meta;
}

function spanToMdast(span: SpanNode): Mdast.PhrasingContent {
  const marks = span.marks ?? [];

  if (marks.includes("code")) {
    return { type: "inlineCode", value: span.value };
  }

  let node: Mdast.PhrasingContent = { type: "text", value: span.value };

  if (marks.includes("highlight") || marks.includes("underline")) {
    let html = escapeHtmlText(span.value);
    if (marks.includes("highlight")) {
      html = `<mark>${html}</mark>`;
    }
    if (marks.includes("underline")) {
      html = `<u>${html}</u>`;
    }
    node = { type: "html", value: html };
  }
  if (marks.includes("strikethrough")) {
    node = { type: "delete", children: [node] };
  }
  if (marks.includes("emphasis")) {
    node = { type: "emphasis", children: [node] };
  }
  if (marks.includes("strong")) {
    node = { type: "strong", children: [node] };
  }

  return node;
}

function inlineToMdast(node: InlineNode, ctx: SerializeContext): Mdast.PhrasingContent[] {
  switch (node.type) {
    case "span":
      return [spanToMdast(node)];

    case "link": {
      const children: Mdast.PhrasingContent[] = [];
      if (node.meta && node.meta.length > 0) {
        const linkId = nextLinkId(ctx);
        ctx.preservation.links[linkId] = { meta: node.meta };
        children.push({ type: "html", value: `<!-- ${SENTINEL_PREFIX}linkMeta:${encodeSentinelValue(linkId)} -->` });
      }
      children.push(...node.children.map(spanToMdast));
      return [{
        type: "link",
        url: node.url,
        children,
      }];
    }

    case "itemLink": {
      const children: Mdast.PhrasingContent[] = [];
      if (node.meta && node.meta.length > 0) {
        const itemLinkId = nextItemLinkId(ctx);
        ctx.preservation.itemLinks[itemLinkId] = { meta: node.meta };
        children.push({ type: "html", value: `<!-- ${SENTINEL_PREFIX}itemLinkMeta:${encodeSentinelValue(itemLinkId)} -->` });
      }
      children.push(...node.children.map(spanToMdast));
      return [{
        type: "link",
        url: `${ITEM_LINK_PREFIX}${node.item}`,
        children,
      }];
    }

    case "inlineItem":
      return [{ type: "html", value: `<!-- ${SENTINEL_PREFIX}inlineItem:${encodeSentinelValue(node.item)} -->` }];

    case "inlineBlock":
      return [{ type: "html", value: `<!-- ${SENTINEL_PREFIX}inlineBlock:${encodeSentinelValue(node.item)} -->` }];
  }
}

function inlinesToMdast(children: readonly InlineNode[], ctx: SerializeContext): Mdast.PhrasingContent[] {
  return children.flatMap((c) => inlineToMdast(c, ctx));
}

function blockToMdast(node: BlockLevelNode, ctx: SerializeContext): Mdast.RootContent[] {
  // For block refs, emit sentinel with the block's own item ID
  if (node.type === "block") {
    return [{ type: "html", value: `<!-- ${SENTINEL_PREFIX}block:${encodeSentinelValue(node.item)} -->` }];
  }

  // Assign a node ID and optionally store metadata
  const nodeId = nextNodeId(ctx);
  const hasMeta = hasPreservableMeta(node);
  if (hasMeta) {
    ctx.preservation.nodes[nodeId] = extractBlockMeta(node);
  }

  // Emit node ID sentinel only if there is metadata to preserve
  const prefix: Mdast.RootContent[] = hasMeta
    ? [{ type: "html", value: `<!-- ${SENTINEL_PREFIX}${nodeId} -->` }]
    : [];

  switch (node.type) {
    case "paragraph":
      return [...prefix, { type: "paragraph", children: inlinesToMdast(node.children, ctx) }];

    case "heading":
      return [...prefix, { type: "heading", depth: node.level, children: inlinesToMdast(node.children, ctx) }];

    case "list":
      return [...prefix, {
        type: "list",
        ordered: node.style === "numbered",
        children: node.children.map((item) => listItemToMdast(item, ctx)),
      }];

    case "blockquote":
      return [...prefix, {
        type: "blockquote",
        children: node.children.map(
          (p): Mdast.Paragraph => ({
            type: "paragraph",
            children: inlinesToMdast(p.children, ctx),
          })
        ),
      }];

    case "code":
      return [...prefix, {
        type: "code",
        lang: node.language ?? null,
        value: node.code,
      }];

    case "thematicBreak":
      return [...prefix, { type: "thematicBreak" }];

    case "table":
      return [...prefix, {
        type: "table",
        children: node.children.map((row) => tableRowToMdast(row, ctx)),
      }];
  }
}

function listItemToMdast(item: ListItemNode, ctx: SerializeContext): Mdast.ListItem {
  return {
    type: "listItem",
    children: item.children.map((child): Mdast.BlockContent => {
      if (child.type === "paragraph") {
        return { type: "paragraph", children: inlinesToMdast(child.children, ctx) };
      }
      return {
        type: "list",
        ordered: child.style === "numbered",
        children: child.children.map((li) => listItemToMdast(li, ctx)),
      };
    }),
  };
}

function tableRowToMdast(row: TableRowNode, ctx: SerializeContext): Mdast.TableRow {
  return { type: "tableRow", children: row.children.map((cell) => tableCellToMdast(cell, ctx)) };
}

function tableCellToMdast(cell: TableCellNode, ctx: SerializeContext): Mdast.TableCell {
  const phrasing: Mdast.PhrasingContent[] = [];
  for (const child of cell.children) {
    if (child.type === "paragraph") {
      phrasing.push(...inlinesToMdast(child.children, ctx));
    } else {
      phrasing.push(...inlineToMdast(child, ctx));
    }
  }
  return { type: "tableCell", children: phrasing };
}

/**
 * Project a DAST document into editable markdown + preservation sidecar.
 * The markdown is a projection — DAST remains source of truth.
 */
export function dastToEditableMarkdown(doc: DastDocument): EditableMarkdown {
  const ctx: SerializeContext = {
    preservation: { nodes: {}, links: {}, itemLinks: {} },
    nodeCounter: 0,
    linkCounter: 0,
    itemLinkCounter: 0,
  };

  const mdastChildren: Mdast.RootContent[] = [];
  for (const child of doc.document.children) {
    mdastChildren.push(...blockToMdast(child, ctx));
  }

  const mdastRoot: Mdast.Root = { type: "root", children: mdastChildren };
  const markdown = unified().use(remarkGfm).use(remarkStringify).stringify(mdastRoot);

  return { markdown, preservation: ctx.preservation };
}

// ---------------------------------------------------------------------------
// Editable Markdown → DAST (with preservation)
// ---------------------------------------------------------------------------

/** Map of opening HTML tags to DAST marks */
const HTML_TAG_TO_MARK: Record<string, Mark> = {
  "<u>": "underline",
  "<mark>": "highlight",
};
const HTML_CLOSING_TAGS = new Set(["</u>", "</mark>"]);

function isOpeningMarkTag(value: string): value is keyof typeof HTML_TAG_TO_MARK {
  return value in HTML_TAG_TO_MARK;
}

function isClosingMarkTag(value: string): boolean {
  return HTML_CLOSING_TAGS.has(value);
}

function mergeHtmlTagSequences(nodes: readonly Mdast.PhrasingContent[]): Mdast.PhrasingContent[] {
  const result: Mdast.PhrasingContent[] = [];
  let i = 0;

  while (i < nodes.length) {
    const node = nodes[i];
    if (node.type === "html" && isOpeningMarkTag(node.value)) {
      let depth = 1;
      let raw = node.value;
      i++;
      while (i < nodes.length) {
        const current = nodes[i];
        if (current.type === "html") {
          raw += current.value;
          if (isOpeningMarkTag(current.value)) {
            depth++;
          } else if (isClosingMarkTag(current.value)) {
            depth--;
            i++;
            if (depth === 0) break;
            continue;
          }
        } else if (current.type === "text") {
          raw += escapeHtmlText(current.value);
        } else if (current.type === "inlineCode") {
          raw += escapeHtmlText(current.value);
        } else {
          result.push(node);
          i++;
          break;
        }
        i++;
      }
      if (depth === 0) {
        result.push({ type: "html", value: raw });
      }
    } else {
      result.push(node);
      i++;
    }
  }

  return result;
}

function addMark(inline: InlineNode, mark: Mark): InlineNode {
  if (inline.type !== "span") return inline;
  const existing = inline.marks ?? [];
  if (existing.includes(mark)) return inline;
  return { ...inline, marks: [...existing, mark] };
}

function mdastPhrasingToSpans(nodes: readonly Mdast.PhrasingContent[], pres: PreservationMap): SpanNode[] {
  const inlines = mdastPhrasingToDastInlines(nodes, pres);
  return inlines.map((inline) =>
    inline.type === "span" ? inline : { type: "span" as const, value: extractText(inline) }
  );
}

function extractLinkMetaId(
  children: readonly Mdast.PhrasingContent[],
  pattern: RegExp
): { metaId: string | null; children: readonly Mdast.PhrasingContent[] } {
  let metaId: string | null = null;
  const remaining: Mdast.PhrasingContent[] = [];

  for (const child of children) {
    if (child.type === "html") {
      const match = pattern.exec(child.value);
      if (match) {
        metaId = decodeSentinelValue(match[1]);
        continue;
      }
    }
    remaining.push(child);
  }

  return { metaId, children: remaining };
}

function extractText(node: InlineNode): string {
  switch (node.type) {
    case "span": return node.value;
    case "link": case "itemLink": return node.children.map((c) => c.value).join("");
    case "inlineItem": case "inlineBlock": return "";
  }
}

function mdastPhrasingToDastInlines(rawNodes: readonly Mdast.PhrasingContent[], pres: PreservationMap): InlineNode[] {
  const nodes = mergeHtmlTagSequences(rawNodes);
  const result: InlineNode[] = [];
  let pendingLinkMetaId: string | null = null;
  let pendingItemLinkMetaId: string | null = null;

  for (const node of nodes) {
    switch (node.type) {
      case "text":
        result.push({ type: "span", value: node.value });
        break;

      case "inlineCode":
        result.push({ type: "span", value: node.value, marks: ["code"] });
        break;

      case "strong":
        for (const inline of mdastPhrasingToDastInlines(node.children, pres)) {
          result.push(addMark(inline, "strong"));
        }
        break;

      case "emphasis":
        for (const inline of mdastPhrasingToDastInlines(node.children, pres)) {
          result.push(addMark(inline, "emphasis"));
        }
        break;

      case "delete":
        for (const inline of mdastPhrasingToDastInlines(node.children, pres)) {
          result.push(addMark(inline, "strikethrough"));
        }
        break;

      case "link": {
        if (node.url.startsWith(ITEM_LINK_PREFIX)) {
          const itemId = node.url.slice(ITEM_LINK_PREFIX.length);
          const extracted = extractLinkMetaId(node.children, ITEM_LINK_META_SENTINEL_RE);
          const children = mdastPhrasingToSpans(extracted.children, pres);
          const preserved = extracted.metaId
            ? pres.itemLinks[extracted.metaId]
            : (pendingItemLinkMetaId ? pres.itemLinks[pendingItemLinkMetaId] : undefined);
          const itemLink: ItemLinkNode = {
            type: "itemLink",
            item: itemId,
            children,
            ...(preserved?.meta ? { meta: preserved.meta } : {}),
          };
          result.push(itemLink);
          pendingItemLinkMetaId = null;
        } else {
          const extracted = extractLinkMetaId(node.children, LINK_META_SENTINEL_RE);
          const children = mdastPhrasingToSpans(extracted.children, pres);
          const preserved = extracted.metaId
            ? pres.links[extracted.metaId]
            : (pendingLinkMetaId ? pres.links[pendingLinkMetaId] : undefined);
          const link: LinkNode = {
            type: "link",
            url: node.url,
            children,
            ...(preserved?.meta ? { meta: preserved.meta } : {}),
          };
          result.push(link);
          pendingLinkMetaId = null;
        }
        break;
      }

      case "html": {
        const linkMetaMatch = LINK_META_SENTINEL_RE.exec(node.value);
        if (linkMetaMatch) {
          pendingLinkMetaId = decodeSentinelValue(linkMetaMatch[1]);
          break;
        }

        const itemLinkMetaMatch = ITEM_LINK_META_SENTINEL_RE.exec(node.value);
        if (itemLinkMetaMatch) {
          pendingItemLinkMetaId = decodeSentinelValue(itemLinkMetaMatch[1]);
          break;
        }

        const m1 = INLINE_ITEM_SENTINEL_RE.exec(node.value);
        if (m1) { result.push({ type: "inlineItem", item: decodeSentinelValue(m1[1]) }); break; }

        const m2 = INLINE_BLOCK_SENTINEL_RE.exec(node.value);
        if (m2) { result.push({ type: "inlineBlock", item: decodeSentinelValue(m2[1]) }); break; }

        const marked = parseMarkedHtml(node.value);
        if (marked) { result.push(marked); break; }

        // Unknown HTML — treat as plain text
        result.push({ type: "span", value: node.value });
        break;
      }

      case "break":
        result.push({ type: "span", value: "\n" });
        break;

      default:
        break;
    }
  }

  return result;
}

function parseMarkedHtml(value: string): SpanNode | null {
  const marks: Mark[] = [];
  let current = value;

  for (;;) {
    const underlineMatch = UNDERLINE_RE.exec(current);
    if (underlineMatch) {
      marks.push("underline");
      current = underlineMatch[1];
      continue;
    }

    const highlightMatch = MARK_RE.exec(current);
    if (highlightMatch) {
      marks.push("highlight");
      current = highlightMatch[1];
      continue;
    }

    break;
  }

  if (marks.length === 0) return null;
  return { type: "span", value: decodeHtmlText(current), marks };
}

/**
 * Parse markdown back into DAST, re-attaching preserved metadata.
 * The `pendingNodeId` is set when we encounter a `<!-- cms:nX -->` sentinel,
 * and consumed by the next block-level node.
 */
function mdastBlockToDast(
  node: Mdast.RootContent,
  pres: PreservationMap,
  nodeId: string | null,
): BlockLevelNode | null {
  const meta = nodeId ? pres.nodes[nodeId] : undefined;

  switch (node.type) {
    case "paragraph":
      return {
        type: "paragraph",
        children: mdastPhrasingToDastInlines(node.children, pres),
        ...(meta?.style !== undefined ? { style: meta.style } : {}),
      } satisfies ParagraphNode;

    case "heading":
      return {
        type: "heading",
        level: node.depth,
        children: mdastPhrasingToDastInlines(node.children, pres),
        ...(meta?.style !== undefined ? { style: meta.style } : {}),
      } satisfies HeadingNode;

    case "list":
      return {
        type: "list",
        style: node.ordered ? "numbered" : "bulleted",
        children: node.children.map((item) => mdastListItemToDast(item, pres)),
      } satisfies ListNode;

    case "blockquote":
      return {
        type: "blockquote",
        children: node.children
          .filter((c): c is Mdast.Paragraph => c.type === "paragraph")
          .map((p): ParagraphNode => ({
            type: "paragraph",
            children: mdastPhrasingToDastInlines(p.children, pres),
          })),
        ...(meta?.attribution !== undefined ? { attribution: meta.attribution } : {}),
      } satisfies BlockquoteNode;

    case "code":
      return {
        type: "code",
        code: node.value,
        ...(node.lang ? { language: node.lang } : {}),
        ...(meta?.highlight !== undefined ? { highlight: meta.highlight } : {}),
      } satisfies CodeNode;

    case "thematicBreak":
      return { type: "thematicBreak" };

    case "html": {
      const blockMatch = BLOCK_SENTINEL_RE.exec(node.value);
      if (blockMatch) {
        return { type: "block", item: decodeSentinelValue(blockMatch[1]) };
      }
      // Non-sentinel HTML — wrap in paragraph
      return { type: "paragraph", children: [{ type: "span", value: node.value }] };
    }

    case "table":
      return {
        type: "table",
        children: node.children.map((row) => mdastTableRowToDast(row, pres)) as [TableRowNode, ...TableRowNode[]],
      } satisfies TableNode;

    default:
      return null;
  }
}

function mdastListItemToDast(item: Mdast.ListItem, pres: PreservationMap): ListItemNode {
  const children: (ParagraphNode | ListNode)[] = [];
  for (const child of item.children) {
    if (child.type === "paragraph") {
      children.push({ type: "paragraph", children: mdastPhrasingToDastInlines(child.children, pres) });
    } else if (child.type === "list") {
      children.push({
        type: "list",
        style: child.ordered ? "numbered" : "bulleted",
        children: child.children.map((li) => mdastListItemToDast(li, pres)),
      });
    }
  }
  return { type: "listItem", children };
}

function mdastTableRowToDast(row: Mdast.TableRow, pres: PreservationMap): TableRowNode {
  return {
    type: "tableRow",
    children: row.children.map((cell) => mdastTableCellToDast(cell, pres)) as [TableCellNode, ...TableCellNode[]],
  };
}

function mdastTableCellToDast(cell: Mdast.TableCell, pres: PreservationMap): TableCellNode {
  const inlines = mdastPhrasingToDastInlines(cell.children, pres);
  if (inlines.length === 0) {
    return { type: "tableCell", children: [{ type: "paragraph", children: [{ type: "span", value: "" }] }] };
  }
  return { type: "tableCell", children: [{ type: "paragraph", children: inlines }] };
}

/**
 * Parse edited markdown back into DAST, re-attaching preserved metadata
 * from the sidecar. Sentinels that were deleted are omitted; sentinels
 * that were reordered are reflected in the output order.
 */
export function editableMarkdownToDast(markdown: string, preservation: PreservationMap): DastDocument {
  const mdastRoot = unified().use(remarkParse).use(remarkGfm).parse(markdown);

  const children: BlockLevelNode[] = [];
  let pendingNodeId: string | null = null;
  let pendingInlineSentinels: Mdast.PhrasingContent[] = [];

  for (const child of mdastRoot.children) {
    // Check for node ID sentinel: <!-- cms:nX -->
    if (child.type === "html") {
      const nodeMatch = NODE_SENTINEL_RE.exec(child.value);
      if (nodeMatch) {
        pendingNodeId = `n${nodeMatch[1]}`;
        continue; // sentinel consumed, next node gets this ID
      }

      if (LINK_META_SENTINEL_RE.test(child.value) || ITEM_LINK_META_SENTINEL_RE.test(child.value)) {
        pendingInlineSentinels.push(child);
        continue;
      }
    }

    const childWithPendingSentinels = pendingInlineSentinels.length > 0
      && (child.type === "paragraph" || child.type === "heading")
      ? {
          ...child,
          children: [...pendingInlineSentinels, ...child.children],
        }
      : child;
    pendingInlineSentinels = [];

    const dastNode = mdastBlockToDast(childWithPendingSentinels, preservation, pendingNodeId);
    pendingNodeId = null; // consumed
    if (dastNode) children.push(dastNode);
  }

  const root: RootNode = { type: "root", children };
  return { schema: "dast", document: root };
}

// ---------------------------------------------------------------------------
// Legacy wrappers (non-editing use cases: export, display)
// ---------------------------------------------------------------------------

/** Convert a DAST document to a CommonMark markdown string (lossy export). */
export function dastToMarkdown(doc: DastDocument): string {
  return dastToEditableMarkdown(doc).markdown;
}

/** Parse a CommonMark markdown string into a DAST document (no preservation). */
export function markdownToDast(markdown: string): DastDocument {
  return editableMarkdownToDast(markdown, { nodes: {}, links: {}, itemLinks: {} });
}
