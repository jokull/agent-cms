import type { DastDocument } from "./types.js";
import { agentTextToDast, dastToAgentText } from "./agent-text.js";

export type StructuredTextFormatName = "agentText";

export interface FormatCandidate {
  name: StructuredTextFormatName;
  label: string;
  notes: string;
  serialize: (doc: DastDocument) => string;
  parse: (source: string) => DastDocument;
}

export interface FormatMetrics {
  chars: number;
  approxTokens: number;
  nonAlnumSymbols: number;
  lineCount: number;
  referenceMarkers: number;
  htmlCommentMarkers: number;
  angleTagMarkers: number;
}

export interface FormatEvaluation {
  name: StructuredTextFormatName;
  label: string;
  source: string;
  metrics: FormatMetrics;
  roundTrips: boolean;
}

export const formatCandidates: readonly FormatCandidate[] = [
  {
    name: "agentText",
    label: "Agent Text",
    notes: "Canonical authoring format: Markdown plus opaque [[type:id]] reference handles.",
    serialize: dastToAgentText,
    parse: agentTextToDast,
  },
];

export function getFormatCandidates(): readonly FormatCandidate[] {
  return formatCandidates;
}

export function estimateFormatMetrics(source: string): FormatMetrics {
  const compact = source.trim();
  return {
    chars: source.length,
    approxTokens: compact.length === 0 ? 0 : Math.ceil(compact.length / 4),
    nonAlnumSymbols: (source.match(/[^\s\p{L}\p{N}]/gu) ?? []).length,
    lineCount: compact.length === 0 ? 0 : compact.split(/\r?\n/).length,
    referenceMarkers: (source.match(/\[\[(?:block|inline_block|inline_item|record):|cms:|<block|<Block|<inlineBlock|<InlineBlock|<inlineItem|<InlineItem|dato:item|itemLink:|record:/g) ?? []).length,
    htmlCommentMarkers: (source.match(/<!--/g) ?? []).length,
    angleTagMarkers: (source.match(/<(?:block|Block|inlineBlock|InlineBlock|inlineItem|InlineItem)\b/g) ?? []).length,
  };
}

export function evaluateFormatCandidates(doc: DastDocument): FormatEvaluation[] {
  return getFormatCandidates().map((candidate) => {
    const source = candidate.serialize(doc);
    const parsed = candidate.parse(source);
    return {
      name: candidate.name,
      label: candidate.label,
      source,
      metrics: estimateFormatMetrics(source),
      roundTrips: JSON.stringify(parsed) === JSON.stringify(doc),
    };
  });
}
