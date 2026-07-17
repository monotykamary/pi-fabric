import type { NormalizedEntry } from "./normalize.js";

export const DEFAULT_DIGEST_TERMS = 200;
const DEFAULT_FILES_TOUCHED_LIMIT = 50;

export interface SessionDigest {
  sessionId: string;
  file: string;
  cwd: string;
  firstTs: number | null;
  lastTs: number | null;
  entryCount: number;
  goalLine: string;
  filesTouched: string[];
  toolHistogram: Record<string, number>;
  errorCount: number;
  terms: string[];
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
}

const tokenizeDigestText = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((term) => term.length > 1 && !/^\d+$/.test(term));

const extractTerms = (entries: NormalizedEntry[], limit: number): string[] => {
  const stats = new Map<string, TermStats>();
  for (const entry of entries) {
    const terms = tokenizeDigestText(entry.text);
    const seen = new Set<string>();
    for (const term of terms) {
      const current = stats.get(term) ?? { documentFrequency: 0, frequency: 0 };
      current.frequency += 1;
      if (!seen.has(term)) {
        current.documentFrequency += 1;
        seen.add(term);
      }
      stats.set(term, current);
    }
  }
  return [...stats.entries()]
    .sort(([leftTerm, left], [rightTerm, right]) => {
      if (right.documentFrequency !== left.documentFrequency) {
        return right.documentFrequency - left.documentFrequency;
      }
      if (right.frequency !== left.frequency) return right.frequency - left.frequency;
      return leftTerm.localeCompare(rightTerm);
    })
    .slice(0, Math.max(0, limit))
    .map(([term]) => term);
};

const firstUserLine = (entries: NormalizedEntry[]): string => {
  const user = entries.find((entry) => entry.role === "user");
  if (!user) return "";
  return user.text.split(/\r?\n/, 1)[0]?.trim() ?? "";
};

/** Purely fold normalized session entries into a compact, deterministic digest. */
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

  const toolHistogram = Object.fromEntries(
    [...tools.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );

  return {
    sessionId: input.sessionId,
    file: input.file,
    cwd: input.cwd,
    firstTs,
    lastTs,
    entryCount: input.entries.length,
    goalLine: firstUserLine(input.entries),
    filesTouched,
    toolHistogram,
    errorCount,
    terms: extractTerms(input.entries, input.digestTerms ?? DEFAULT_DIGEST_TERMS),
  };
};
