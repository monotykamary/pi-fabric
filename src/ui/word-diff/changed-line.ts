// Adapted from pi-code-previews; see THIRD_PARTY_NOTICES.md.
import type { AddedDiffLine, RemovedDiffLine } from "./parse.js";
import { expandPreviewTabs } from "./normalize.js";
import { escapeControlChars } from "./normalize.js";
import { wordEmphasisTokens, type WordEmphasisToken } from "./tokens.js";

export type IndexedChangedLine<T extends AddedDiffLine | RemovedDiffLine> = {
  index: number;
  line: T;
  normalizedContent?: string;
  tokens?: WordEmphasisToken[];
  similarityTokenValues?: string[];
  similarityFeatureValues?: string[];
};

export function indexedChangedLine<T extends AddedDiffLine | RemovedDiffLine>(
  index: number,
  line: T,
): IndexedChangedLine<T> {
  return { index, line };
}

export function normalizedChangedContent(
  line: IndexedChangedLine<AddedDiffLine | RemovedDiffLine>,
): string {
  // Compute ranges against the same normalized text that Shiki/fallback rendering displays.
  // Otherwise tabs or escaped control chars shift the emphasis range by multiple cells.
  return (line.normalizedContent ??= normalizeDiffContent(line.line.content));
}

export function changedLineTokens(
  line: IndexedChangedLine<AddedDiffLine | RemovedDiffLine>,
): WordEmphasisToken[] {
  return (line.tokens ??= wordEmphasisTokens(normalizedChangedContent(line)));
}

function normalizeDiffContent(content: string): string {
  return escapeControlChars(expandPreviewTabs(content));
}
