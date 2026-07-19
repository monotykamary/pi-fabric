import type { WordChangeConfidence } from "./types.js";
import { wordEmphasisTokenWeight, type WordEmphasisToken } from "./tokens.js";
import { suffixAlignedPairs } from "./alignment.js";

const WORD_EMPHASIS_EXACT_LCS_MAX_CELLS = 262_144;

export type ChangedTokenIndexes = { removed: Set<number>; added: Set<number> };

export function collectChangedTokenIndexes(
  before: WordEmphasisToken[],
  beforeStart: number,
  beforeEnd: number,
  after: WordEmphasisToken[],
  afterStart: number,
  afterEnd: number,
  changed: ChangedTokenIndexes,
): WordChangeConfidence {
  while (
    beforeStart < beforeEnd &&
    afterStart < afterEnd &&
    tokenAt(before, beforeStart).value === tokenAt(after, afterStart).value
  ) {
    beforeStart++;
    afterStart++;
  }

  while (
    beforeStart < beforeEnd &&
    afterStart < afterEnd &&
    tokenAt(before, beforeEnd - 1).value === tokenAt(after, afterEnd - 1).value
  ) {
    beforeEnd--;
    afterEnd--;
  }

  if (beforeStart === beforeEnd || afterStart === afterEnd) {
    markTokenRange(changed.removed, beforeStart, beforeEnd);
    markTokenRange(changed.added, afterStart, afterEnd);
    return "high";
  }

  const beforeLength = beforeEnd - beforeStart;
  const afterLength = afterEnd - afterStart;
  if (beforeLength * afterLength <= WORD_EMPHASIS_EXACT_LCS_MAX_CELLS) {
    collectChangedTokenIndexesByLcs(
      before,
      beforeStart,
      beforeEnd,
      after,
      afterStart,
      afterEnd,
      changed,
    );
    return "high";
  }

  const anchors = uniqueOrderedAnchors(before, beforeStart, beforeEnd, after, afterStart, afterEnd);
  if (anchors.length === 0) {
    markTokenRange(changed.removed, beforeStart, beforeEnd);
    markTokenRange(changed.added, afterStart, afterEnd);
    return "low";
  }

  let confidence: WordChangeConfidence = "high";
  let previousBefore = beforeStart;
  let previousAfter = afterStart;
  for (const anchor of anchors) {
    confidence = lowerWordChangeConfidence(
      confidence,
      collectChangedTokenIndexes(
        before,
        previousBefore,
        anchor.beforeIndex,
        after,
        previousAfter,
        anchor.afterIndex,
        changed,
      ),
    );
    previousBefore = anchor.beforeIndex + 1;
    previousAfter = anchor.afterIndex + 1;
  }
  confidence = lowerWordChangeConfidence(
    confidence,
    collectChangedTokenIndexes(
      before,
      previousBefore,
      beforeEnd,
      after,
      previousAfter,
      afterEnd,
      changed,
    ),
  );
  return lowerWordChangeConfidence(confidence, "medium");
}

function lowerWordChangeConfidence(
  a: WordChangeConfidence,
  b: WordChangeConfidence,
): WordChangeConfidence {
  return WORD_CHANGE_CONFIDENCE_RANK[a] <= WORD_CHANGE_CONFIDENCE_RANK[b] ? a : b;
}

const WORD_CHANGE_CONFIDENCE_RANK = {
  low: 0,
  medium: 1,
  high: 2,
} satisfies Record<WordChangeConfidence, number>;

