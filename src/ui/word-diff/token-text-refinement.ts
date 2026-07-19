// Adapted from pi-code-previews; see THIRD_PARTY_NOTICES.md.
import { suffixAlignedPairs } from "./alignment.js";
import type { TextRange } from "./ranges.js";
import {
  commonPrefixLength,
  commonSuffixLength,
  needsBoundarySafeOffsets,
  textBoundarySegments,
  type TextBoundarySegment,
} from "./text-boundaries.js";
import {
  isIdentifierToken,
  isMeaningfulOperatorToken,
  isNumberToken,
  type WordEmphasisToken,
} from "./tokens.js";
import type { WordChangeRanges } from "./types.js";

const MAX_REFINED_TEXT_ALIGNMENT_CELLS = 1024;
const MAX_REFINED_TEXT_GRAPHEMES = 48;
const MAX_REFINED_TEXT_INTERNAL_RUNS = 4;
const MIN_REFINED_TEXT_INTERNAL_RUN_GRAPHEMES = 3;

type CommonTextRun = {
  beforeStart: number;
  beforeEnd: number;
  afterStart: number;
  afterEnd: number;
};

export function refinedTokenTextRanges(
  beforeToken: WordEmphasisToken,
  afterToken: WordEmphasisToken,
): WordChangeRanges | undefined {
  if (beforeToken.value === afterToken.value) return undefined;
  const prefix = commonPrefixLength(beforeToken.value, afterToken.value);
  const suffix = commonSuffixLength(beforeToken.value, afterToken.value, prefix);
  if (!shouldRefineTokenText(beforeToken.value, afterToken.value, prefix, suffix)) return undefined;
  const aligned = refinedTokenTextRangesByAlignment(beforeToken, afterToken, prefix, suffix);
  if (aligned) return aligned;

  return tokenTextGapRanges(
    beforeToken,
    afterToken,
    prefix,
    beforeToken.value.length - suffix,
    prefix,
    afterToken.value.length - suffix,
  );
}

