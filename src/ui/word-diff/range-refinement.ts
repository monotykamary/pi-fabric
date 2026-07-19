// Adapted from pi-code-previews; see THIRD_PARTY_NOTICES.md.
import {
  mergeRanges,
  mergeRangesByStart,
  pushTokenRange,
  rangesForTokenGroup,
  type TextRange,
  type TokenGroup,
} from "./ranges.js";
import {
  commonPrefixLength,
  commonSuffixLength,
  rangesAtGraphemeBoundaries,
} from "./text-boundaries.js";
import { collectChangedTokenGaps, type ChangedTokenGap } from "./token-alignment.js";
import {
  isIdentifierSimilarityPart,
  isIdentifierToken,
  isMeaningfulOperatorToken,
  isNumberToken,
  splitIdentifierToken,
  wordEmphasisTokenWeight,
  type WordEmphasisToken,
} from "./tokens.js";
import type { WordChangeRanges } from "./types.js";
import { suffixAlignedPairs } from "./alignment.js";
import { refinedTokenTextRanges } from "./token-text-refinement.js";

const MAX_SOFT_TOKEN_ALIGNMENT_CELLS = 4096;
const MIN_SOFT_TOKEN_SUBSTITUTION_SIMILARITY = 0.45;

export function refinedRangesForChangedTokens(
  beforeText: string,
  beforeTokens: WordEmphasisToken[],
  afterText: string,
  afterTokens: WordEmphasisToken[],
  gaps: ChangedTokenGap[],
): WordChangeRanges {
  const ranges = refinedRangesForTokenGaps(beforeTokens, afterTokens, gaps);
  return {
    removed: mergeRanges(rangesAtGraphemeBoundaries(beforeText, ranges.removed)),
    added: mergeRanges(rangesAtGraphemeBoundaries(afterText, ranges.added)),
  };
}

function refinedRangesForTokenGaps(
  beforeTokens: WordEmphasisToken[],
  afterTokens: WordEmphasisToken[],
  gaps: ChangedTokenGap[],
): WordChangeRanges {
  const removed: TextRange[] = [];
  const added: TextRange[] = [];

  for (const gap of gaps) {
    const removedGroup = nonEmptyTokenGroup(gap.removed);
    const addedGroup = nonEmptyTokenGroup(gap.added);
    const refined =
      removedGroup && addedGroup
        ? refinedChangedTokenGroupRanges(beforeTokens, removedGroup, afterTokens, addedGroup)
        : undefined;
    if (refined) {
      removed.push(...refined.removed);
      added.push(...refined.added);
      continue;
    }
    if (removedGroup) removed.push(...rangesForTokenGroup(beforeTokens, removedGroup));
    if (addedGroup) added.push(...rangesForTokenGroup(afterTokens, addedGroup));
  }

  return { removed: mergeRanges(removed), added: mergeRanges(added) };
}

function nonEmptyTokenGroup(group: TokenGroup): TokenGroup | undefined {
  return group.start < group.end ? group : undefined;
}

function refinedChangedTokenGroupRanges(
  beforeTokens: WordEmphasisToken[],
  beforeGroup: TokenGroup,
  afterTokens: WordEmphasisToken[],
  afterGroup: TokenGroup,
): WordChangeRanges | undefined {
  return (
    refinedSingleTokenRanges(beforeTokens, beforeGroup, afterTokens, afterGroup) ??
    refinedSoftTokenGroupRanges(beforeTokens, beforeGroup, afterTokens, afterGroup)
  );
}

function refinedSingleTokenRanges(
  beforeTokens: WordEmphasisToken[],
  beforeGroup: TokenGroup,
  afterTokens: WordEmphasisToken[],
  afterGroup: TokenGroup,
): WordChangeRanges | undefined {
  if (beforeGroup.end - beforeGroup.start !== 1 || afterGroup.end - afterGroup.start !== 1)
    return undefined;
  return refinedTokenPairRanges(
    tokenAt(beforeTokens, beforeGroup.start),
    tokenAt(afterTokens, afterGroup.start),
  );
}

