import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_DIGEST_TERMS, foldSessionDigest, type SessionDigest } from "./digest.js";
import type { SessionRef } from "./discovery.js";
import type { NormalizedEntry } from "./normalize.js";
import { normalizeSession } from "./normalize.js";
import { compareLexical, lexicalTermCounts, tokenizeLexical } from "./tokenize.js";

export const MEMORY_CACHE_VERSION = 2;
export const DEFAULT_HOT_SESSIONS = 50;

type MemoryTier = "hot" | "cold";

interface CacheRecord {
  cacheVersion: typeof MEMORY_CACHE_VERSION;
  kind: "shard" | "digest";
  mtime: number;
  size: number;
  sourceHash: string;
}

/** A normalized shard persisted to disk and loaded into memory. */
export interface Shard extends CacheRecord {
  kind: "shard";
  sessionFile: string;
  sessionId: string;
  entries: NormalizedEntry[];
  tier?: MemoryTier;
}

/** A persisted cold digest plus exact source metadata used for invalidation. */
export interface DigestShard extends SessionDigest, CacheRecord {
  kind: "digest";
}

export interface MemoryIndexOptions {
  indexDir: string;
  maxEntryChars: number;
  hotSessions?: number;
  digestTerms?: number;
}

export interface EntryRange {
  first: number;
  last: number;
}

