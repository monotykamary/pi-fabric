import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_DIGEST_TERMS, foldSessionDigest, type SessionDigest } from "./digest.js";
import type { SessionRef } from "./discovery.js";
import type { NormalizedEntry } from "./normalize.js";
import { normalizeSession } from "./normalize.js";

export const DEFAULT_HOT_SESSIONS = 50;

/** A normalized shard persisted to disk and loaded into memory. */
export interface Shard {
  sessionFile: string;
  sessionId: string;
  mtime: number;
  size: number;
  entries: NormalizedEntry[];
  tier?: MemoryTier;
}

/** A persisted cold digest plus the source metadata used for invalidation. */
export interface DigestShard extends SessionDigest {
  mtime: number;
  size: number;
}

type MemoryTier = "hot" | "cold";

export interface MemoryIndexOptions {
  indexDir: string;
  maxEntryChars: number;
  hotSessions?: number;
  digestTerms?: number;
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

const readDigestFile = (filePath: string): DigestShard | null => {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as DigestShard;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.file !== "string" ||
      !Array.isArray(parsed.filesTouched) ||
      !Array.isArray(parsed.terms) ||
      typeof parsed.mtime !== "number" ||
      typeof parsed.size !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const writeCacheFile = (filePath: string, value: Shard | DigestShard): void => {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
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

const fileStat = (file: string): { mtime: number; size: number } => {
  try {
    const stat = fs.statSync(file);
    return { mtime: stat.mtimeMs, size: stat.size };
  } catch {
    return { mtime: 0, size: 0 };
  }
};

const isShardFresh = (shard: Shard | null, file: string, mtime: number, size: number): boolean =>
  shard !== null && shard.sessionFile === file && shard.mtime === mtime && shard.size === size;

const isDigestFresh = (
  digest: DigestShard | null,
  file: string,
  mtime: number,
  size: number,
): boolean => digest !== null && digest.file === file && digest.mtime === mtime && digest.size === size;

/** Build or refresh the shard for a session, parsing lazily only when stale. */
export const loadShard = (ref: SessionRef, options: MemoryIndexOptions): Shard => {
  const filePath = shardPathForSession(ref.file, options.indexDir);
  const { mtime, size } = fileStat(ref.file);
  const cached = readShardFile(filePath);
  if (isShardFresh(cached, ref.file, mtime, size) && cached) return cached;
  const { entries, header } = normalizeSession(ref.file, options.maxEntryChars);
  const sessionId = header?.sessionId ?? ref.id;
  const shard: Shard = { sessionFile: ref.file, sessionId, mtime, size, entries, tier: "hot" };
  if (mtime > 0) writeCacheFile(filePath, shard);
  return shard;
};

/** Parse a session into an entry shard without persisting hot state. */
const hydrateShard = (ref: SessionRef, options: MemoryIndexOptions): Shard => {
  const { mtime, size } = fileStat(ref.file);
  const { entries, header } = normalizeSession(ref.file, options.maxEntryChars);
  return {
    sessionFile: ref.file,
    sessionId: header?.sessionId ?? ref.id,
    mtime,
    size,
    entries,
    tier: "cold",
  };
};

/** Build or refresh the cold digest for a session. */
export const loadDigest = (ref: SessionRef, options: MemoryIndexOptions): DigestShard => {
  const filePath = digestPathForSession(ref.file, options.indexDir);
  const { mtime, size } = fileStat(ref.file);
  const cached = readDigestFile(filePath);
  if (isDigestFresh(cached, ref.file, mtime, size) && cached) return cached;
  const { entries, header } = normalizeSession(ref.file, options.maxEntryChars);
  const digest = foldSessionDigest({
    sessionId: header?.sessionId ?? ref.id,
    file: ref.file,
    cwd: header?.cwd ?? ref.cwd,
    entries,
    digestTerms: options.digestTerms ?? DEFAULT_DIGEST_TERMS,
  });
  const persisted: DigestShard = { ...digest, mtime, size };
  if (mtime > 0) writeCacheFile(filePath, persisted);
  return persisted;
};

const compareRefsByRecency = (left: SessionRef, right: SessionRef): number => {
  if (right.mtime !== left.mtime) return right.mtime - left.mtime;
  return left.file.localeCompare(right.file);
};

/** Classify sessions by global source mtime, with a lexical tie-break. */
const classifySessionTiers = (
  refs: SessionRef[],
  hotSessions = DEFAULT_HOT_SESSIONS,
): Map<string, MemoryTier> => {
  const sorted = [...refs].sort(compareRefsByRecency);
  const hot = new Set(
    sorted.slice(0, Math.max(0, Math.floor(hotSessions))).map((ref) => ref.file),
  );
  return new Map(sorted.map((ref) => [ref.file, hot.has(ref.file) ? "hot" : "cold"]));
};

export interface TieredIndexBundle {
  shards: Shard[];
  digests: DigestShard[];
  refs: SessionRef[];
  tiers: Map<string, MemoryTier>;
}

/**
 * Refresh tier state, then load the selected refs at their configured tier.
 * Existing shards that cross the hot boundary are folded and removed. When
 * `hydrate` is true, selected cold sessions are parsed into ephemeral shards.
 */
export const loadTieredIndex = (
  refs: SessionRef[],
  allRefs: SessionRef[],
  options: MemoryIndexOptions,
  hydrate = false,
): TieredIndexBundle => {
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
  for (const ref of refs) {
    const tier = tiers.get(ref.file) ?? "cold";
    if (tier === "hot") {
      shards.push(loadShard(ref, options));
    } else {
      const digest = loadDigest(ref, options);
      removeCacheFile(shardPathForSession(ref.file, options.indexDir));
      if (hydrate) shards.push(hydrateShard(ref, options));
      else digests.push(digest);
    }
  }
  return { shards, digests, refs, tiers };
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

/** Load hot shards using the round-one behavior, retained for direct callers. */
export const loadShards = (refs: SessionRef[], options: MemoryIndexOptions): ShardBundle => {
  const shards: Shard[] = [];
  for (const ref of refs) shards.push(loadShard(ref, options));
  return { shards, refs };
};

const tokenize = (text: string): string[] =>
  text.toLowerCase().split(/[^a-z0-9_]+/).filter((term) => term.length > 0);

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

/** Score matching entries with BM25 and deterministic entry tie-breaks. */
export const bm25Score = (
  shards: Shard[],
  terms: string[],
  filters: SearchFilters,
): ScoredEntry[] => {
  const matching: { entry: NormalizedEntry; mtime: number }[] = [];
  for (const shard of shards) {
    for (const entry of shard.entries) {
      if (matchesFilters(entry, filters)) matching.push({ entry, mtime: shard.mtime });
    }
  }
  if (matching.length === 0 || terms.length === 0) return [];

  const docs = matching.map((item) => item.entry.text);
  const docTermCounts = docs.map((doc) => Math.max(1, tokenize(doc).length));
  const totalLen = docTermCounts.reduce((sum, length) => sum + length, 0);
  const avgDl = totalLen / matching.length;
  const df = new Map<string, number>();
  for (const doc of docs) {
    const seen = new Set<string>();
    for (const term of terms) {
      if (!seen.has(term) && termFrequency(doc, term) > 0) {
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
    let score = 0;
    for (const term of terms) {
      const tf = termFrequency(doc, term);
      if (tf === 0) continue;
      const docFreq = df.get(term) ?? 0;
      const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1);
      const tfNorm = (tf * (K + 1)) / (tf + K * (1 - B + B * (dl / avgDl)));
      score += idf * tfNorm;
    }
    if (score > 0) results.push({ entry, sessionMtime: mtime, score });
  }

  results.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.sessionMtime !== left.sessionMtime) return right.sessionMtime - left.sessionMtime;
    if (left.entry.index !== right.entry.index) return left.entry.index - right.entry.index;
    return left.entry.sessionFile.localeCompare(right.entry.sessionFile);
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
    return left.entry.sessionFile.localeCompare(right.entry.sessionFile);
  });
  return all.slice(0, Math.max(1, limit));
};
