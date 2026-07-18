import type { NormalizedEntry } from "./normalize.js";
import { compareLexical, tokenizeLexical } from "./tokenize.js";

export const DEFAULT_DIGEST_TERMS = 200;
const DEFAULT_FILES_TOUCHED_LIMIT = 50;

/** Compact tuple: index, entry id, role, tool name, timestamp. */
export type DigestEntryAddress = [number, string | null, string | null, string | null, number | null];

/** Compact tuple: normalized lexical term and the sorted entry indices containing it. */
type DigestVocabularyAddress = [string, number[]];

export interface SessionDigest {
  sessionId: string;
  file: string;
  cwd: string;
  firstTs: number | null;
  lastTs: number | null;
  entryCount: number;
  filesTouched: string[];
  toolHistogram: Record<string, number>;
  errorCount: number;
  /** DF-weighted terms retained only for ranking/display compatibility. */
  terms: string[];
  /** Every unique canonical lexical term, sorted with exact entry addresses. */
  vocabulary: DigestVocabularyAddress[];
  /** Structural address metadata; no normalized entry text is retained. */
  addresses: DigestEntryAddress[];
}

export interface DigestInput {
  sessionId: string;
  file: string;
  cwd: string;
  entries: NormalizedEntry[];
  digestTerms?: number;
  filesTouchedLimit?: number;
}

interface TermStats {
  documentFrequency: number;
  frequency: number;
  indices: number[];
}

const collectTermStats = (entries: NormalizedEntry[]): Map<string, TermStats> => {
  const stats = new Map<string, TermStats>();
  for (const entry of entries) {
    const seen = new Set<string>();
    for (const term of tokenizeLexical(entry.text)) {
      const current = stats.get(term) ?? { documentFrequency: 0, frequency: 0, indices: [] };
      current.frequency += 1;
      if (!seen.has(term)) {
        current.documentFrequency += 1;
        current.indices.push(entry.index);
        seen.add(term);
      }
      stats.set(term, current);
    }
  }
  return stats;
};

const extractTopTerms = (stats: Map<string, TermStats>, limit: number): string[] =>
  [...stats.entries()]
    .sort(([leftTerm, left], [rightTerm, right]) => {
      if (right.documentFrequency !== left.documentFrequency) {
        return right.documentFrequency - left.documentFrequency;
      }
      if (right.frequency !== left.frequency) return right.frequency - left.frequency;
      return compareLexical(leftTerm, rightTerm);
    })
    .slice(0, Math.max(0, limit))
    .map(([term]) => term);

/** Purely fold normalized session entries into lexical/address metadata. */
export const foldSessionDigest = (input: DigestInput): SessionDigest => {
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let errorCount = 0;
  const filesTouched: string[] = [];
  const seenFiles = new Set<string>();
  const tools = new Map<string, number>();
  const filesLimit = Math.max(0, input.filesTouchedLimit ?? DEFAULT_FILES_TOUCHED_LIMIT);

  for (const entry of input.entries) {
    if (entry.timestamp !== null) {
      firstTs = firstTs === null ? entry.timestamp : Math.min(firstTs, entry.timestamp);
      lastTs = lastTs === null ? entry.timestamp : Math.max(lastTs, entry.timestamp);
    }
    if (entry.isError) errorCount += 1;
    if (entry.toolName) tools.set(entry.toolName, (tools.get(entry.toolName) ?? 0) + 1);
    for (const file of entry.filesTouched ?? []) {
      if (filesTouched.length >= filesLimit) break;
      const normalized = file.trim();
      if (!normalized || seenFiles.has(normalized)) continue;
      seenFiles.add(normalized);
      filesTouched.push(normalized);
    }
  }

  const termStats = collectTermStats(input.entries);
  const vocabulary: DigestVocabularyAddress[] = [...termStats.entries()]
    .sort(([left], [right]) => compareLexical(left, right))
    .map(([term, stats]) => [term, stats.indices]);
  const toolHistogram = Object.fromEntries(
    [...tools.entries()].sort(([left], [right]) => compareLexical(left, right)),
  );
  const addresses: DigestEntryAddress[] = input.entries.map((entry) => [
    entry.index,
    entry.entryId,
    entry.role,
    entry.toolName,
    entry.timestamp,
  ]);

  return {
    sessionId: input.sessionId,
    file: input.file,
    cwd: input.cwd,
    firstTs,
    lastTs,
    entryCount: input.entries.length,
    filesTouched,
    toolHistogram,
    errorCount,
    terms: extractTopTerms(termStats, input.digestTerms ?? DEFAULT_DIGEST_TERMS),
    vocabulary,
    addresses,
  };
};
