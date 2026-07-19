import type { WordChangeConfidence } from "./types.js";
import type { AddedDiffLine, RemovedDiffLine } from "./parse.js";
import { prefixAlignedPairs } from "./alignment.js";
import {
  changedLineSimilarityDocuments,
  fallbackLineSimilarity,
  hasUniqueSharedSimilarityFeature,
  similarityTokenWeight,
  tokenSimilarity,
} from "./line-similarity.js";
import type { IndexedChangedLine } from "./changed-line.js";

export {
  changedLineTokens,
  indexedChangedLine,
  normalizedChangedContent,
  type IndexedChangedLine,
} from "./changed-line.js";

export type ChangedLinePair = {
  removedIndex: number;
  addedIndex: number;
  confidence: WordChangeConfidence;
};

type ChangedLinePairCandidate = {
  removedPosition: number;
  addedPosition: number;
  score: number;
};

type ChangedLinePositionPair = [removedPosition: number, addedPosition: number];
type ChangedLineIndexPair = [removedIndex: number, addedIndex: number];
type ChangedLineScoreAt = (removedPosition: number, addedPosition: number) => number;

export function matchChangedLines(
  removed: Array<IndexedChangedLine<RemovedDiffLine>>,
  added: Array<IndexedChangedLine<AddedDiffLine>>,
): ChangedLinePair[] {
  if (removed.length === 0 || added.length === 0) return [];
  if (removed.length * added.length > MAX_CHANGED_LINE_PAIR_CELLS)
    return matchChangedLinesByPosition(removed, added);
  const similarityDocuments = changedLineSimilarityDocuments(removed, added);
  const tokenWeight = similarityTokenWeight(similarityDocuments);
  const { removedFeatures, addedFeatures } = similarityDocuments;
  const scores = removedFeatures.map((beforeTokens) =>
    addedFeatures.map((afterTokens) => tokenSimilarity(beforeTokens, afterTokens, tokenWeight)),
  );
  const similarPairs = prefixAlignedPairs(
    removed.length,
    added.length,
    (removedPosition, addedPosition) => {
      const score = scores[removedPosition]?.[addedPosition] ?? 0;
      return score >= MIN_CHANGED_LINE_PAIR_SCORE ? score + 0.01 : Number.NEGATIVE_INFINITY;
    },
  );
  if (similarPairs.length === 0 && removed.length === 1 && added.length === 1)
    return [
      {
        removedIndex: changedLineAt(removed, 0).index,
        addedIndex: changedLineAt(added, 0).index,
        confidence: "medium",
      },
    ];
  const positions = changedLinePositions(removed, added);
  const confidentPairs = confidentChangedLinePairs(
    positions,
    scores,
    addPositionalFallbackPairs(removed, added, scores, similarPairs),
  );
  return addHighConfidenceCrossingPairs(removed, added, scores, positions, confidentPairs);
}

const MIN_CHANGED_LINE_PAIR_SCORE = 0.45;
const MIN_POSITIONAL_FALLBACK_PAIR_SCORE = 0.28;
const CHANGED_LINE_PAIR_AMBIGUITY_MARGIN = 0.06;
const CHANGED_LINE_PAIR_AMBIGUITY_RATIO = 0.92;
const MIN_HIGH_CONFIDENCE_CROSSING_PAIR_SCORE = 0.72;
const HIGH_CONFIDENCE_CROSSING_PAIR_MARGIN = 0.12;
const HIGH_CONFIDENCE_CROSSING_PAIR_RATIO = 0.85;
const MAX_CHANGED_LINE_PAIR_CELLS = 1024;
const MAX_POSITIONAL_FALLBACK_AMBIGUITY_CELLS = 10_000;

function matchChangedLinesByPosition(
  removed: Array<IndexedChangedLine<RemovedDiffLine>>,
  added: Array<IndexedChangedLine<AddedDiffLine>>,
): ChangedLinePair[] {
  const pairs: ChangedLinePair[] = [];
  const similarityDocuments = changedLineSimilarityDocuments(removed, added);
  const tokenWeight = similarityTokenWeight(similarityDocuments);
  const canCheckAmbiguity =
    removed.length * added.length <= MAX_POSITIONAL_FALLBACK_AMBIGUITY_CELLS;
  const scoreCache = new Map<string, number>();
  const scoreAt = (removedPosition: number, addedPosition: number): number => {
    const key = `${removedPosition}:${addedPosition}`;
    const cached = scoreCache.get(key);
    if (cached !== undefined) return cached;
    const score = fallbackLineSimilarity(
      changedLineAt(removed, removedPosition),
      changedLineAt(added, addedPosition),
      tokenWeight,
    );
    scoreCache.set(key, score);
    return score;
  };

  for (let index = 0; index < Math.min(removed.length, added.length); index++) {
    const score = scoreAt(index, index);
    if (score < MIN_POSITIONAL_FALLBACK_PAIR_SCORE) continue;
    const removedLine = changedLineAt(removed, index);
    const addedLine = changedLineAt(added, index);
    if (hasUniqueSharedSimilarityFeature(removedLine, addedLine, similarityDocuments)) {
      pairs.push({
        removedIndex: removedLine.index,
        addedIndex: addedLine.index,
        confidence: linePairConfidence(score, 0),
      });
      continue;
    }
    if (!canCheckAmbiguity) continue;

    const competingScore = competingChangedLineScoreAt(
      removed.length,
      added.length,
      index,
      index,
      scoreAt,
    );
    if (isAmbiguousChangedLinePairScore(score, competingScore)) continue;
    pairs.push({
      removedIndex: removedLine.index,
      addedIndex: addedLine.index,
      confidence: linePairConfidence(score, competingScore),
    });
  }
  return pairs;
}

