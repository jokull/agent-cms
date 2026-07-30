/**
 * Lossless(-modulo-normalization) codec between DAST and ProseMirror JSON.
 *
 * Known, deliberate normalizations (ticket 14 §DAST fidelity):
 * - Empty spans (`value: ""`) are dropped on load and never emitted on save —
 *   ProseMirror refuses zero-length text nodes; semantically lossless.
 * - Adjacent spans with identical marks inside the same link context merge.
 *
 * DAST `link`/`itemLink` are nodes wrapping spans; ProseMirror models links as
 * marks. dastToPm flattens the wrapper into a mark on each child text node;
 * pmToDast re-groups consecutive text nodes carrying the same link mark
 * instance back into one wrapper node.
 *
 * Unknown node types fail loudly. An editor that silently drops content it
 * does not recognise is the failure mode this whole design exists to avoid.
 */
import type {
  BlockLevelNode,
  DastDocument,
  InlineNode,
  ListItemNode,
  ListNode,
  Mark,
  ParagraphNode,
  SpanNode,
  TableCellNode,
  TableRowNode,
} from "./dast-types.js";
import { isMark } from "./dast-types.js";

// ProseMirror JSON shapes. The strict forms are what dastToPm constructs
// (assignable to Tiptap's Content under exactOptionalPropertyTypes); the
// Input forms are what pmToDast accepts (structurally matches getJSON()).
export interface PmMark {
  type: string;
  attrs?: Record<string, unknown>;
}
export interface PmNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  marks?: PmMark[];
  text?: string;
}
export interface PmMarkInput {
  type: string;
  attrs?: Record<string, unknown> | undefined;
}
export interface PmNodeInput {
  type: string;
  attrs?: Record<string, unknown> | undefined;
  content?: PmNodeInput[] | undefined;
  marks?: PmMarkInput[] | undefined;
  text?: string | undefined;
}

export class DastCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DastCodecError";
  }
}

function isSpanMark(name: string): name is Mark {
  return isMark(name);
}

// --- DAST → ProseMirror ---

function spanToPm(span: SpanNode, wrapper?: PmMark): PmNode | null {
  if (span.value === "") return null; // normalize: PM refuses empty text nodes
  const marks: PmMark[] = (span.marks ?? []).map((m) => ({ type: m }));
  if (wrapper) marks.push(wrapper);
  const node: PmNode = { type: "text", text: span.value };
  if (marks.length > 0) node.marks = marks;
  return node;
}

function inlineToPm(node: InlineNode): PmNode[] {
  switch (node.type) {
    case "span": {
      const pm = spanToPm(node);
      return pm ? [pm] : [];
    }
    case "link": {
      const mark: PmMark = { type: "link", attrs: { url: node.url, meta: node.meta ?? null } };
      return node.children.flatMap((span) => {
        const pm = spanToPm(span, mark);
        return pm ? [pm] : [];
      });
    }
    case "itemLink": {
      const mark: PmMark = { type: "itemLink", attrs: { item: node.item, meta: node.meta ?? null } };
      return node.children.flatMap((span) => {
        const pm = spanToPm(span, mark);
        return pm ? [pm] : [];
      });
    }
    case "inlineItem":
      return [{ type: "inlineItem", attrs: { item: node.item } }];
    case "inlineBlock":
      return [{ type: "inlineBlock", attrs: { item: node.item } }];
  }
}

function inlinesToPm(children: readonly InlineNode[]): PmNode[] {
  return children.flatMap(inlineToPm);
}

function paragraphToPm(node: ParagraphNode): PmNode {
  const content = inlinesToPm(node.children);
  return {
    type: "paragraph",
    attrs: { style: node.style ?? null },
    ...(content.length > 0 ? { content } : {}),
  };
}

function listToPm(node: ListNode): PmNode {
  return {
    type: "list",
    attrs: { style: node.style },
    content: node.children.map(listItemToPm),
  };
}

function listItemToPm(node: ListItemNode): PmNode {
  return {
    type: "listItem",
    content: node.children.map((child) =>
      child.type === "paragraph" ? paragraphToPm(child) : listToPm(child)
    ),
  };
}