function collectChangedTokenIndexesByLcs(
  before: WordEmphasisToken[],
  beforeStart: number,
  beforeEnd: number,
  after: WordEmphasisToken[],
  afterStart: number,
  afterEnd: number,
  changed: ChangedTokenIndexes,
): void {
  const beforeLength = beforeEnd - beforeStart;
  const afterLength = afterEnd - afterStart;
  const pairs = suffixAlignedPairs(beforeLength, afterLength, (beforeIndex, afterIndex) => {
    const beforeToken = tokenAt(before, beforeStart + beforeIndex);
    const afterToken = tokenAt(after, afterStart + afterIndex);
    return beforeToken.value === afterToken.value
      ? wordEmphasisTokenWeight(beforeToken.value)
      : Number.NEGATIVE_INFINITY;
  });

  let beforeIndex = 0;
  let afterIndex = 0;
  for (const [nextBeforeIndex, nextAfterIndex] of pairs) {
    markTokenRange(changed.removed, beforeStart + beforeIndex, beforeStart + nextBeforeIndex);
    markTokenRange(changed.added, afterStart + afterIndex, afterStart + nextAfterIndex);
    beforeIndex = nextBeforeIndex + 1;
    afterIndex = nextAfterIndex + 1;
  }
  markTokenRange(changed.removed, beforeStart + beforeIndex, beforeEnd);
  markTokenRange(changed.added, afterStart + afterIndex, afterEnd);
}

function uniqueOrderedAnchors(
  before: WordEmphasisToken[],
  beforeStart: number,
  beforeEnd: number,
  after: WordEmphasisToken[],
  afterStart: number,
  afterEnd: number,
): Array<{ beforeIndex: number; afterIndex: number }> {
  const beforeCounts = tokenCounts(before, beforeStart, beforeEnd);
  const afterCounts = tokenCounts(after, afterStart, afterEnd);
  const afterUniqueIndexes = new Map<string, number>();
  for (let index = afterStart; index < afterEnd; index++) {
    const value = tokenAt(after, index).value;
    if (beforeCounts.get(value) === 1 && afterCounts.get(value) === 1)
      afterUniqueIndexes.set(value, index);
  }
  const candidates: Array<{ beforeIndex: number; afterIndex: number }> = [];
  for (let index = beforeStart; index < beforeEnd; index++) {
    const value = tokenAt(before, index).value;
    if (beforeCounts.get(value) !== 1 || afterCounts.get(value) !== 1) continue;
    const afterIndex = afterUniqueIndexes.get(value);
    if (afterIndex !== undefined) candidates.push({ beforeIndex: index, afterIndex });
  }
  return longestIncreasingAfterIndexes(candidates);
}

function longestIncreasingAfterIndexes(
  candidates: Array<{ beforeIndex: number; afterIndex: number }>,
): Array<{ beforeIndex: number; afterIndex: number }> {
  if (candidates.length <= 1) return candidates;
  const tails: number[] = [];
  const previous = Array.from({ length: candidates.length }, () => -1);
  const tailCandidateIndexes: number[] = [];

  for (let index = 0; index < candidates.length; index++) {
    const afterIndex = candidateAt(candidates, index).afterIndex;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (numberAt(tails, middle) < afterIndex) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = numberAt(tailCandidateIndexes, low - 1);
    tails[low] = afterIndex;
    tailCandidateIndexes[low] = index;
  }

  const ordered: Array<{ beforeIndex: number; afterIndex: number }> = [];
  let index = tailCandidateIndexes[tails.length - 1] ?? -1;
  while (index >= 0) {
    ordered.push(candidateAt(candidates, index));
    index = previous[index] ?? -1;
  }
  return ordered.reverse();
}

function tokenCounts(tokens: WordEmphasisToken[], start: number, end: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (let index = start; index < end; index++) {
    const value = tokenAt(tokens, index).value;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function markTokenRange(changed: Set<number>, start: number, end: number): void {
  for (let index = start; index < end; index++) changed.add(index);
}

function tokenAt(tokens: WordEmphasisToken[], index: number): WordEmphasisToken {
  const token = tokens[index];
  if (token === undefined) throw new RangeError(`Missing word-emphasis token ${index}`);
  return token;
}

function candidateAt(
  candidates: Array<{ beforeIndex: number; afterIndex: number }>,
  index: number,
): { beforeIndex: number; afterIndex: number } {
  const candidate = candidates[index];
  if (candidate === undefined) throw new RangeError(`Missing anchor candidate ${index}`);
  return candidate;
}

function numberAt(values: number[], index: number): number {
  const value = values[index];
  if (value === undefined) throw new RangeError(`Missing numeric value ${index}`);
  return value;
}
