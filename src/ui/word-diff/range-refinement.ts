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
  needsBoundarySafeOffsets,
} from "./text-boundaries.js";
import { collectChangedTokenIndexes } from "./token-alignment.js";
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

const MAX_SOFT_TOKEN_ALIGNMENT_CELLS = 4096;
const MIN_SOFT_TOKEN_SUBSTITUTION_SIMILARITY = 0.45;

export function refinedRangesForChangedTokens(
  beforeTokens: WordEmphasisToken[],
  afterTokens: WordEmphasisToken[],
  removedTokens: Set<number>,
  addedTokens: Set<number>,
): WordChangeRanges {
  const removedGroups = changedTokenGroups(beforeTokens, removedTokens);
  const addedGroups = changedTokenGroups(afterTokens, addedTokens);
  const removed: TextRange[] = [];
  const added: TextRange[] = [];
  const groupCount = Math.max(removedGroups.length, addedGroups.length);

  for (let index = 0; index < groupCount; index++) {
    const removedGroup = removedGroups[index];
    const addedGroup = addedGroups[index];
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

function changedTokenGroups(tokens: WordEmphasisToken[], changed: Set<number>): TokenGroup[] {
  const groups: TokenGroup[] = [];
  let start: number | undefined;
  for (let index = 0; index < tokens.length; index++) {
    if (changed.has(index)) {
      start ??= index;
      continue;
    }
    if (start !== undefined) {
      groups.push({ start, end: index });
      start = undefined;
    }
  }
  if (start !== undefined) groups.push({ start, end: tokens.length });
  return groups;
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
    return identifierRanges;
  }
  return textRanges ?? identifierRanges;
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

  const removed = new Set<number>();
  const added = new Set<number>();
  collectChangedTokenIndexes(beforeParts, 0, beforeParts.length, afterParts, 0, afterParts.length, {
    removed,
    added,
  });
  const ranges = refinedRangesForChangedTokens(beforeParts, afterParts, removed, added);
  return hasWordChangeRanges(ranges) ? ranges : undefined;
}

function refinedTokenTextRanges(
  beforeToken: WordEmphasisToken,
  afterToken: WordEmphasisToken,
): WordChangeRanges | undefined {
  if (beforeToken.value === afterToken.value) return undefined;
  const prefix = commonPrefixLength(beforeToken.value, afterToken.value);
  const suffix = commonSuffixLength(beforeToken.value, afterToken.value, prefix);
  if (!shouldRefineTokenText(beforeToken.value, afterToken.value, prefix, suffix)) return undefined;

  const beforeStart = prefix;
  const beforeEnd = beforeToken.value.length - suffix;
  const afterStart = prefix;
  const afterEnd = afterToken.value.length - suffix;
  const removed: TextRange[] =
    beforeStart < beforeEnd
      ? [[beforeToken.start + beforeStart, beforeToken.start + beforeEnd]]
      : [];
  const added: TextRange[] =
    afterStart < afterEnd ? [[afterToken.start + afterStart, afterToken.start + afterEnd]] : [];
  return removed.length > 0 || added.length > 0 ? { removed, added } : undefined;
}

function shouldRefineTokenText(
  before: string,
  after: string,
  prefix: number,
  suffix: number,
): boolean {
  const sharedEdgeLength = prefix + suffix;
  if (sharedEdgeLength === 0) return false;
  if (isIdentifierToken(before) && isIdentifierToken(after)) {
    if (
      sharedEdgeLength < 2 &&
      !needsBoundarySafeOffsets(before) &&
      !needsBoundarySafeOffsets(after)
    )
      return false;
    if (prefix === 0 && suffix > 0) {
      const beforeChangedLength = before.length - suffix;
      const afterChangedLength = after.length - suffix;
      if (
        beforeChangedLength !== afterChangedLength &&
        Math.min(beforeChangedLength, afterChangedLength) < 2
      )
        return false;
    }
    return true;
  }
  if (isNumberToken(before) && isNumberToken(after)) return true;
  if (isMeaningfulOperatorToken(before) && isMeaningfulOperatorToken(after)) return true;
  return false;
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