const cacheBaseName = (sessionFile: string): string => {
  const hash = crypto.createHash("sha1").update(sessionFile).digest("hex").slice(0, 16);
  const safeBase = path.basename(sessionFile).replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${hash}-${safeBase}`;
};

export const shardPathForSession = (sessionFile: string, indexDir: string): string =>
  path.join(indexDir, `${cacheBaseName(sessionFile)}.json`);

export const digestPathForSession = (sessionFile: string, indexDir: string): string =>
  path.join(indexDir, `${cacheBaseName(sessionFile)}.digest.json`);

const readShardFile = (filePath: string): Shard | null => {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Shard;
    if (
      parsed.cacheVersion !== MEMORY_CACHE_VERSION ||
      parsed.kind !== "shard" ||
      typeof parsed.sessionFile !== "string" ||
      typeof parsed.sourceHash !== "string" ||
      !Array.isArray(parsed.entries)
    ) return null;
    return parsed;
  } catch {
    return null;
  }
};

const readDigestFile = (filePath: string): DigestShard | null => {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as DigestShard;
    if (
      parsed.cacheVersion !== MEMORY_CACHE_VERSION ||
      parsed.kind !== "digest" ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.file !== "string" ||
      typeof parsed.sourceHash !== "string" ||
      !Array.isArray(parsed.filesTouched) ||
      !Array.isArray(parsed.terms) ||
      !Array.isArray(parsed.vocabulary) ||
      !Array.isArray(parsed.addresses) ||
      typeof parsed.mtime !== "number" ||
      typeof parsed.size !== "number"
    ) return null;
    return parsed;
  } catch {
    return null;
  }
};

const writeCacheFile = (filePath: string, value: Shard | DigestShard): void => {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(filePath), 0o700); } catch {}
    fs.writeFileSync(filePath, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch {}
  } catch {
    // Cache persistence is best effort; source JSONL remains the truth.
  }
};

const removeCacheFile = (filePath: string): void => {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Cache cleanup is best effort.
  }
};

interface SourceState {
  mtime: number;
  size: number;
  sourceHash: string;
}

const sourceState = (file: string): SourceState | null => {
  try {
    const content = fs.readFileSync(file);
    const stat = fs.statSync(file);
    return {
      mtime: stat.mtimeMs,
      size: stat.size,
      sourceHash: crypto.createHash("sha256").update(content).digest("hex"),
    };
  } catch {
    return null;
  }
};

const isCacheFresh = (cache: CacheRecord | null, state: SourceState): boolean =>
  cache !== null &&
  cache.mtime === state.mtime &&
  cache.size === state.size &&
  cache.sourceHash === state.sourceHash;

const missingShard = (ref: SessionRef): Shard => ({
  cacheVersion: MEMORY_CACHE_VERSION,
  kind: "shard",
  sessionFile: ref.file,
  sessionId: ref.id,
  mtime: 0,
  size: 0,
  sourceHash: "",
  entries: [],
  tier: "hot",
});

/** Build or refresh the shard for a session, parsing lazily only when stale. */
export const loadShard = (ref: SessionRef, options: MemoryIndexOptions): Shard => {
  const filePath = shardPathForSession(ref.file, options.indexDir);
  const state = sourceState(ref.file);
  if (!state) return missingShard(ref);
  const cached = readShardFile(filePath);
  if (isCacheFresh(cached, state) && cached) return cached;
  const { entries, header } = normalizeSession(ref.file, options.maxEntryChars);
  const shard: Shard = {
    cacheVersion: MEMORY_CACHE_VERSION,
    kind: "shard",
    sessionFile: ref.file,
    sessionId: header?.sessionId ?? ref.id,
    ...state,
    entries,
    tier: "hot",
  };
  writeCacheFile(filePath, shard);
  return shard;
};

/** Parse a session into an entry shard without persisting hot state. */
const hydrateShard = (
  ref: SessionRef,
  options: MemoryIndexOptions,
  entryRange?: EntryRange,
): Shard => {
  const state = sourceState(ref.file);
  if (!state) return { ...missingShard(ref), tier: "cold" };
  const { entries, header } = normalizeSession(ref.file, options.maxEntryChars);
  const selected = entryRange
    ? entries.filter((entry) => entry.index >= entryRange.first && entry.index <= entryRange.last)
    : entries;
  return {
    cacheVersion: MEMORY_CACHE_VERSION,
    kind: "shard",
    sessionFile: ref.file,
    sessionId: header?.sessionId ?? ref.id,
    ...state,
    entries: selected,
    tier: "cold",
  };
};

const missingDigest = (ref: SessionRef): DigestShard => ({
  cacheVersion: MEMORY_CACHE_VERSION,
  kind: "digest",
  sessionId: ref.id,
  file: ref.file,
  cwd: ref.cwd,
  firstTs: null,
  lastTs: null,
  entryCount: 0,
  filesTouched: [],
  toolHistogram: {},
  errorCount: 0,
  terms: [],
  vocabulary: [],
  addresses: [],
  mtime: 0,
  size: 0,
  sourceHash: "",
});

/** Build or refresh a cold digest from full normalized text, then discard that text. */
export const loadDigest = (ref: SessionRef, options: MemoryIndexOptions): DigestShard => {
  const filePath = digestPathForSession(ref.file, options.indexDir);
  const state = sourceState(ref.file);
  if (!state) return missingDigest(ref);
  const cached = readDigestFile(filePath);
  if (isCacheFresh(cached, state) && cached) return cached;
  const { entries, header } = normalizeSession(ref.file, Number.MAX_SAFE_INTEGER);
  const digest = foldSessionDigest({
    sessionId: header?.sessionId ?? ref.id,
    file: ref.file,
    cwd: header?.cwd ?? ref.cwd,
    entries,
    digestTerms: options.digestTerms ?? DEFAULT_DIGEST_TERMS,
  });
  const persisted: DigestShard = {
    cacheVersion: MEMORY_CACHE_VERSION,
    kind: "digest",
    ...digest,
    ...state,
  };
  writeCacheFile(filePath, persisted);
  return persisted;
};

const compareRefsByRecency = (left: SessionRef, right: SessionRef): number => {
  if (right.mtime !== left.mtime) return right.mtime - left.mtime;
  return compareLexical(left.file, right.file);
};

/** Classify sessions by global source mtime, with a lexical tie-break. */
const classifySessionTiers = (
  refs: SessionRef[],
  hotSessions = DEFAULT_HOT_SESSIONS,
): Map<string, MemoryTier> => {
  const sorted = [...refs].sort(compareRefsByRecency);
  const hot = new Set(sorted.slice(0, Math.max(0, Math.floor(hotSessions))).map((ref) => ref.file));
  return new Map(sorted.map((ref) => [ref.file, hot.has(ref.file) ? "hot" : "cold"]));
};

export interface MemoryCoverage {
  complete: boolean;
  indexedSessions: number;
  eligibleSessions: number;
  staleSessions: number;
}

export interface TieredIndexBundle {
  shards: Shard[];
  digests: DigestShard[];
  refs: SessionRef[];
  tiers: Map<string, MemoryTier>;
  coverage: MemoryCoverage;
}

const removeDeletedSourceCaches = (indexDir: string): void => {
  let names: string[];
  try {
    names = fs.readdirSync(indexDir).filter((name) => name.endsWith(".json"));
  } catch {
    return;
  }
  for (const name of names) {
    const cacheFile = path.join(indexDir, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as Record<string, unknown>;
      const source = typeof parsed.sessionFile === "string"
        ? parsed.sessionFile
        : typeof parsed.file === "string" ? parsed.file : null;
      if (source && !fs.existsSync(source)) removeCacheFile(cacheFile);
    } catch {
      // Invalid cache records are rejected on normal load.
    }
  }
};

/** Refresh tier state and load every selected session at its configured tier. */
export const loadTieredIndex = (
  refs: SessionRef[],
  allRefs: SessionRef[],
  options: MemoryIndexOptions,
  hydrate = false,
  entryRange?: EntryRange,
): TieredIndexBundle => {
  removeDeletedSourceCaches(options.indexDir);
  const tierRefs = allRefs.length > 0 ? allRefs : refs;
  const tiers = classifySessionTiers(tierRefs, options.hotSessions ?? DEFAULT_HOT_SESSIONS);

  for (const ref of tierRefs) {
    const tier = tiers.get(ref.file) ?? "cold";
    if (tier === "hot") {
      removeCacheFile(digestPathForSession(ref.file, options.indexDir));
      continue;
    }
    const shardPath = shardPathForSession(ref.file, options.indexDir);
    if (fs.existsSync(shardPath)) {
      loadDigest(ref, options);
      removeCacheFile(shardPath);
    }
  }

  const shards: Shard[] = [];
  const digests: DigestShard[] = [];
  let indexedSessions = 0;
  for (const ref of refs) {
    const tier = tiers.get(ref.file) ?? "cold";
    if (hydrate) {
      if (tier === "cold") loadDigest(ref, options);
      const shard = hydrateShard(ref, options, entryRange);
      shards.push(shard);
      if (shard.sourceHash) indexedSessions += 1;
    } else if (tier === "hot") {
      const shard = loadShard(ref, options);
      shards.push(shard);
      if (shard.sourceHash) indexedSessions += 1;
    } else {
      const digest = loadDigest(ref, options);
      removeCacheFile(shardPathForSession(ref.file, options.indexDir));
      digests.push(digest);
      if (digest.sourceHash) indexedSessions += 1;
    }
  }
  const eligibleSessions = refs.length;
  const staleSessions = eligibleSessions - indexedSessions;
  return {
    shards,
    digests,
    refs,
    tiers,
    coverage: {
      complete: staleSessions === 0,
      indexedSessions,
      eligibleSessions,
      staleSessions,
    },
  };
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
  if (filters.since !== undefined && entry.timestamp !== null && entry.timestamp < filters.since) return false;
  if (filters.until !== undefined && entry.timestamp !== null && entry.timestamp > filters.until) return false;
  return true;
};

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

/** Load hot shards using the original direct-caller behavior. */
export const loadShards = (refs: SessionRef[], options: MemoryIndexOptions): ShardBundle => ({
  shards: refs.map((ref) => loadShard(ref, options)),
  refs,
});

/** Score matching entries with exact-token BM25 and deterministic tie-breaks. */
export const bm25Score = (
  shards: Shard[],
  terms: string[],
  filters: SearchFilters,
): ScoredEntry[] => {
  const queryTerms = [...new Set(terms.flatMap((term) => tokenizeLexical(term)))];
  const matching: { entry: NormalizedEntry; mtime: number; counts: Map<string, number> }[] = [];
  for (const shard of shards) {
    for (const entry of shard.entries) {
      if (matchesFilters(entry, filters)) {
        matching.push({ entry, mtime: shard.mtime, counts: lexicalTermCounts(entry.text) });
      }
    }
  }
  if (matching.length === 0 || queryTerms.length === 0) return [];

  const lengths = matching.map((item) => Math.max(1, [...item.counts.values()].reduce((a, b) => a + b, 0)));
  const averageLength = lengths.reduce((sum, length) => sum + length, 0) / matching.length;
  const documentFrequency = new Map<string, number>();
  for (const item of matching) {
    for (const term of queryTerms) {
      if ((item.counts.get(term) ?? 0) > 0) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
  }

  const K = 1.2;
  const B = 0.75;
  const results: ScoredEntry[] = [];
  for (let index = 0; index < matching.length; index += 1) {
    const item = matching[index]!;
    let score = 0;
    for (const term of queryTerms) {
      const tf = item.counts.get(term) ?? 0;
      if (tf === 0) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log((matching.length - df + 0.5) / (df + 0.5) + 1);
      const normalized = (tf * (K + 1)) /
        (tf + K * (1 - B + B * (lengths[index]! / averageLength)));
      score += idf * normalized;
    }
    if (score > 0) results.push({ entry: item.entry, sessionMtime: item.mtime, score });
  }

  results.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.sessionMtime !== left.sessionMtime) return right.sessionMtime - left.sessionMtime;
    if (left.entry.index !== right.entry.index) return left.entry.index - right.entry.index;
    return compareLexical(left.entry.sessionFile, right.entry.sessionFile);
  });
  return results;
};

/** Browse the newest entries across shards. */
export const recentEntries = (
  shards: Shard[],
  filters: SearchFilters,
  limit: number,
): IndexedEntry[] => {
  const all: IndexedEntry[] = [];
  for (const shard of shards) {
    for (const entry of shard.entries) {
      if (matchesFilters(entry, filters)) all.push({ entry, sessionMtime: shard.mtime });
    }
  }
  all.sort((left, right) => {
    if (right.sessionMtime !== left.sessionMtime) return right.sessionMtime - left.sessionMtime;
    if (left.entry.index !== right.entry.index) return left.entry.index - right.entry.index;
    return compareLexical(left.entry.sessionFile, right.entry.sessionFile);
  });
  return all.slice(0, Math.max(1, limit));
};
