import { dastToDastdown, markdownToDast } from "./markdown.js";
import type { DastDocument } from "./types.js";

function encodeReferenceId(value: string): string {
  return encodeURIComponent(value);
}

function splitPreservingLineEndings(source: string): string[] {
  if (source.length === 0) return [""];
  return source.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/g) ?? [];
}

function transformOutsideInlineCode(source: string, transform: (segment: string) => string): string {
  let result = "";
  let index = 0;

  while (index < source.length) {
    const tickStart = source.indexOf("`", index);
    if (tickStart < 0) {
      result += transform(source.slice(index));
      break;
    }

    result += transform(source.slice(index, tickStart));
    let tickEnd = tickStart + 1;
    while (tickEnd < source.length && source[tickEnd] === "`") tickEnd++;
    const fence = source.slice(tickStart, tickEnd);
    const close = source.indexOf(fence, tickEnd);
    if (close < 0) {
      result += source.slice(tickStart);
      break;
    }

    result += source.slice(tickStart, close + fence.length);
    index = close + fence.length;
  }

  return result;
}

function transformOutsideCode(source: string, transform: (segment: string) => string): string {
  const lines = splitPreservingLineEndings(source);
  const output: string[] = [];
  let fenceMarker: string | null = null;
  let fenceLength = 0;

  for (const line of lines) {
    const fenceMatch = /^( {0,3})(`{3,}|~{3,})/.exec(line);
    if (fenceMarker !== null) {
      output.push(line);
      if (fenceMatch && fenceMatch[2]?.startsWith(fenceMarker) && fenceMatch[2].length >= fenceLength) {
        fenceMarker = null;
        fenceLength = 0;
      }
      continue;
    }

    if (fenceMatch) {
      output.push(line);
      fenceMarker = fenceMatch[2]?.[0] ?? null;
      fenceLength = fenceMatch[2]?.length ?? 0;
      continue;
    }

    output.push(transformOutsideInlineCode(line, transform));
  }

  return output.join("");
}

function agentTextSegmentToMarkdown(source: string): string {
  const blockLine = /^([ \t]*)\[\[\s*block\s*:\s*([^\]\s|]+)\s*\]\]([ \t]*(?:\r\n|\n|\r)?)$/.exec(source);
  if (blockLine) {
    return `${blockLine[1]}<!-- cms:block:${encodeReferenceId(blockLine[2] ?? "")} -->${blockLine[3]}`;
  }

  return source
    .replace(/\[\[\s*inline_block\s*:\s*([^\]\s|]+)\s*\]\]/g, (_match, id: string) =>
      `<!-- cms:inlineBlock:${encodeReferenceId(id)} -->`
    )
    .replace(/\[\[\s*inline_item\s*:\s*([^\]\s|]+)\s*\]\]/g, (_match, id: string) =>
      `<!-- cms:inlineItem:${encodeReferenceId(id)} -->`
    )
    .replace(/\[\[\s*record\s*:\s*([^\]\s|]+)\s*\|\s*((?:\\.|[^\]])+?)\s*\]\]/g, (_match, id: string, label: string) =>
      `[${label}](itemLink:${id})`
    );
}

function agentTextToMarkdown(source: string): string {
  return transformOutsideCode(source, agentTextSegmentToMarkdown);
}

function internalStructuredTextSegmentToAgentText(source: string): string {
  return source
    .replace(/<block id="([^"]+)"\/>/g, "[[block:$1]]")
    .replace(/<inlineBlock id="([^"]+)"\/>/g, "[[inline_block:$1]]")
    .replace(/<inlineItem id="([^"]+)"\/>/g, "[[inline_item:$1]]")
    .replace(/\[((?:\\.|[^\]])+)\]\(dato:item\/([^)]+)\)/g, "[[record:$2|$1]]");
}

function internalStructuredTextToAgentText(source: string): string {
  return transformOutsideCode(source, internalStructuredTextSegmentToAgentText);
}

export function agentTextToDast(source: string): DastDocument {
  return markdownToDast(agentTextToMarkdown(source));
}

export function dastToAgentText(doc: DastDocument): string {
  return internalStructuredTextToAgentText(dastToDastdown(doc));
}