function refinedTokenPairRanges(
  beforeToken: WordEmphasisToken,
  afterToken: WordEmphasisToken,
): WordChangeRanges | undefined {
  const identifierRanges = refinedIdentifierTokenRanges(beforeToken, afterToken);
  const textRanges = refinedTokenTextRanges(beforeToken, afterToken);
  if (identifierRanges && isNarrowerThanWholeTokens(identifierRanges, beforeToken, afterToken)) {
    if (shouldSuppressUnbalancedIdentifierPartRefinement(beforeToken, afterToken, textRanges))
      return textRanges;
    if (
      textRanges &&
      (textRanges.removed.length === 0 || textRanges.added.length === 0) &&
      highlightedRangeWidth(textRanges) < highlightedRangeWidth(identifierRanges)
    )
      return textRanges;
    return identifierRanges;
  }
  return textRanges ?? identifierRanges;
}

function highlightedRangeWidth(ranges: WordChangeRanges): number {
  let width = 0;
  for (const [start, end] of ranges.removed) width += end - start;
  for (const [start, end] of ranges.added) width += end - start;
  return width;
}

function shouldSuppressUnbalancedIdentifierPartRefinement(
  beforeToken: WordEmphasisToken,
  afterToken: WordEmphasisToken,
  textRanges: WordChangeRanges | undefined,
): boolean {
  if (textRanges) return false;
  if (!isIdentifierToken(beforeToken.value) || !isIdentifierToken(afterToken.value)) return false;
  const beforePartCount = splitIdentifierToken(beforeToken.value, 0).filter((part) =>
    isIdentifierSimilarityPart(part.value),
  ).length;
  const afterPartCount = splitIdentifierToken(afterToken.value, 0).filter((part) =>
    isIdentifierSimilarityPart(part.value),
  ).length;
  return Math.min(beforePartCount, afterPartCount) === 1 && beforePartCount !== afterPartCount;
}

function refinedSoftTokenGroupRanges(
  beforeTokens: WordEmphasisToken[],
  beforeGroup: TokenGroup,
  afterTokens: WordEmphasisToken[],
  afterGroup: TokenGroup,
): WordChangeRanges | undefined {
  const before = beforeTokens.slice(beforeGroup.start, beforeGroup.end);
  const after = afterTokens.slice(afterGroup.start, afterGroup.end);
  if (before.length * after.length > MAX_SOFT_TOKEN_ALIGNMENT_CELLS) return undefined;
  const pairs = softAlignedTokenPairs(before, after);
  if (pairs.length === 0) return undefined;

  const pairedBefore = new Set<number>();
  const pairedAfter = new Set<number>();
  const removed: TextRange[] = [];
  const added: TextRange[] = [];

  for (const [beforeIndex, afterIndex] of pairs) {
    pairedBefore.add(beforeIndex);
    pairedAfter.add(afterIndex);
    const beforeToken = tokenAt(before, beforeIndex);
    const afterToken = tokenAt(after, afterIndex);
    if (beforeToken.value === afterToken.value) continue;
    const refined = refinedTokenPairRanges(beforeToken, afterToken);
    if (refined) {
      removed.push(...refined.removed);
      added.push(...refined.added);
    } else {
      pushTokenRange(removed, beforeToken);
      pushTokenRange(added, afterToken);
    }
  }

  for (let index = 0; index < before.length; index++) {
    if (!pairedBefore.has(index)) pushTokenRange(removed, tokenAt(before, index));
  }
  for (let index = 0; index < after.length; index++) {
    if (!pairedAfter.has(index)) pushTokenRange(added, tokenAt(after, index));
  }

  const result = { removed: mergeRangesByStart(removed), added: mergeRangesByStart(added) };
  return result.removed.length > 0 || result.added.length > 0 ? result : undefined;
}

function softAlignedTokenPairs(
  before: WordEmphasisToken[],
  after: WordEmphasisToken[],
): Array<[number, number]> {
  return suffixAlignedPairs(before.length, after.length, (beforeIndex, afterIndex) => {
    const substitution = softTokenSubstitutionWeight(
      tokenAt(before, beforeIndex),
      tokenAt(after, afterIndex),
    );
    return substitution > 0 ? substitution : Number.NEGATIVE_INFINITY;
  });
}

