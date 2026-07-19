// Adapted from pi-code-previews; see THIRD_PARTY_NOTICES.md.
import type { AddedDiffLine, RemovedDiffLine } from "./parse.js";
import type { IndexedChangedLine } from "./changed-line.js";
import {
  changedLineSimilarityDocuments,
  fallbackLineSimilarity,
  hasUniqueSharedSimilarityFeature,
  similarityTokenListWeight,
  similarityTokenWeight,
} from "./line-similarity.js";
import type { WordChangeConfidence } from "./types.js";

export type SparseChangedLinePair = {
  removedIndex: number;
  addedIndex: number;
  confidence: WordChangeConfidence;
};

type SparseChangedLinePairCandidate = {
  removedPosition: number;
  addedPosition: number;
  evidence: number;
  sharedFeatureCount: number;
  hasUniqueFeature: boolean;
  competingEvidence: number;
};

type ScoredSparseChangedLinePairCandidate = SparseChangedLinePairCandidate & {
  score: number;
};

type ChangedLineScoreAt = (removedPosition: number, addedPosition: number) => number;

export type SparseLineMatchingPolicy = {
  minPositionalFallbackPairScore: number;
  minChangedLinePairScore: number;
  competingChangedLineScoreAt: (
    removedLength: number,
    addedLength: number,
    removedPosition: number,
    addedPosition: number,
    scoreAt: ChangedLineScoreAt,
  ) => number;
  isAmbiguousChangedLinePairScore: (score: number, competingScore: number) => boolean;
  isReciprocalBestChangedLinePair: (score: number, competingScore: number) => boolean;
  linePairConfidence: (score: number, competingScore: number) => WordChangeConfidence;
};

export type TopTwoCandidateValues = { best: number; second: number };

const MAX_POSITIONAL_FALLBACK_AMBIGUITY_CELLS = 10_000;
const MAX_SPARSE_FEATURE_DOCUMENTS = 6;
const MAX_SPARSE_FEATURE_DOCUMENTS_PER_SIDE = 3;
const MAX_SPARSE_CANDIDATES_PER_LINE = 8;
const MIN_SPARSE_RARE_FEATURE_COUNT = 2;
const MIN_SPARSE_EVIDENCE_MARGIN = 1;
const MIN_SPARSE_EVIDENCE_RATIO = 0.9;

