import { dastToDastdown, dastdownToDast } from "./markdown.js";
import type { DastDocument } from "./types.js";

function normalizeHandleWhitespace(source: string): string {
  return source
    .replace(/\[\[\s*block\s*:\s*([^\]\s|]+)\s*\]\]/g, "[[block:$1]]")
    .replace(/\[\[\s*inline_block\s*:\s*([^\]\s|]+)\s*\]\]/g, "[[inline_block:$1]]")
    .replace(/\[\[\s*inline_item\s*:\s*([^\]\s|]+)\s*\]\]/g, "[[inline_item:$1]]")
    .replace(/\[\[\s*record\s*:\s*([^\]\s|]+)\s*\|\s*([^\]]+?)\s*\]\]/g, "[[record:$1|$2]]");
}

function agentTextToInternalStructuredText(source: string): string {
  return normalizeHandleWhitespace(source)
    .replace(/\[\[block:([^\]\s|]+)\]\]/g, '<block id="$1"/>')
    .replace(/\[\[inline_block:([^\]\s|]+)\]\]/g, '<inlineBlock id="$1"/>')
    .replace(/\[\[inline_item:([^\]\s|]+)\]\]/g, '<inlineItem id="$1"/>')
    .replace(/\[\[record:([^\]\s|]+)\|([^\]]+)\]\]/g, "[$2](dato:item/$1)");
}

function internalStructuredTextToAgentText(source: string): string {
  return source
    .replace(/<block id="([^"]+)"\/>/g, "[[block:$1]]")
    .replace(/<inlineBlock id="([^"]+)"\/>/g, "[[inline_block:$1]]")
    .replace(/<inlineItem id="([^"]+)"\/>/g, "[[inline_item:$1]]")
    .replace(/\[([^\]]+)\]\(dato:item\/([^)]+)\)/g, "[[record:$2|$1]]");
}

export function agentTextToDast(source: string): DastDocument {
  return dastdownToDast(agentTextToInternalStructuredText(source));
}

export function dastToAgentText(doc: DastDocument): string {
  return internalStructuredTextToAgentText(dastToDastdown(doc));
}
