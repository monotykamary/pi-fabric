// Adapted from pi-code-previews; see THIRD_PARTY_NOTICES.md.
import type { WordEmphasisToken } from "./tokens.js";

export type TextRange = [number, number];
export type TokenGroup = { start: number; end: number };

export function rangesForTokenGroup(tokens: WordEmphasisToken[], group: TokenGroup): TextRange[] {
  const ranges: TextRange[] = [];
  for (let index = group.start; index < group.end; index++) {
    const token = tokens[index];
    if (token) appendTokenRange(ranges, token);
  }
  return ranges;
}

export function pushTokenRange(ranges: TextRange[], token: WordEmphasisToken): void {
  ranges.push([token.start, token.end]);
}

export function mergeRangesByStart(ranges: TextRange[]): TextRange[] {
  return mergeRanges([...ranges].sort((a, b) => a[0] - b[0]));
}

export function mergeRanges(ranges: TextRange[]): TextRange[] {
  const merged: TextRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range[0] - previous[1] <= 1) previous[1] = range[1];
    else merged.push([...range]);
  }
  return merged;
}

function appendTokenRange(ranges: TextRange[], token: WordEmphasisToken): void {
  const previous = ranges.at(-1);
  if (previous && token.start - previous[1] <= 1) previous[1] = token.end;
  else ranges.push([token.start, token.end]);
}