function blockLevelToPm(node: BlockLevelNode): PmNode {
  switch (node.type) {
    case "paragraph":
      return paragraphToPm(node);
    case "heading": {
      const content = inlinesToPm(node.children);
      return {
        type: "heading",
        attrs: { level: node.level, style: node.style ?? null },
        ...(content.length > 0 ? { content } : {}),
      };
    }
    case "list":
      return listToPm(node);
    case "blockquote":
      return {
        type: "blockquote",
        attrs: { attribution: node.attribution ?? null },
        content: node.children.map(paragraphToPm),
      };
    case "code":
      return {
        type: "codeNode",
        attrs: { language: node.language ?? null, highlight: node.highlight ?? null },
        ...(node.code.length > 0 ? { content: [{ type: "text", text: node.code }] } : {}),
      };
    case "thematicBreak":
      return { type: "thematicBreak" };
    case "block":
      return { type: "blockNode", attrs: { item: node.item } };
    case "table":
      return {
        type: "table",
        content: node.children.map((row: TableRowNode) => ({
          type: "tableRow",
          content: row.children.map((cell: TableCellNode) => ({
            type: "tableCell",
            content: cell.children.map(paragraphToPm),
          })),
        })),
      };
  }
}

/** Convert a DAST document to ProseMirror doc JSON. */
export function dastToPm(doc: DastDocument): PmNode {
  return {
    type: "doc",
    content: doc.document.children.map(blockLevelToPm),
  };
}

// --- ProseMirror → DAST ---

interface LinkContext {
  kind: "link" | "itemLink";
  key: string;
  attrs: Record<string, unknown>;
  spans: SpanNode[];
}

function pmTextToSpan(node: PmNodeInput): SpanNode {
  const marks = (node.marks ?? [])
    .map((m) => m.type)
    .filter(isSpanMark);
  const span: SpanNode = { type: "span", value: node.text ?? "" };
  return marks.length > 0 ? { ...span, marks } : span;
}

function linkMarkOf(node: PmNodeInput): PmMarkInput | undefined {
  return (node.marks ?? []).find((m) => m.type === "link" || m.type === "itemLink");
}

function metaAttr(attrs: Record<string, unknown> | undefined): ReadonlyArray<{ id: string; value: string }> | undefined {
  const meta = attrs?.meta;
  if (!Array.isArray(meta) || meta.length === 0) return undefined;
  return meta.filter(
    (entry): entry is { id: string; value: string } =>
      typeof entry === "object" &&
      entry !== null &&
      typeof Reflect.get(entry, "id") === "string" &&
      typeof Reflect.get(entry, "value") === "string"
  );
}

function flushLinkContext(ctx: LinkContext): InlineNode {
  if (ctx.kind === "link") {
    const url = typeof ctx.attrs.url === "string" ? ctx.attrs.url : "";
    const meta = metaAttr(ctx.attrs);
    return { type: "link", url, ...(meta ? { meta } : {}), children: ctx.spans };
  }
  const item = typeof ctx.attrs.item === "string" ? ctx.attrs.item : "";
  const meta = metaAttr(ctx.attrs);
  return { type: "itemLink", item, ...(meta ? { meta } : {}), children: ctx.spans };
}

function pmInlinesToDast(content: readonly PmNodeInput[]): InlineNode[] {
  const out: InlineNode[] = [];
  let open: LinkContext | null = null;

  const flush = () => {
    if (open) {
      out.push(flushLinkContext(open));
      open = null;
    }
  };

  for (const node of content) {
    if (node.type === "text") {
      if (!node.text) continue; // never emit empty spans
      const link = linkMarkOf(node);
      if (link) {
        const key = JSON.stringify([link.type, link.attrs ?? {}]);
        if (!open || open.key !== key) {
          flush();
          open = {
            kind: link.type === "link" ? "link" : "itemLink",
            key,
            attrs: link.attrs ?? {},
            spans: [],
          };
        }
        open.spans.push(pmTextToSpan(node));
        continue;
      }
      flush();
      out.push(pmTextToSpan(node));
      continue;
    }
    flush();
    if (node.type === "inlineItem") {
      out.push({ type: "inlineItem", item: stringAttr(node, "item") });
    } else if (node.type === "inlineBlock") {
      out.push({ type: "inlineBlock", item: stringAttr(node, "item") });
    } else {
      throw new DastCodecError(`Unexpected inline node type "${node.type}"`);
    }
  }
  flush();
  return out;
}

