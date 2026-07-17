import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NormalizedEntry } from "./normalize.js";
import { normalizeSession } from "./normalize.js";
import type { SessionRef } from "./discovery.js";

/** A normalized shard persisted to disk and loaded into memory. */
export interface Shard {
  sessionFile: string;
  sessionId: string;
  mtime: number;
  size: number;
  entries: NormalizedEntry[];
}

export interface MemoryIndexOptions {
  indexDir: string;
  maxEntryChars: number;
}

const shardFileName = (sessionFile: string): string => {
  const hash = crypto.createHash("sha1").update(sessionFile).digest("hex").slice(0, 16);
  const safeBase = path.basename(sessionFile).replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${hash}-${safeBase}.json`;
};

const readShardFile = (filePath: string): Shard | null => {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Shard;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.sessionFile !== "string" ||
      !Array.isArray(parsed.entries)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const writeShardFile = (filePath: string, shard: Shard): void => {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(shard), "utf8");
  } catch {
    // best-effort persistence; in-memory cache still serves this session
  }
};

const fileStat = (
  file: string,
): { mtime: number; size: number } => {
  try {
    const stat = fs.statSync(file);
    return { mtime: stat.mtimeMs, size: stat.size };
  } catch {
    return { mtime: 0, size: 0 };
  }
};

const isShardFresh = (shard: Shard | null, mtime: number, size: number): boolean =>
  shard !== null && shard.mtime === mtime && shard.size === size;

/** Build or refresh the shard for a session, parsing lazily only when stale. */
export const loadShard = (
  ref: SessionRef,
  options: MemoryIndexOptions,
): Shard => {
  const filePath = path.join(options.indexDir, shardFileName(ref.file));
  const { mtime, size } = fileStat(ref.file);
  const cached = readShardFile(filePath);
  if (isShardFresh(cached, mtime, size) && cached) return cached;
  const { entries, header } = normalizeSession(ref.file, options.maxEntryChars);
  const sessionId = header?.sessionId ?? ref.id;
  const shard: Shard = { sessionFile: ref.file, sessionId, mtime, size, entries };
  if (mtime > 0) writeShardFile(filePath, shard);
  return shard;
};

export interface SearchFilters {
  role?: string;
  tool?: string;
  since?: number;
  until?: number;
}

const matchesFilters = (entry: NormalizedEntry, filters: SearchFilters): boolean => {
  if (filters.role !== undefined && entry.role !== filters.role) return false;
  if (filters.tool !== undefined && entry.toolName !== filters.tool) return false;
  if (filters.since !== undefined && entry.timestamp !== null && entry.timestamp < filters.since) {
    return false;
  }
  if (filters.until !== undefined && entry.timestamp !== null && entry.timestamp > filters.until) {
    return false;
  }
  return true;
};

/** A candidate entry with its owning shard and source ref, prior to scoring. */
export interface IndexedEntry {
  entry: NormalizedEntry;
  sessionMtime: number;
}

export interface ScoredEntry extends IndexedEntry {
  score: number;
}

export interface ShardBundle {
  shards: Shard[];
  refs: SessionRef[];
}

/** Load shards for all refs, keeping deterministic load order (refs order). */
export const loadShards = (
  refs: SessionRef[],
  options: MemoryIndexOptions,
): ShardBundle => {
  const shards: Shard[] = [];
  for (const ref of refs) {
    shards.push(loadShard(ref, options));
  }
  return { shards, refs };
};

const tokenize = (text: string): string[] => {
  const normalized = text.toLowerCase();
  const terms = normalized.split(/[^a-z0-9_]+/).filter((term) => term.length > 0);
  return terms;
};

const termFrequency = (text: string, term: string): number => {
  let count = 0;
  let index = 0;
  const lower = text.toLowerCase();
  while (index <= lower.length) {
    const found = lower.indexOf(term, index);
    if (found === -1) break;
    count += 1;
    index = found + term.length;
  }
  return count;
};

/**
 * Score all matching entries against query terms using BM25, implemented by
 * hand with no dependencies. Document = a single normalized entry's text;
 * corpus = the union of every loaded shard's matching entries.
 *
 * Deterministic tie-breaks: score desc, then session mtime desc, then entry
 * index asc, then sessionFile lexicographic asc.
 */
export const bm25Score = (
  shards: Shard[],
  terms: string[],
  filters: SearchFilters,
): ScoredEntry[] => {
  const matching: { entry: NormalizedEntry; mtime: number }[] = [];
  for (const shard of shards) {
    for (const entry of shard.entries) {
      if (!matchesFilters(entry, filters)) continue;
      matching.push({ entry, mtime: shard.mtime });
    }
  }
  if (matching.length === 0 || terms.length === 0) return [];

  const docs = matching.map((item) => item.entry.text);
  const docTermCounts: number[] = docs.map((doc) =>
    tokenize(doc).length > 0 ? tokenize(doc).length : 1,
  );
  const totalLen = docTermCounts.reduce((sum, length) => sum + length, 0);
  const avgDl = totalLen / Math.max(matching.length, 1);

  const df = new Map<string, number>();
  for (const doc of docs) {
    const lower = doc.toLowerCase();
    const seen = new Set<string>();
    for (const term of terms) {
      if (seen.has(term)) continue;
      if (termFrequency(lower, term) > 0) {
        seen.add(term);
        df.set(term, (df.get(term) ?? 0) + 1);
      }
    }
  }

  const K = 1.2;
  const B = 0.75;
  const N = matching.length;
  const results: ScoredEntry[] = [];
  for (let documentIndex = 0; documentIndex < matching.length; documentIndex += 1) {
    const { entry, mtime } = matching[documentIndex]!;
    const doc = docs[documentIndex]!;
    const dl = docTermCounts[documentIndex]!;
    const lower = doc.toLowerCase();
    let score = 0;
    for (const term of terms) {
      const tf = termFrequency(lower, term);
      if (tf === 0) continue;
      const docFreq = df.get(term) ?? 0;
      const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1);
      const tfNorm = (tf * (K + 1)) / (tf + K * (1 - B + B * (dl / avgDl)));
      score += idf * tfNorm;
    }
    if (score <= 0) continue;
    results.push({ entry, sessionMtime: mtime, score });
  }

  results.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.sessionMtime !== left.sessionMtime) return right.sessionMtime - left.sessionMtime;
    if (left.entry.index !== right.entry.index) return left.entry.index - right.entry.index;
    return left.entry.sessionFile.localeCompare(right.entry.sessionFile);
  });
  return results;
};

/** Browse the newest `limit` entries across shards (no query), newest mtime first. */
export const recentEntries = (
  shards: Shard[],
  filters: SearchFilters,
  limit: number,
): IndexedEntry[] => {
  const all: IndexedEntry[] = [];
  for (const shard of shards) {
    for (const entry of shard.entries) {
      if (!matchesFilters(entry, filters)) continue;
      all.push({ entry, sessionMtime: shard.mtime });
    }
  }
  all.sort((left, right) => {
    if (right.sessionMtime !== left.sessionMtime) return right.sessionMtime - left.sessionMtime;
    if (left.entry.index !== right.entry.index) return left.entry.index - right.entry.index;
    return left.entry.sessionFile.localeCompare(right.entry.sessionFile);
  });
  return all.slice(0, Math.max(1, limit));
};