export function matchChangedLinesSparse(
  removed: Array<IndexedChangedLine<RemovedDiffLine>>,
  added: Array<IndexedChangedLine<AddedDiffLine>>,
  policy: SparseLineMatchingPolicy,
): SparseChangedLinePair[] {
  const similarityDocuments = changedLineSimilarityDocuments(removed, added);
  const tokenWeight = similarityTokenWeight(similarityDocuments);
  const removedWeights: Array<number | undefined> = [];
  const addedWeights: Array<number | undefined> = [];
  const canCheckAmbiguity =
    removed.length * added.length <= MAX_POSITIONAL_FALLBACK_AMBIGUITY_CELLS;
  const scoreCache = canCheckAmbiguity ? new Map<number, number>() : undefined;
  const scoreAt = (removedPosition: number, addedPosition: number): number => {
    const key = removedPosition * added.length + addedPosition;
    const cached = scoreCache?.get(key);
    if (cached !== undefined) return cached;
    const removedFeatures = similarityDocuments.removedFeatures[removedPosition];
    const addedFeatures = similarityDocuments.addedFeatures[addedPosition];
    if (removedFeatures === undefined || addedFeatures === undefined)
      throw new RangeError(`Missing similarity features ${removedPosition}:${addedPosition}`);
    const removedWeight = (removedWeights[removedPosition] ??= similarityTokenListWeight(
      removedFeatures,
      tokenWeight,
    ));
    const addedWeight = (addedWeights[addedPosition] ??= similarityTokenListWeight(
      addedFeatures,
      tokenWeight,
    ));
    const score = fallbackLineSimilarity(
      changedLineAt(removed, removedPosition),
      changedLineAt(added, addedPosition),
      tokenWeight,
      removedWeight,
      addedWeight,
    );
    scoreCache?.set(key, score);
    return score;
  };

  const sparseCandidates = sparseChangedLinePairCandidates(similarityDocuments, tokenWeight);
  const pairs = sparseChangedLineAnchors(removed, added, sparseCandidates, scoreAt, policy);
  const positions = changedLinePositions(removed, added);
  const usedRemoved = new Set<number>();
  const usedAdded = new Set<number>();
  for (const pair of pairs) {
    const removedPosition = positions.removed.get(pair.removedIndex);
    const addedPosition = positions.added.get(pair.addedIndex);
    if (removedPosition !== undefined) usedRemoved.add(removedPosition);
    if (addedPosition !== undefined) usedAdded.add(addedPosition);
  }

  for (let index = 0; index < Math.min(removed.length, added.length); index++) {
    if (usedRemoved.has(index) || usedAdded.has(index)) continue;
    const score = scoreAt(index, index);
    if (score < policy.minPositionalFallbackPairScore) continue;
    const removedLine = changedLineAt(removed, index);
    const addedLine = changedLineAt(added, index);
    if (hasUniqueSharedSimilarityFeature(removedLine, addedLine, similarityDocuments)) {
      pairs.push({
        removedIndex: removedLine.index,
        addedIndex: addedLine.index,
        confidence: policy.linePairConfidence(score, 0),
      });
      usedRemoved.add(index);
      usedAdded.add(index);
      continue;
    }
    if (!canCheckAmbiguity) continue;

    const competingScore = policy.competingChangedLineScoreAt(
      removed.length,
      added.length,
      index,
      index,
      scoreAt,
    );
    if (policy.isAmbiguousChangedLinePairScore(score, competingScore)) continue;
    pairs.push({
      removedIndex: removedLine.index,
      addedIndex: addedLine.index,
      confidence: policy.linePairConfidence(score, competingScore),
    });
    usedRemoved.add(index);
    usedAdded.add(index);
  }
  return pairs.sort(
    (a, b) =>
      (positions.removed.get(a.removedIndex) ?? 0) - (positions.removed.get(b.removedIndex) ?? 0),
  );
}

function sparseChangedLinePairCandidates(
  documents: ReturnType<typeof changedLineSimilarityDocuments>,
  tokenWeight: ReturnType<typeof similarityTokenWeight>,
): SparseChangedLinePairCandidate[] {
  const removedPositions = similarityFeaturePositions(documents.removedFeatures);
  const addedPositions = similarityFeaturePositions(documents.addedFeatures);
  const candidates = new Map<number, SparseChangedLinePairCandidate>();
  const addedLength = documents.addedFeatures.length;

  for (const [feature, featureRemovedPositions] of removedPositions) {
    const featureAddedPositions = addedPositions.get(feature);
    if (!featureAddedPositions) continue;
    const documentCount = documents.documentCounts.get(feature) ?? Number.POSITIVE_INFINITY;
    if (
      documentCount > MAX_SPARSE_FEATURE_DOCUMENTS ||
      featureRemovedPositions.length > MAX_SPARSE_FEATURE_DOCUMENTS_PER_SIDE ||
      featureAddedPositions.length > MAX_SPARSE_FEATURE_DOCUMENTS_PER_SIDE
    )
      continue;
    const weight = tokenWeight(feature);
    if (weight < 1) continue;
    const uniqueFeature =
      documentCount === 2 &&
      featureRemovedPositions.length === 1 &&
      featureAddedPositions.length === 1;

    for (const removedPosition of featureRemovedPositions) {
      for (const addedPosition of featureAddedPositions) {
        const key = removedPosition * addedLength + addedPosition;
        const candidate = candidates.get(key);
        if (candidate) {
          candidate.evidence += weight;
          candidate.sharedFeatureCount++;
          candidate.hasUniqueFeature ||= uniqueFeature;
        } else {
          candidates.set(key, {
            removedPosition,
            addedPosition,
            evidence: weight,
            sharedFeatureCount: 1,
            hasUniqueFeature: uniqueFeature,
            competingEvidence: 0,
          });
        }
      }
    }
  }

  const candidateList = [...candidates.values()];
  addCompetingSparseEvidence(candidateList);
  return boundedSparseChangedLinePairCandidates(candidateList);
}

