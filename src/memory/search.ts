import type { DigestEntryAddress } from "./digest.js";
import type { NormalizedEntry } from "./normalize.js";
import type { DigestShard, MemoryCoverage, Shard } from "./index.js";
import { bm25Score, recentEntries, type ScoredEntry } from "./index.js";
import { compareLexical, planMemoryQuery } from "./tokenize.js";

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
  entryRange: { first: number; last: number };
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
  matchedEntries: number;
  entryRange: { first: number; last: number };
  entryIds: string[];
  entryIdsTruncated: boolean;
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

const DIGEST_HIT_ENTRY_IDS_LIMIT = 50;
const segmentStartRoles = new Set(["user", "bashExecution", "compaction"]);

const matchesFilters = (entry: NormalizedEntry, filters: SearchFilters): boolean => {
  if (filters.role !== undefined && entry.role !== filters.role) return false;
  if (filters.tool !== undefined && entry.toolName !== filters.tool) return false;
  if (filters.since !== undefined && entry.timestamp !== null && entry.timestamp < filters.since) return false;
  if (filters.until !== undefined && entry.timestamp !== null && entry.timestamp > filters.until) return false;
  return true;
};

const addressMatchesFilters = (address: DigestEntryAddress, filters: SearchFilters): boolean => {
  if (filters.role !== undefined && address[2] !== filters.role) return false;
  if (filters.tool !== undefined && address[3] !== filters.tool) return false;
  if (filters.since !== undefined && address[4] !== null && address[4] < filters.since) return false;
  if (filters.until !== undefined && address[4] !== null && address[4] > filters.until) return false;
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
    return compareLexical(left.entry.sessionFile, right.entry.sessionFile);
  });
};

const collectRegexMatches = (shards: Shard[], regex: RegExp, filters: SearchFilters): LocatedEntry[] => {
  const matches: LocatedEntry[] = [];
  for (const shard of shards) {
    for (const entry of shard.entries) {
      if (!matchesFilters(entry, filters)) continue;
      const haystack = `${entry.role ?? ""} ${entry.toolName ?? ""} ${entry.text}`;
      if (regex.test(haystack)) {
        matches.push({ entry, matched: true, sessionMtime: shard.mtime, score: 1 });
      }
    }
  }
  return matches;
};

const collectTermMatches = (
  shards: Shard[],
  terms: string[],
  filters: SearchFilters,
): LocatedEntry[] => {
  const scored: ScoredEntry[] = bm25Score(shards, terms, filters);
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

interface DigestCandidate {
  digest: DigestShard;
  matchedIndices: number[];
  score: number;
}

const eligibleAddressMap = (
  digest: DigestShard,
  filters: SearchFilters,
): Map<number, DigestEntryAddress> =>
  new Map(
    digest.addresses
      .filter((address) => addressMatchesFilters(address, filters))
      .map((address) => [address[0], address]),
  );

const scoreDigestTerms = (
  digests: DigestShard[],
  terms: string[],
  filters: SearchFilters,
): DigestHit[] => {
  if (digests.length === 0 || terms.length === 0) return [];
  const candidates = digests.map((digest) => {
    const eligible = eligibleAddressMap(digest, filters);
    const vocabulary = new Map(digest.vocabulary);
    const matches = new Map<string, number[]>();
    for (const term of terms) {
      const indices = (vocabulary.get(term) ?? []).filter((index) => eligible.has(index));
      if (indices.length > 0) matches.set(term, indices);
    }
    return { digest, eligible, matches };
  });
  const documentFrequency = new Map<string, number>();
  for (const candidate of candidates) {
    for (const term of candidate.matches.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const hits: DigestHit[] = [];
  for (const candidate of candidates) {
    if (candidate.matches.size === 0) continue;
    const indices = new Set<number>();
    let score = 0;
    for (const [term, termIndices] of candidate.matches) {
      for (const index of termIndices) indices.add(index);
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log((candidates.length - df + 0.5) / (df + 0.5) + 1);
      score += idf * (1 + Math.log(termIndices.length));
    }
    hits.push(toDigestHit(candidate.digest, score, [...indices].sort((a, b) => a - b), candidate.eligible));
  }
  return hits;
};

const scoreDigestRegex = (
  digests: DigestShard[],
  regex: RegExp,
  filters: SearchFilters,
): DigestHit[] => {
  const hits: DigestHit[] = [];
  for (const digest of digests) {
    const eligible = eligibleAddressMap(digest, filters);
    const indices = new Set<number>();
    let matchedTerms = 0;
    for (const [term, addresses] of digest.vocabulary) {
      if (!regex.test(term)) continue;
      matchedTerms += 1;
      for (const index of addresses) {
        if (eligible.has(index)) indices.add(index);
      }
    }
    if (indices.size > 0) {
      hits.push(toDigestHit(digest, matchedTerms, [...indices].sort((a, b) => a - b), eligible));
    }
  }
  return hits;
};

const toDigestHit = (
  digest: DigestShard,
  score: number,
  indices: number[],
  eligible: Map<number, DigestEntryAddress>,
): DigestHit => {
  const first = indices[0] ?? 0;
  const last = indices[indices.length - 1] ?? first;
  const entryIds = indices
    .map((index) => eligible.get(index)?.[1] ?? null)
    .filter((entryId): entryId is string => entryId !== null);
  return {
    sessionId: digest.sessionId,
    sessionFile: digest.file,
    cwd: digest.cwd,
    lastTs: digest.lastTs,
    sessionMtime: digest.mtime,
    score,
    tier: "cold",
    matchedEntries: indices.length,
    entryRange: { first, last },
    entryIds: entryIds.slice(0, DIGEST_HIT_ENTRY_IDS_LIMIT),
    entryIdsTruncated: entryIds.length > DIGEST_HIT_ENTRY_IDS_LIMIT,
  };
};

const sortDigestHits = (hits: DigestHit[]): void => {
  hits.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.sessionMtime !== left.sessionMtime) return right.sessionMtime - left.sessionMtime;
    return compareLexical(left.sessionFile, right.sessionFile);
  });
};