function refinedTokenTextRangesByAlignment(
  beforeToken: WordEmphasisToken,
  afterToken: WordEmphasisToken,
  prefix: number,
  suffix: number,
): WordChangeRanges | undefined {
  const beforeValue = beforeToken.value;
  const afterValue = afterToken.value;
  if (!isIdentifierToken(beforeValue) || !isIdentifierToken(afterValue)) return undefined;
  if (beforeValue.length * afterValue.length > MAX_REFINED_TEXT_ALIGNMENT_CELLS) return undefined;
  if (!hasPotentialInternalCommonText(beforeValue, afterValue, prefix, suffix)) return undefined;

  const beforeSegments = textBoundarySegments(beforeValue);
  const afterSegments = textBoundarySegments(afterValue);
  if (
    beforeSegments.length > MAX_REFINED_TEXT_GRAPHEMES ||
    afterSegments.length > MAX_REFINED_TEXT_GRAPHEMES ||
    beforeSegments.length * afterSegments.length > MAX_REFINED_TEXT_ALIGNMENT_CELLS
  )
    return undefined;

  const pairs = suffixAlignedPairs(beforeSegments.length, afterSegments.length, (before, after) =>
    segmentAt(beforeSegments, before).value === segmentAt(afterSegments, after).value
      ? 1
      : Number.NEGATIVE_INFINITY,
  );
  const runs = commonTextRuns(pairs);
  const keptRuns = runs.filter(
    (run) =>
      isEdgeTextRun(run, beforeSegments.length, afterSegments.length) ||
      run.beforeEnd - run.beforeStart >= MIN_REFINED_TEXT_INTERNAL_RUN_GRAPHEMES,
  );
  const internalRunCount = keptRuns.filter(
    (run) => !isEdgeTextRun(run, beforeSegments.length, afterSegments.length),
  ).length;
  if (internalRunCount === 0 || internalRunCount > MAX_REFINED_TEXT_INTERNAL_RUNS) return undefined;

  const removed: TextRange[] = [];
  const added: TextRange[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  for (const run of keptRuns) {
    pushTextSegmentRange(removed, beforeToken, beforeSegments, beforeIndex, run.beforeStart);
    pushTextSegmentRange(added, afterToken, afterSegments, afterIndex, run.afterStart);
    beforeIndex = run.beforeEnd;
    afterIndex = run.afterEnd;
  }
  pushTextSegmentRange(removed, beforeToken, beforeSegments, beforeIndex, beforeSegments.length);
  pushTextSegmentRange(added, afterToken, afterSegments, afterIndex, afterSegments.length);

  return removed.length > 0 || added.length > 0 ? { removed, added } : undefined;
}

function tokenTextGapRanges(
  beforeToken: WordEmphasisToken,
  afterToken: WordEmphasisToken,
  beforeStart: number,
  beforeEnd: number,
  afterStart: number,
  afterEnd: number,
): WordChangeRanges | undefined {
  const removed: TextRange[] =
    beforeStart < beforeEnd
      ? [[beforeToken.start + beforeStart, beforeToken.start + beforeEnd]]
      : [];
  const added: TextRange[] =
    afterStart < afterEnd ? [[afterToken.start + afterStart, afterToken.start + afterEnd]] : [];
  return removed.length > 0 || added.length > 0 ? { removed, added } : undefined;
}

function hasPotentialInternalCommonText(
  before: string,
  after: string,
  prefix: number,
  suffix: number,
): boolean {
  const beforeMiddle = before.slice(prefix, before.length - suffix);
  const afterMiddle = after.slice(prefix, after.length - suffix);
  const [shorter, longer] =
    beforeMiddle.length <= afterMiddle.length
      ? [beforeMiddle, afterMiddle]
      : [afterMiddle, beforeMiddle];
  if (shorter.length < MIN_REFINED_TEXT_INTERNAL_RUN_GRAPHEMES) return false;

  for (let index = 0; index <= shorter.length - MIN_REFINED_TEXT_INTERNAL_RUN_GRAPHEMES; index++) {
    const candidate = shorter.slice(index, index + MIN_REFINED_TEXT_INTERNAL_RUN_GRAPHEMES);
    if (longer.includes(candidate)) return true;
  }
  return false;
}

function commonTextRuns(pairs: Array<[number, number]>): CommonTextRun[] {
  const runs: CommonTextRun[] = [];
  for (const [beforeIndex, afterIndex] of pairs) {
    const previous = runs.at(-1);
    if (previous?.beforeEnd === beforeIndex && previous.afterEnd === afterIndex) {
      previous.beforeEnd++;
      previous.afterEnd++;
    } else {
      runs.push({
        beforeStart: beforeIndex,
        beforeEnd: beforeIndex + 1,
        afterStart: afterIndex,
        afterEnd: afterIndex + 1,
      });
    }
  }
  return runs;
}

function isEdgeTextRun(run: CommonTextRun, beforeLength: number, afterLength: number): boolean {
  return (
    (run.beforeStart === 0 && run.afterStart === 0) ||
    (run.beforeEnd === beforeLength && run.afterEnd === afterLength)
  );
}

function pushTextSegmentRange(
  ranges: TextRange[],
  token: WordEmphasisToken,
  segments: TextBoundarySegment[],
  start: number,
  end: number,
): void {
  if (start >= end) return;
  ranges.push([
    token.start + textSegmentOffset(segments, start, token.value.length),
    token.start + textSegmentOffset(segments, end, token.value.length),
  ]);
}

function textSegmentOffset(
  segments: TextBoundarySegment[],
  index: number,
  textLength: number,
): number {
  return index === segments.length ? textLength : segmentAt(segments, index).start;
}

function segmentAt(segments: TextBoundarySegment[], index: number): TextBoundarySegment {
  const segment = segments[index];
  if (segment === undefined) throw new RangeError(`Missing text segment ${index}`);
  return segment;
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
