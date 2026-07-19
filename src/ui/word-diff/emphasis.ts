import type { DiffWordEmphasis } from "./types.js";
import { refinedRangesForChangedTokens } from "./range-refinement.js";
import { filterLowSignalWordEmphasis } from "./smart-filter.js";
import { collectChangedTokenIndexes } from "./token-alignment.js";
import type { ConfidentWordChangeRanges, WordChangeConfidence, WordChangeRanges } from "./types.js";
import { wordEmphasisTokens, type WordEmphasisToken } from "./tokens.js";

export type { ConfidentWordChangeRanges, WordChangeConfidence } from "./types.js";

export function shouldEmphasizeChangedPair(
  ranges: ConfidentWordChangeRanges,
  lineConfidence: WordChangeConfidence,
): boolean {
  if (ranges.removed.length === 0 && ranges.added.length === 0) return false;
  if (lineConfidence === "low") return false;
  if (ranges.confidence === "low" && lineConfidence !== "high") return false;
  return true;
}

export function changedRanges(
  before: string,
  after: string,
  wordEmphasis: DiffWordEmphasis,
): WordChangeRanges {
  return stripWordChangeConfidence(changedRangesWithConfidence(before, after, wordEmphasis));
}

export function changedRangesWithConfidence(
  before: string,
  after: string,
  wordEmphasis: DiffWordEmphasis,
): ConfidentWordChangeRanges {
  if (wordEmphasis === "off") return emptyWordChangeRanges();
  return changedRangesForTokensWithConfidence(
    before,
    after,
    wordEmphasisTokens(before),
    wordEmphasisTokens(after),
    wordEmphasis,
  );
}

export function changedRangesForTokensWithConfidence(
  before: string,
  after: string,
  beforeTokens: WordEmphasisToken[],
  afterTokens: WordEmphasisToken[],
  wordEmphasis: DiffWordEmphasis,
): ConfidentWordChangeRanges {
  if (wordEmphasis === "off") return emptyWordChangeRanges();

  const removedTokens = new Set<number>();
  const addedTokens = new Set<number>();
  const alignmentConfidence = collectChangedTokenIndexes(
    beforeTokens,
    0,
    beforeTokens.length,
    afterTokens,
    0,
    afterTokens.length,
    {
      removed: removedTokens,
      added: addedTokens,
    },
  );
  const ranges = refinedRangesForChangedTokens(
    beforeTokens,
    afterTokens,
    removedTokens,
    addedTokens,
  );
  const confidence: WordChangeConfidence = hasWordChangeRanges(ranges)
    ? alignmentConfidence
    : "low";
  if (wordEmphasis !== "smart") return { ...ranges, confidence };

  const filtered = filterLowSignalWordEmphasis(before, after, ranges);
  return { ...filtered, confidence: hasWordChangeRanges(filtered) ? confidence : "low" };
}

function stripWordChangeConfidence(ranges: ConfidentWordChangeRanges): WordChangeRanges {
  return { removed: ranges.removed, added: ranges.added };
}

function hasWordChangeRanges(ranges: WordChangeRanges): boolean {
  return ranges.removed.length > 0 || ranges.added.length > 0;
}

function emptyWordChangeRanges(): ConfidentWordChangeRanges {
  return { removed: [], added: [], confidence: "low" };
}