/** Search hot entry shards and complete cold lexical vocabularies. */
export const searchMemoryIndex = (
  shards: Shard[],
  digests: DigestShard[],
  query: SearchQuery,
): SearchResult => {
  const filters: SearchFilters = query.filters ?? {};
  const plan = planMemoryQuery(query.query);
  const limit = query.limit ?? 50;
  let located: LocatedEntry[];
  let digestHits: DigestHit[] = [];
  const hasQuery = plan.kind !== "browse";

  if (plan.kind === "browse") {
    located = collectRecent(shards, filters);
  } else if (plan.kind === "regex") {
    located = collectRegexMatches(shards, plan.regex, filters);
    digestHits = scoreDigestRegex(digests, plan.regex, filters);
    sortLocated(located);
  } else {
    located = collectTermMatches(shards, plan.terms, filters);
    digestHits = scoreDigestTerms(digests, plan.terms, filters);
  }

  located = located.slice(0, limit);
  sortDigestHits(digestHits);
  digestHits = digestHits.slice(0, limit);
  return groupIntoResults(shards, located, digestHits, hasQuery, limit);
};

/** Search entry shards only, retaining the original API. */
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
        entryRange: { first: currentStart, last: lastIndex },
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
  if (rightValue.sessionMtime !== leftValue.sessionMtime) return rightValue.sessionMtime - leftValue.sessionMtime;
  if (left.kind !== right.kind) return left.kind === "entry" ? -1 : 1;
  if (left.kind === "entry" && right.kind === "entry") {
    const leftIndex = left.segment.entries[0]?.entry.index ?? 0;
    const rightIndex = right.segment.entries[0]?.entry.index ?? 0;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return compareLexical(left.segment.sessionFile, right.segment.sessionFile);
  }
  if (left.kind === "digest" && right.kind === "digest") {
    return compareLexical(left.digest.sessionFile, right.digest.sessionFile);
  }
  return 0;
};

/** Render deterministic entry segments and cold session pointers. */
export const formatSearchResult = (
  result: SearchResult,
  query: string | undefined,
  coverage?: MemoryCoverage,
): string => {
  if (result.items.length === 0) {
    if (!query) return "No entries in scope.";
    if (coverage && !coverage.complete) {
      return `No indexed matches for "${query}"; coverage is incomplete (${coverage.indexedSessions}/${coverage.eligibleSessions} sessions indexed, ${coverage.staleSessions} stale).`;
    }
    return `No matches for "${query}".`;
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
  return `> session ${hit.sessionId} (cold, ${hit.cwd}, ${timestamp}) matched ${hit.matchedEntries} lexical entr${hit.matchedEntries === 1 ? "y" : "ies"} in #${hit.entryRange.first}-#${hit.entryRange.last} — re-run with scope "session:${hit.sessionId}" and entryRange {"first":${hit.entryRange.first},"last":${hit.entryRange.last}} to hydrate from source.`;
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