function similarityFeaturePositions(featureLists: string[][]): Map<string, number[]> {
  const positions = new Map<string, number[]>();
  for (let position = 0; position < featureLists.length; position++) {
    const features = featureLists[position];
    if (!features) continue;
    for (const feature of new Set(features)) {
      const featurePositions = positions.get(feature);
      if (featurePositions) featurePositions.push(position);
      else positions.set(feature, [position]);
    }
  }
  return positions;
}

function addCompetingSparseEvidence(candidates: SparseChangedLinePairCandidate[]): void {
  const removedEvidence = topTwoCandidateValues(
    candidates,
    (candidate) => candidate.removedPosition,
    (candidate) => candidate.evidence,
  );
  const addedEvidence = topTwoCandidateValues(
    candidates,
    (candidate) => candidate.addedPosition,
    (candidate) => candidate.evidence,
  );
  for (const candidate of candidates) {
    candidate.competingEvidence = Math.max(
      competingCandidateValue(removedEvidence.get(candidate.removedPosition), candidate.evidence),
      competingCandidateValue(addedEvidence.get(candidate.addedPosition), candidate.evidence),
    );
  }
}

function topTwoCandidateValues<T>(
  candidates: T[],
  position: (candidate: T) => number,
  value: (candidate: T) => number,
): Map<number, TopTwoCandidateValues> {
  const values = new Map<number, TopTwoCandidateValues>();
  for (const candidate of candidates) {
    const current = values.get(position(candidate)) ?? { best: 0, second: 0 };
    const candidateValue = value(candidate);
    if (candidateValue >= current.best) {
      current.second = current.best;
      current.best = candidateValue;
    } else if (candidateValue > current.second) current.second = candidateValue;
    values.set(position(candidate), current);
  }
  return values;
}

export function competingCandidateValue(
  values: TopTwoCandidateValues | undefined,
  candidateValue: number,
): number {
  if (!values) return 0;
  return candidateValue === values.best ? values.second : values.best;
}

function boundedSparseChangedLinePairCandidates(
  candidates: SparseChangedLinePairCandidate[],
): SparseChangedLinePairCandidate[] {
  const byRemoved = new Map<number, SparseChangedLinePairCandidate[]>();
  const byAdded = new Map<number, SparseChangedLinePairCandidate[]>();
  for (const candidate of candidates) {
    appendSparseCandidate(byRemoved, candidate.removedPosition, candidate);
    appendSparseCandidate(byAdded, candidate.addedPosition, candidate);
  }
  const selectedByRemoved = topSparseCandidates(byRemoved);
  const selectedByAdded = topSparseCandidates(byAdded);
  return candidates.filter(
    (candidate) => selectedByRemoved.has(candidate) && selectedByAdded.has(candidate),
  );
}

function appendSparseCandidate(
  candidates: Map<number, SparseChangedLinePairCandidate[]>,
  position: number,
  candidate: SparseChangedLinePairCandidate,
): void {
  const atPosition = candidates.get(position);
  if (atPosition) atPosition.push(candidate);
  else candidates.set(position, [candidate]);
}

function topSparseCandidates(
  candidates: Map<number, SparseChangedLinePairCandidate[]>,
): Set<SparseChangedLinePairCandidate> {
  const selected = new Set<SparseChangedLinePairCandidate>();
  for (const atPosition of candidates.values()) {
    atPosition.sort(compareSparseCandidates);
    for (const candidate of atPosition.slice(0, MAX_SPARSE_CANDIDATES_PER_LINE))
      selected.add(candidate);
  }
  return selected;
}

