import type { NormalizedEntry } from "./normalize.js";
import type { DigestShard, Shard } from "./index.js";
import { bm25Score, recentEntries, type ScoredEntry } from "./index.js";

export interface SearchQuery {
  query?: string;
  filters?: {
    role?: string;
    tool?: string;
    since?: number;
    until?: number;
  };
  limit?: number;
}

interface SearchSegmentEntry {
  entry: NormalizedEntry;
  matched: boolean;
  marker: ">" | " ";
}

interface SearchSegment {
  sessionId: string;
  sessionFile: string;
  sessionMtime: number;
  range: string;
  entries: SearchSegmentEntry[];
  matchedCount: number;
  score: number;
  tier: "hot" | "cold";
}

interface DigestHit {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  lastTs: number | null;
  sessionMtime: number;
  score: number;
  tier: "cold";
}

export type SearchItem =
  | { kind: "entry"; segment: SearchSegment }
  | { kind: "digest"; digest: DigestHit };

export interface SearchResult {
  matchedCount: number;
  segmentCount: number;
  segments: SearchSegment[];
  digestHits: DigestHit[];
  items: SearchItem[];
}

interface SearchFilters {
  role?: string;
  tool?: string;
  since?: number;
  until?: number;
}

const tryCompileRegex = (query: string): RegExp | null => {
  try {
    return new RegExp(query, "i");
  } catch {
    return null;
  }
};

const looksLikeRegex = (query: string): boolean => {
  if (!query) return false;
  const trimmed = query.trim();
  if (!/[|*+?{}()[\]\\^$.]/.test(trimmed)) return false;
  return tryCompileRegex(trimmed) !== null;
};

const segmentStartRoles = new Set(["user", "bashExecution", "compaction"]);

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

const digestMatchesFilters = (digest: DigestShard, filters: SearchFilters): boolean => {
  if (filters.role !== undefined) return false;
  if (filters.tool !== undefined && !Object.hasOwn(digest.toolHistogram, filters.tool)) return false;
  if (filters.since !== undefined && digest.lastTs !== null && digest.lastTs < filters.since) {
    return false;
  }
  if (filters.until !== undefined && digest.firstTs !== null && digest.firstTs > filters.until) {
    return false;
  }
  return true;
};

interface LocatedEntry {
  entry: NormalizedEntry;
  matched: boolean;
  sessionMtime: number;
  score: number;
}

const sortLocated = (located: LocatedEntry[]): void => {
  located.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.sessionMtime !== left.sessionMtime) return right.sessionMtime - left.sessionMtime;
    if (left.entry.index !== right.entry.index) return left.entry.index - right.entry.index;
    return left.entry.sessionFile.localeCompare(right.entry.sessionFile);
  });
};

const collectRegexMatches = (shards: Shard[], regex: RegExp, filters: SearchFilters): LocatedEntry[] => {
  const matches: LocatedEntry[] = [];
  for (const shard of shards) {
    for (const entry of shard.entries) {
      if (!matchesFilters(entry, filters)) continue;
      const hay = `${entry.role ?? ""} ${entry.toolName ?? ""} ${entry.text}`;
      if (regex.test(hay)) {
        matches.push({ entry, matched: true, sessionMtime: shard.mtime, score: 1 });
      }
    }
  }
  return matches;
};

const queryTerms = (query: string): string[] =>
  query
    .split(/\s+/)
    .map((term) => term.toLowerCase())
    .filter((term) => term.length > 0);

const collectTermMatches = (shards: Shard[], query: string, filters: SearchFilters): LocatedEntry[] => {
  const scored: ScoredEntry[] = bm25Score(shards, queryTerms(query), filters);
  return scored.map((item) => ({
    entry: item.entry,
    matched: true,
    sessionMtime: item.sessionMtime,
    score: item.score,
  }));
};

const collectRecent = (shards: Shard[], filters: SearchFilters): LocatedEntry[] =>
  recentEntries(shards, filters, 25).map((item) => ({
    entry: item.entry,
    matched: true,
    sessionMtime: item.sessionMtime,
    score: 0,
  }));

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

const digestDocument = (digest: DigestShard): string =>
  `${digest.goalLine} ${digest.filesTouched.join(" ")} ${digest.terms.join(" ")}`;