function softTokenSubstitutionWeight(
  beforeToken: WordEmphasisToken,
  afterToken: WordEmphasisToken,
): number {
  if (beforeToken.value === afterToken.value) return wordEmphasisTokenWeight(beforeToken.value);
  const similarity = softTokenSimilarity(beforeToken.value, afterToken.value);
  return similarity >= MIN_SOFT_TOKEN_SUBSTITUTION_SIMILARITY
    ? Math.min(
        wordEmphasisTokenWeight(beforeToken.value),
        wordEmphasisTokenWeight(afterToken.value),
      ) * similarity
    : 0;
}

function softTokenSimilarity(before: string, after: string): number {
  if (isIdentifierToken(before) && isIdentifierToken(after))
    return identifierTokenSimilarity(before, after);
  if (isNumberToken(before) && isNumberToken(after)) return edgeTextSimilarity(before, after);
  if (isMeaningfulOperatorToken(before) && isMeaningfulOperatorToken(after))
    return edgeTextSimilarity(before, after);
  return 0;
}

function identifierTokenSimilarity(before: string, after: string): number {
  const beforeParts = splitIdentifierToken(before, 0)
    .map((part) => part.value.toLowerCase())
    .filter(isIdentifierSimilarityPart);
  const afterParts = splitIdentifierToken(after, 0)
    .map((part) => part.value.toLowerCase())
    .filter(isIdentifierSimilarityPart);
  const partSimilarity = tokenDiceSimilarity(beforeParts, afterParts);
  return Math.max(partSimilarity, edgeTextSimilarity(before, after));
}

function tokenDiceSimilarity(before: string[], after: string[]): number {
  if (before.length === 0 || after.length === 0) return 0;
  const remaining = new Map<string, number>();
  for (const token of before) remaining.set(token, (remaining.get(token) ?? 0) + 1);
  let shared = 0;
  for (const token of after) {
    const count = remaining.get(token) ?? 0;
    if (count === 0) continue;
    shared++;
    if (count === 1) remaining.delete(token);
    else remaining.set(token, count - 1);
  }
  return (2 * shared) / (before.length + after.length);
}

function edgeTextSimilarity(before: string, after: string): number {
  const prefix = commonPrefixLength(before, after);
  const suffix = commonSuffixLength(before, after, prefix);
  return (2 * (prefix + suffix)) / (before.length + after.length);
}

function refinedIdentifierTokenRanges(
  beforeToken: WordEmphasisToken,
  afterToken: WordEmphasisToken,
): WordChangeRanges | undefined {
  if (!isIdentifierToken(beforeToken.value) || !isIdentifierToken(afterToken.value))
    return undefined;
  const beforeParts = splitIdentifierToken(beforeToken.value, beforeToken.start);
  const afterParts = splitIdentifierToken(afterToken.value, afterToken.start);
  if (beforeParts.length <= 1 && afterParts.length <= 1) return undefined;

  const gaps: ChangedTokenGap[] = [];
  collectChangedTokenGaps(
    beforeParts,
    0,
    beforeParts.length,
    afterParts,
    0,
    afterParts.length,
    gaps,
  );
  const ranges = refinedRangesForTokenGaps(beforeParts, afterParts, gaps);
  return hasWordChangeRanges(ranges) ? ranges : undefined;
}

function isNarrowerThanWholeTokens(
  ranges: WordChangeRanges,
  beforeToken: WordEmphasisToken,
  afterToken: WordEmphasisToken,
): boolean {
  return (
    ranges.removed.some((range) => range[0] > beforeToken.start || range[1] < beforeToken.end) ||
    ranges.added.some((range) => range[0] > afterToken.start || range[1] < afterToken.end) ||
    ranges.removed.length === 0 ||
    ranges.added.length === 0
  );
}

function hasWordChangeRanges(ranges: WordChangeRanges): boolean {
  return ranges.removed.length > 0 || ranges.added.length > 0;
}

function tokenAt(tokens: WordEmphasisToken[], index: number): WordEmphasisToken {
  const token = tokens[index];
  if (token === undefined) throw new RangeError(`Missing word-emphasis token ${index}`);
  return token;
}