function compareSparseCandidates(
  a: SparseChangedLinePairCandidate,
  b: SparseChangedLinePairCandidate,
): number {
  return (
    Number(b.hasUniqueFeature) - Number(a.hasUniqueFeature) ||
    b.evidence - a.evidence ||
    b.sharedFeatureCount - a.sharedFeatureCount ||
    Math.abs(a.removedPosition - a.addedPosition) - Math.abs(b.removedPosition - b.addedPosition) ||
    a.removedPosition - b.removedPosition ||
    a.addedPosition - b.addedPosition
  );
}

function sparseChangedLineAnchors(
  removed: Array<IndexedChangedLine<RemovedDiffLine>>,
  added: Array<IndexedChangedLine<AddedDiffLine>>,
  sparseCandidates: SparseChangedLinePairCandidate[],
  scoreAt: ChangedLineScoreAt,
  policy: SparseLineMatchingPolicy,
): SparseChangedLinePair[] {
  const scoredCandidates: ScoredSparseChangedLinePairCandidate[] = sparseCandidates
    .map((candidate) => ({
      ...candidate,
      score: scoreAt(candidate.removedPosition, candidate.addedPosition),
    }))
    .sort((a, b) => b.score - a.score || compareSparseCandidates(a, b));
  const removedScores = topTwoCandidateValues(
    scoredCandidates,
    (candidate) => candidate.removedPosition,
    (candidate) => candidate.score,
  );
  const addedScores = topTwoCandidateValues(
    scoredCandidates,
    (candidate) => candidate.addedPosition,
    (candidate) => candidate.score,
  );
  const usedRemoved = new Set<number>();
  const usedAdded = new Set<number>();
  const pairs: SparseChangedLinePair[] = [];

  for (const candidate of scoredCandidates) {
    if (candidate.score < policy.minChangedLinePairScore) continue;
    if (usedRemoved.has(candidate.removedPosition) || usedAdded.has(candidate.addedPosition))
      continue;
    if (!hasStrongSparseEvidence(candidate)) continue;
    const competingScore = Math.max(
      competingCandidateValue(removedScores.get(candidate.removedPosition), candidate.score),
      competingCandidateValue(addedScores.get(candidate.addedPosition), candidate.score),
      sparsePositionalCompetingScore(candidate, removed.length, added.length, scoreAt),
    );
    if (!policy.isReciprocalBestChangedLinePair(candidate.score, competingScore)) continue;
    usedRemoved.add(candidate.removedPosition);
    usedAdded.add(candidate.addedPosition);
    pairs.push({
      removedIndex: changedLineAt(removed, candidate.removedPosition).index,
      addedIndex: changedLineAt(added, candidate.addedPosition).index,
      confidence: policy.linePairConfidence(candidate.score, competingScore),
    });
  }
  return pairs;
}

function sparsePositionalCompetingScore(
  candidate: SparseChangedLinePairCandidate,
  removedLength: number,
  addedLength: number,
  scoreAt: ChangedLineScoreAt,
): number {
  let competingScore = 0;
  if (
    candidate.removedPosition < addedLength &&
    candidate.addedPosition !== candidate.removedPosition
  )
    competingScore = scoreAt(candidate.removedPosition, candidate.removedPosition);
  if (
    candidate.addedPosition < removedLength &&
    candidate.removedPosition !== candidate.addedPosition
  )
    competingScore = Math.max(
      competingScore,
      scoreAt(candidate.addedPosition, candidate.addedPosition),
    );
  return competingScore;
}

function hasStrongSparseEvidence(candidate: SparseChangedLinePairCandidate): boolean {
  if (!candidate.hasUniqueFeature && candidate.sharedFeatureCount < MIN_SPARSE_RARE_FEATURE_COUNT)
    return false;
  return (
    candidate.evidence - candidate.competingEvidence > MIN_SPARSE_EVIDENCE_MARGIN &&
    candidate.competingEvidence < candidate.evidence * MIN_SPARSE_EVIDENCE_RATIO
  );
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

function changedLineAt<T extends AddedDiffLine | RemovedDiffLine>(
  lines: Array<IndexedChangedLine<T>>,
  index: number,
): IndexedChangedLine<T> {
  const line = lines[index];
  if (line === undefined) throw new RangeError(`Missing changed line ${index}`);
  return line;
}