const scoreDigestTerms = (
  digests: DigestShard[],
  terms: string[],
  filters: SearchFilters,
): DigestHit[] => {
  const candidates = digests.filter((digest) => digestMatchesFilters(digest, filters));
  if (candidates.length === 0 || terms.length === 0) return [];
  const documents = candidates.map(digestDocument);
  const lengths = documents.map((document) =>
    Math.max(1, document.split(/[^a-z0-9_]+/i).filter(Boolean).length),
  );
  const averageLength = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const term of new Set(terms)) {
      if (termFrequency(document, term) > 0) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
  }

  const K = 1.2;
  const B = 0.75;
  const hits: DigestHit[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const digest = candidates[index]!;
    const document = documents[index]!;
    const length = lengths[index]!;
    let score = 0;
    for (const term of terms) {
      const tf = termFrequency(document, term);
      if (tf === 0) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log((candidates.length - df + 0.5) / (df + 0.5) + 1);
      const normalized = (tf * (K + 1)) / (tf + K * (1 - B + B * (length / averageLength)));
      score += idf * normalized;
    }
    if (score > 0) hits.push(toDigestHit(digest, score));
  }
  return hits;
};

const scoreDigestRegex = (
  digests: DigestShard[],
  regex: RegExp,
  filters: SearchFilters,
): DigestHit[] =>
  digests
    .filter((digest) => digestMatchesFilters(digest, filters) && regex.test(digestDocument(digest)))
    .map((digest) => toDigestHit(digest, 1));

const toDigestHit = (digest: DigestShard, score: number): DigestHit => ({
  sessionId: digest.sessionId,
  sessionFile: digest.file,
  cwd: digest.cwd,
  lastTs: digest.lastTs,
  sessionMtime: digest.mtime,
  score,
  tier: "cold",
});

const sortDigestHits = (hits: DigestHit[]): void => {
  hits.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.sessionMtime !== left.sessionMtime) return right.sessionMtime - left.sessionMtime;
    return left.sessionFile.localeCompare(right.sessionFile);
  });
};

/** Search hot entry shards and cold session digests. */
export const searchMemoryIndex = (
  shards: Shard[],
  digests: DigestShard[],
  query: SearchQuery,
): SearchResult => {
  const filters: SearchFilters = query.filters ?? {};
  const rawQuery = query.query?.trim();
  const limit = query.limit ?? 50;
  let located: LocatedEntry[];
  let digestHits: DigestHit[] = [];
  let hasQuery: boolean;

  if (!rawQuery) {
    located = collectRecent(shards, filters);
    hasQuery = false;
  } else if (looksLikeRegex(rawQuery)) {
    const regex = tryCompileRegex(rawQuery)!;
    located = collectRegexMatches(shards, regex, filters);
    digestHits = scoreDigestRegex(digests, regex, filters);
    sortLocated(located);
    hasQuery = true;
  } else {
    located = collectTermMatches(shards, rawQuery, filters);
    digestHits = scoreDigestTerms(digests, queryTerms(rawQuery), filters);
    hasQuery = true;
  }

  located = located.slice(0, limit);
  sortDigestHits(digestHits);
  digestHits = digestHits.slice(0, limit);
  return groupIntoResults(shards, located, digestHits, hasQuery, limit);
};

/** Search entry shards only, retaining the round-one API. */
export const searchShards = (shards: Shard[], query: SearchQuery): SearchResult =>
  searchMemoryIndex(shards, [], query);

const groupIntoResults = (
  shards: Shard[],
  located: LocatedEntry[],
  digestHits: DigestHit[],
  hasQuery: boolean,
  limit: number,
): SearchResult => {
  if (located.length === 0 && digestHits.length === 0) {
    return { matchedCount: 0, segmentCount: 0, segments: [], digestHits: [], items: [] };
  }

  const shardsByFile = new Map(shards.map((shard) => [shard.sessionFile, shard]));
  const sessionOrder: string[] = [];
  const matchedBySession = new Map<string, Set<number>>();
  const scores = new Map<string, number>();
  for (const item of located) {
    if (!matchedBySession.has(item.entry.sessionFile)) sessionOrder.push(item.entry.sessionFile);
    const set = matchedBySession.get(item.entry.sessionFile) ?? new Set<number>();
    set.add(item.entry.index);
    matchedBySession.set(item.entry.sessionFile, set);
    scores.set(`${item.entry.sessionFile}\0${item.entry.index}`, item.score);
  }

  const segments: SearchSegment[] = [];
  for (const file of sessionOrder) {
    const shard = shardsByFile.get(file);
    const matchedSet = matchedBySession.get(file);
    if (!shard || !matchedSet) continue;
    let current: NormalizedEntry[] = [];
    let currentStart = 0;
    const flush = (): void => {
      if (current.length === 0) return;
      const entries: SearchSegmentEntry[] = current.map((entry) => {
        const matched = matchedSet.has(entry.index);
        return { entry, matched, marker: hasQuery ? (matched ? ">" : " ") : ">" };
      });
      const matchedEntries = entries.filter((entry) => entry.matched);
      if (hasQuery && matchedEntries.length === 0) {
        current = [];
        return;
      }
      const lastIndex = current[current.length - 1]!.index;
      const range = lastIndex === currentStart ? `#${currentStart}` : `#${currentStart}-#${lastIndex}`;
      const score = Math.max(
        0,
        ...matchedEntries.map((item) => scores.get(`${file}\0${item.entry.index}`) ?? 0),
      );
      segments.push({
        sessionId: shard.sessionId,
        sessionFile: shard.sessionFile,
        sessionMtime: shard.mtime,
        range,
        entries,
        matchedCount: matchedEntries.length,
        score,
        tier: shard.tier ?? "hot",
      });
      current = [];
    };

    for (const entry of shard.entries) {
      if (current.length > 0 && entry.role !== null && segmentStartRoles.has(entry.role)) flush();
      if (current.length === 0) currentStart = entry.index;
      current.push(entry);
    }
    flush();
  }

  const items: SearchItem[] = [
    ...segments.map((segment): SearchItem => ({ kind: "entry", segment })),
    ...digestHits.map((digest): SearchItem => ({ kind: "digest", digest })),
  ];
  items.sort(compareSearchItems);
  const limitedItems = items.slice(0, Math.max(1, limit));
  const limitedSegments = limitedItems
    .filter((item): item is { kind: "entry"; segment: SearchSegment } => item.kind === "entry")
    .map((item) => item.segment);
  const limitedDigests = limitedItems
    .filter((item): item is { kind: "digest"; digest: DigestHit } => item.kind === "digest")
    .map((item) => item.digest);
  const matchedCount = limitedSegments.reduce((sum, segment) => sum + segment.matchedCount, 0)
    + limitedDigests.length;
  return {
    matchedCount,
    segmentCount: limitedSegments.length,
    segments: limitedSegments,
    digestHits: limitedDigests,
    items: limitedItems,
  };
};