type ChangedLinePositions = {
  removed: Map<number, number>;
  added: Map<number, number>;
};

function changedLinePositions(
  removed: Array<IndexedChangedLine<RemovedDiffLine>>,
  added: Array<IndexedChangedLine<AddedDiffLine>>,
): ChangedLinePositions {
  return {
    removed: new Map(removed.map((line, index) => [line.index, index])),
    added: new Map(added.map((line, index) => [line.index, index])),
  };
}

function confidentChangedLinePairs(
  positions: ChangedLinePositions,
  scores: number[][],
  pairs: ChangedLineIndexPair[],
): ChangedLinePair[] {
  const confidentPairs: ChangedLinePair[] = [];
  for (const [removedIndex, addedIndex] of pairs) {
    const removedPosition = positions.removed.get(removedIndex);
    const addedPosition = positions.added.get(addedIndex);
    if (removedPosition === undefined || addedPosition === undefined) continue;
    const score = scores[removedPosition]?.[addedPosition] ?? 0;
    const competingScore = competingChangedLineScore(scores, removedPosition, addedPosition);
    if (isAmbiguousChangedLinePairScore(score, competingScore)) continue;
    confidentPairs.push({
      removedIndex,
      addedIndex,
      confidence: linePairConfidence(score, competingScore),
    });
  }
  return confidentPairs;
}

function competingChangedLineScore(
  scores: number[][],
  removedPosition: number,
  addedPosition: number,
  usedRemoved?: ReadonlySet<number>,
  usedAdded?: ReadonlySet<number>,
): number {
  return competingChangedLineScoreAt(
    scores.length,
    scores[removedPosition]?.length ?? 0,
    removedPosition,
    addedPosition,
    (candidateRemovedPosition, candidateAddedPosition) =>
      scores[candidateRemovedPosition]?.[candidateAddedPosition] ?? 0,
    usedRemoved,
    usedAdded,
  );
}

function competingChangedLineScoreAt(
  removedLength: number,
  addedLength: number,
  removedPosition: number,
  addedPosition: number,
  scoreAt: ChangedLineScoreAt,
  usedRemoved?: ReadonlySet<number>,
  usedAdded?: ReadonlySet<number>,
): number {
  let competingScore = 0;
  for (
    let candidateAddedPosition = 0;
    candidateAddedPosition < addedLength;
    candidateAddedPosition++
  ) {
    if (candidateAddedPosition === addedPosition || usedAdded?.has(candidateAddedPosition))
      continue;
    competingScore = Math.max(competingScore, scoreAt(removedPosition, candidateAddedPosition));
  }
  for (
    let candidateRemovedPosition = 0;
    candidateRemovedPosition < removedLength;
    candidateRemovedPosition++
  ) {
    if (candidateRemovedPosition === removedPosition || usedRemoved?.has(candidateRemovedPosition))
      continue;
    competingScore = Math.max(competingScore, scoreAt(candidateRemovedPosition, addedPosition));
  }
  return competingScore;
}

function isAmbiguousChangedLinePairScore(score: number, competingScore: number): boolean {
  return (
    competingScore >= MIN_POSITIONAL_FALLBACK_PAIR_SCORE &&
    (score - competingScore <= CHANGED_LINE_PAIR_AMBIGUITY_MARGIN ||
      competingScore >= score * CHANGED_LINE_PAIR_AMBIGUITY_RATIO)
  );
}

function linePairConfidence(score: number, competingScore: number): WordChangeConfidence {
  if (
    score >= MIN_HIGH_CONFIDENCE_CROSSING_PAIR_SCORE &&
    score - competingScore >= HIGH_CONFIDENCE_CROSSING_PAIR_MARGIN &&
    competingScore <= score * HIGH_CONFIDENCE_CROSSING_PAIR_RATIO
  )
    return "high";
  return "medium";
}

