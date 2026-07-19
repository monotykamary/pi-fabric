import type { AddedDiffLine, RemovedDiffLine } from "./parse.js";
import { suffixAlignmentScore } from "./alignment.js";
import { wordEmphasisSimilarityTokenValues, wordEmphasisTokenWeight } from "./tokens.js";
import { changedLineTokens, type IndexedChangedLine } from "./changed-line.js";

export type ChangedLineSimilarityDocuments = {
  removedFeatures: string[][];
  addedFeatures: string[][];
  documentCounts: Map<string, number>;
};

export type SimilarityTokenWeight = (token: string) => number;

const SIMILARITY_BIGRAM_PREFIX = "\u0000PI_SIM_BIGRAM\u0000";
const MAX_LINE_TOKEN_SIMILARITY_CELLS = 16_384;

function changedLineSimilarityTokenValues(
  line: IndexedChangedLine<AddedDiffLine | RemovedDiffLine>,
): string[] {
  return (line.similarityTokenValues ??= wordEmphasisSimilarityTokenValues(
    changedLineTokens(line),
  ));
}

function changedLineSimilarityFeatureValues(
  line: IndexedChangedLine<AddedDiffLine | RemovedDiffLine>,
): string[] {
  return (line.similarityFeatureValues ??= similarityFeatures(
    changedLineSimilarityTokenValues(line),
  ));
}

export function changedLineSimilarityDocuments(
  removed: Array<IndexedChangedLine<RemovedDiffLine>>,
  added: Array<IndexedChangedLine<AddedDiffLine>>,
): ChangedLineSimilarityDocuments {
  const removedFeatures = removed.map(changedLineSimilarityFeatureValues);
  const addedFeatures = added.map(changedLineSimilarityFeatureValues);
  const documentCounts = new Map<string, number>();
  for (const features of [...removedFeatures, ...addedFeatures]) {
    for (const feature of new Set(features))
      documentCounts.set(feature, (documentCounts.get(feature) ?? 0) + 1);
  }
  return { removedFeatures, addedFeatures, documentCounts };
}

export function hasUniqueSharedSimilarityFeature(
  removed: IndexedChangedLine<RemovedDiffLine>,
  added: IndexedChangedLine<AddedDiffLine>,
  documents: ChangedLineSimilarityDocuments,
): boolean {
  const addedFeatures = new Set(changedLineSimilarityFeatureValues(added));
  for (const feature of new Set(changedLineSimilarityFeatureValues(removed))) {
    if (!addedFeatures.has(feature)) continue;
    if (documents.documentCounts.get(feature) === 2 && tokenWeight(feature) >= 1) return true;
  }
  return false;
}

function similarityFeatures(tokens: string[]): string[] {
  const features = [...tokens];
  appendSimilarityShingles(
    features,
    tokens.filter(isSimilarityShingleToken),
    2,
    SIMILARITY_BIGRAM_PREFIX,
  );
  return features;
}

function appendSimilarityShingles(
  features: string[],
  tokens: string[],
  size: number,
  prefix: string,
): void {
  for (let index = 0; index + size <= tokens.length; index++)
    features.push(`${prefix}${tokens.slice(index, index + size).join("\u0000")}`);
}

function isSimilarityShingleToken(token: string): boolean {
  return wordEmphasisTokenWeight(token) >= 1;
}

export function similarityTokenWeight(
  documents: ChangedLineSimilarityDocuments,
): SimilarityTokenWeight {
  const weights = new Map<string, number>();
  const lineCount = documents.removedFeatures.length + documents.addedFeatures.length;
  return (token) => {
    const cached = weights.get(token);
    if (cached !== undefined) return cached;
    const documentCount = documents.documentCounts.get(token) ?? lineCount;
    const rarity = Math.min(3, 1 + Math.log((lineCount + 1) / (documentCount + 1)));
    const weight = tokenWeight(token) * rarity;
    weights.set(token, weight);
    return weight;
  };
}

export function fallbackLineSimilarity(
  removed: IndexedChangedLine<RemovedDiffLine>,
  added: IndexedChangedLine<AddedDiffLine>,
  weight: SimilarityTokenWeight,
): number {
  return unorderedTokenSimilarity(
    changedLineSimilarityFeatureValues(removed),
    changedLineSimilarityFeatureValues(added),
    weight,
  );
}

export function tokenSimilarity(
  beforeTokens: string[],
  afterTokens: string[],
  weight: SimilarityTokenWeight = tokenWeight,
): number {
  if (beforeTokens.length === 0 || afterTokens.length === 0)
    return beforeTokens.length === afterTokens.length ? 1 : 0;
  const bagSimilarity = unorderedTokenSimilarity(beforeTokens, afterTokens, weight);
  const orderedSimilarity = orderedTokenSimilarity(beforeTokens, afterTokens, weight);
  if (orderedSimilarity === undefined) return bagSimilarity;
  return Math.max(
    orderedSimilarity,
    bagSimilarity * 0.8,
    orderedSimilarity * 0.75 + bagSimilarity * 0.25,
  );
}

function unorderedTokenSimilarity(
  beforeTokens: string[],
  afterTokens: string[],
  weight: SimilarityTokenWeight,
): number {
  const beforeWeight = tokenListWeight(beforeTokens, weight);
  const afterWeight = tokenListWeight(afterTokens, weight);
  const remaining = new Map<string, number>();
  for (const token of beforeTokens) remaining.set(token, (remaining.get(token) ?? 0) + 1);
  let sharedWeight = 0;
  for (const token of afterTokens) {
    const count = remaining.get(token) ?? 0;
    if (count === 0) continue;
    sharedWeight += weight(token);
    if (count === 1) remaining.delete(token);
    else remaining.set(token, count - 1);
  }
  return (2 * sharedWeight) / (beforeWeight + afterWeight);
}

function orderedTokenSimilarity(
  beforeTokens: string[],
  afterTokens: string[],
  weight: SimilarityTokenWeight,
): number | undefined {
  if (beforeTokens.length * afterTokens.length > MAX_LINE_TOKEN_SIMILARITY_CELLS) return undefined;
  const beforeWeight = tokenListWeight(beforeTokens, weight);
  const afterWeight = tokenListWeight(afterTokens, weight);
  const score = suffixAlignmentScore(
    beforeTokens.length,
    afterTokens.length,
    (beforeIndex, afterIndex) => {
      const beforeToken = stringAt(beforeTokens, beforeIndex);
      return beforeToken === stringAt(afterTokens, afterIndex)
        ? weight(beforeToken)
        : Number.NEGATIVE_INFINITY;
    },
  );

  return (2 * score) / (beforeWeight + afterWeight);
}

function tokenListWeight(tokens: string[], weight: SimilarityTokenWeight): number {
  return tokens.reduce((total, token) => total + weight(token), 0);
}

function tokenWeight(token: string): number {
  if (token.startsWith(SIMILARITY_BIGRAM_PREFIX)) return 1.15;
  return wordEmphasisTokenWeight(token);
}

function stringAt(values: string[], index: number): string {
  const value = values[index];
  if (value === undefined) throw new RangeError(`Missing similarity token ${index}`);
  return value;
}