const compareSearchItems = (left: SearchItem, right: SearchItem): number => {
  const leftValue = left.kind === "entry" ? left.segment : left.digest;
  const rightValue = right.kind === "entry" ? right.segment : right.digest;
  if (rightValue.score !== leftValue.score) return rightValue.score - leftValue.score;
  if (rightValue.sessionMtime !== leftValue.sessionMtime) {
    return rightValue.sessionMtime - leftValue.sessionMtime;
  }
  if (left.kind !== right.kind) return left.kind === "entry" ? -1 : 1;
  if (left.kind === "entry" && right.kind === "entry") {
    const leftIndex = left.segment.entries[0]?.entry.index ?? 0;
    const rightIndex = right.segment.entries[0]?.entry.index ?? 0;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return left.segment.sessionFile.localeCompare(right.segment.sessionFile);
  }
  if (left.kind === "digest" && right.kind === "digest") {
    return left.digest.sessionFile.localeCompare(right.digest.sessionFile);
  }
  return 0;
};

/** Render entry segments and cold session pointers as deterministic text. */
export const formatSearchResult = (result: SearchResult, query: string | undefined): string => {
  if (result.items.length === 0) {
    return query ? `No matches for "${query}".` : "No entries in scope.";
  }
  const coldSuffix = result.digestHits.length > 0
    ? ` and ${result.digestHits.length} cold session${result.digestHits.length === 1 ? "" : "s"}`
    : "";
  const header = query
    ? `${result.matchedCount} matches across ${result.segmentCount} segment${result.segmentCount === 1 ? "" : "s"}${coldSuffix} for "${query}":`
    : `${result.matchedCount} most recent entries:`;
  const body = result.items.map((item) =>
    item.kind === "entry" ? formatSegment(item.segment) : formatDigestHit(item.digest),
  ).join("\n\n");
  return `${header}\n\n${body}`;
};

const formatDigestHit = (hit: DigestHit): string => {
  const timestamp = hit.lastTs === null ? "unknown time" : new Date(hit.lastTs).toISOString();
  return `> session ${hit.sessionId} (cold, ${hit.cwd}, ${timestamp}) matched — re-run with scope "session:${hit.sessionId}" to search its entries.`;
};

const formatSegment = (segment: SearchSegment): string => {
  const lines: string[] = [];
  lines.push(`--- ${segment.range} (${segment.matchedCount}/${segment.entries.length} match) ---`);
  for (const item of segment.entries) lines.push(formatEntry(item));
  return lines.join("\n");
};

const formatEntry = (item: SearchSegmentEntry): string => {
  const entry = item.entry;
  const role = entry.role ?? entry.type;
  const toolSuffix = entry.toolName ? ` ${entry.toolName}` : "";
  const errorSuffix = entry.isError ? " [error]" : "";
  const truncatedSuffix = entry.truncated ? " …[truncated]" : "";
  const body = item.matched ? entry.text : "";
  return `${item.marker} #${entry.index} [${role}${toolSuffix}]${errorSuffix} ${body}${truncatedSuffix}`;
};