function stringAttr(node: PmNodeInput, name: string): string {
  const value = node.attrs?.[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new DastCodecError(`Node "${node.type}" is missing required attr "${name}"`);
  }
  return value;
}

function pmParagraphToDast(node: PmNodeInput): ParagraphNode {
  if (node.type !== "paragraph") {
    throw new DastCodecError(`Expected paragraph, got "${node.type}"`);
  }
  const style = node.attrs?.style;
  return {
    type: "paragraph",
    ...(typeof style === "string" && style.length > 0 ? { style } : {}),
    children: pmInlinesToDast(node.content ?? []),
  };
}

function pmListToDast(node: PmNodeInput): ListNode {
  const style = node.attrs?.style === "numbered" ? "numbered" : "bulleted";
  return {
    type: "list",
    style,
    children: (node.content ?? []).map((li) => ({
      type: "listItem",
      children: (li.content ?? []).map((child) =>
        child.type === "list" ? pmListToDast(child) : pmParagraphToDast(child)
      ),
    })),
  };
}

function nonEmptyParagraphs(nodes: readonly PmNodeInput[], where: string): [ParagraphNode, ...ParagraphNode[]] {
  const [head, ...tail] = nodes.map(pmParagraphToDast);
  if (!head) throw new DastCodecError(`${where} must contain at least one paragraph`);
  return [head, ...tail];
}

function pmBlockToDast(node: PmNodeInput): BlockLevelNode {
  switch (node.type) {
    case "paragraph":
      return pmParagraphToDast(node);
    case "heading": {
      const rawLevel = node.attrs?.level;
      const level =
        rawLevel === 1 || rawLevel === 2 || rawLevel === 3 || rawLevel === 4 || rawLevel === 5 || rawLevel === 6
          ? rawLevel
          : 1;
      const style = node.attrs?.style;
      return {
        type: "heading",
        level,
        ...(typeof style === "string" && style.length > 0 ? { style } : {}),
        children: pmInlinesToDast(node.content ?? []),
      };
    }
    case "list":
      return pmListToDast(node);
    case "blockquote": {
      const attribution = node.attrs?.attribution;
      return {
        type: "blockquote",
        ...(typeof attribution === "string" && attribution.length > 0 ? { attribution } : {}),
        children: (node.content ?? []).map(pmParagraphToDast),
      };
    }
    case "codeNode": {
      const language = node.attrs?.language;
      const highlight = node.attrs?.highlight;
      return {
        type: "code",
        code: (node.content ?? []).map((t) => t.text ?? "").join(""),
        ...(typeof language === "string" && language.length > 0 ? { language } : {}),
        ...(Array.isArray(highlight) && highlight.length > 0
          ? { highlight: highlight.filter((n): n is number => typeof n === "number") }
          : {}),
      };
    }
    case "thematicBreak":
      return { type: "thematicBreak" };
    case "blockNode":
      return { type: "block", item: stringAttr(node, "item") };
    case "table": {
      const rows = (node.content ?? []).map((row): TableRowNode => {
        const cells = (row.content ?? []).map(
          (cell): TableCellNode => ({
            type: "tableCell",
            children: nonEmptyParagraphs(cell.content ?? [], "tableCell"),
          })
        );
        const [firstCell, ...restCells] = cells;
        if (!firstCell) throw new DastCodecError("tableRow must contain at least one cell");
        return { type: "tableRow", children: [firstCell, ...restCells] };
      });
      const [firstRow, ...restRows] = rows;
      if (!firstRow) throw new DastCodecError("table must contain at least one row");
      return { type: "table", children: [firstRow, ...restRows] };
    }
    default:
      throw new DastCodecError(`Unknown block-level node type "${node.type}"`);
  }
}

/** Convert ProseMirror doc JSON back to a DAST document. */
export function pmToDast(doc: PmNodeInput): DastDocument {
  if (doc.type !== "doc") throw new DastCodecError(`Expected doc node, got "${doc.type}"`);
  return {
    schema: "dast",
    document: {
      type: "root",
      children: (doc.content ?? []).map(pmBlockToDast),
    },
  };
}