function addHighConfidenceCrossingPairs(
  removed: Array<IndexedChangedLine<RemovedDiffLine>>,
  added: Array<IndexedChangedLine<AddedDiffLine>>,
  scores: number[][],
  positions: ChangedLinePositions,
  pairs: ChangedLinePair[],
): ChangedLinePair[] {
  const usedRemoved = new Set<number>();
  const usedAdded = new Set<number>();
  for (const pair of pairs) {
    const removedPosition = positions.removed.get(pair.removedIndex);
    const addedPosition = positions.added.get(pair.addedIndex);
    if (removedPosition !== undefined) usedRemoved.add(removedPosition);
    if (addedPosition !== undefined) usedAdded.add(addedPosition);
  }

  const candidates: ChangedLinePairCandidate[] = [];
  for (let removedPosition = 0; removedPosition < removed.length; removedPosition++) {
    if (usedRemoved.has(removedPosition)) continue;
    for (let addedPosition = 0; addedPosition < added.length; addedPosition++) {
      if (usedAdded.has(addedPosition)) continue;
      const score = scores[removedPosition]?.[addedPosition] ?? 0;
      if (score >= MIN_HIGH_CONFIDENCE_CROSSING_PAIR_SCORE)
        candidates.push({ removedPosition, addedPosition, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  const out = [...pairs];
  for (const candidate of candidates) {
    if (usedRemoved.has(candidate.removedPosition) || usedAdded.has(candidate.addedPosition))
      continue;
    if (!isHighConfidenceCrossingPair(scores, candidate, usedRemoved, usedAdded)) continue;
    usedRemoved.add(candidate.removedPosition);
    usedAdded.add(candidate.addedPosition);
    out.push({
      removedIndex: changedLineAt(removed, candidate.removedPosition).index,
      addedIndex: changedLineAt(added, candidate.addedPosition).index,
      confidence: "high",
    });
  }

  return out.sort(
    (a, b) =>
      (positions.removed.get(a.removedIndex) ?? 0) - (positions.removed.get(b.removedIndex) ?? 0),
  );
}

function isHighConfidenceCrossingPair(
  scores: number[][],
  candidate: ChangedLinePairCandidate,
  usedRemoved: Set<number>,
  usedAdded: Set<number>,
): boolean {
  return (
    linePairConfidence(
      candidate.score,
      competingChangedLineScore(
        scores,
        candidate.removedPosition,
        candidate.addedPosition,
        usedRemoved,
        usedAdded,
      ),
    ) === "high"
  );
}

function addPositionalFallbackPairs(
  removed: Array<IndexedChangedLine<RemovedDiffLine>>,
  added: Array<IndexedChangedLine<AddedDiffLine>>,
  scores: number[][],
  similarPairs: ChangedLinePositionPair[],
): ChangedLineIndexPair[] {
  const pairs: ChangedLineIndexPair[] = [];
  let removedCursor = 0;
  let addedCursor = 0;
  for (const [removedPosition, addedPosition] of similarPairs) {
    pairs.push(
      ...positionPairs(
        removed,
        added,
        scores,
        removedCursor,
        removedPosition,
        addedCursor,
        addedPosition,
      ),
    );
    pairs.push([
      changedLineAt(removed, removedPosition).index,
      changedLineAt(added, addedPosition).index,
    ]);
    removedCursor = removedPosition + 1;
    addedCursor = addedPosition + 1;
  }
  pairs.push(
    ...positionPairs(
      removed,
      added,
      scores,
      removedCursor,
      removed.length,
      addedCursor,
      added.length,
    ),
  );
  return pairs;
}

function positionPairs(
  removed: Array<IndexedChangedLine<RemovedDiffLine>>,
  added: Array<IndexedChangedLine<AddedDiffLine>>,
  scores: number[][],
  removedStart: number,
  removedEnd: number,
  addedStart: number,
  addedEnd: number,
): ChangedLineIndexPair[] {
  const pairs: ChangedLineIndexPair[] = [];
  const count = Math.min(removedEnd - removedStart, addedEnd - addedStart);
  for (let offset = 0; offset < count; offset++) {
    const removedPosition = removedStart + offset;
    const addedPosition = addedStart + offset;
    const score = scores[removedPosition]?.[addedPosition] ?? 0;
    if (score < MIN_POSITIONAL_FALLBACK_PAIR_SCORE) continue;
    pairs.push([
      changedLineAt(removed, removedPosition).index,
      changedLineAt(added, addedPosition).index,
    ]);
  }
  return pairs;
}

function changedLineAt<T extends AddedDiffLine | RemovedDiffLine>(
  lines: Array<IndexedChangedLine<T>>,
  index: number,
): IndexedChangedLine<T> {
  const line = lines[index];
  if (line === undefined) throw new RangeError(`Missing changed line ${index}`);
  return line;
}
