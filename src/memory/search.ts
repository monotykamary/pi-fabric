import type { DigestEntryAddress } from "./digest.js";
import type { NormalizedEntry } from "./normalize.js";
import type { DigestShard, MemoryCoverage, Shard } from "./index.js";
import { bm25Score, recentEntries, type ScoredEntry } from "./index.js";
import { executeBoundedRegex, type RegexExecutionError } from "./regex.js";
import {
  compareLexical,
  planMemoryQuery,
  type MemoryQueryMode,
} from "./tokenize.js";

export const DEFAULT_REGEX_MAX_PATTERN_BYTES = 1_024;
export const DEFAULT_REGEX_MAX_HAYSTACK_TERMS = 20_000;
export const DEFAULT_REGEX_MAX_HAYSTACK_BYTES = 2 * 1024 * 1024;
export const DEFAULT_REGEX_TIMEOUT_MS = 250;

export interface SearchQuery {
  query?: string;
  queryMode?: MemoryQueryMode;
  filters?: {
    role?: string;
    tool?: string;
    since?: number;
    until?: number;
  };
  limit?: number;
  regexLimits?: {
    maxPatternBytes: number;
    maxHaystackTerms: number;
    maxHaystackBytes: number;
    timeoutMs: number;
  };
}

interface SearchSegmentEntry {
  entry: NormalizedEntry;
  matched: boolean;
  marker: ">" | " ";
}

interface ExactEntryAddress {
  index: number;
  entryId: string | null;
  operationAddress: string | null;
}

interface SearchSegment {
  sessionId: string;
  sessionFile: string;
  sourceHash: string;
  sessionMtime: number;
  range: string;
  entryRange: { first: number; last: number };
  entries: SearchSegmentEntry[];
  exactMatches: ExactEntryAddress[];
  matchedCount: number;
  score: number;
  tier: "hot" | "cold";
}

interface DigestHit {
  sessionId: string;
  sessionFile: string;
  sourceHash: string;
  cwd: string;
  lastTs: number | null;
  sessionMtime: number;
  score: number;
  tier: "cold";
  matchedTerms: number;
}

export type SearchItem =
  | { kind: "entry"; segment: SearchSegment }
  | { kind: "digest"; digest: DigestHit };

interface QueryCoverage {
  complete: boolean;
  reasons: string[];
  error?: RegexExecutionError;
}

export interface SearchResult {
  matchedCount: number;
  segmentCount: number;
  segments: SearchSegment[];
  digestHits: DigestHit[];
  items: SearchItem[];
  queryCoverage: QueryCoverage;
}

interface SearchFilters {
  role?: string;
  tool?: string;
  since?: number;
  until?: number;
}

const segmentStartRoles = new Set(["user", "bashExecution", "compaction"]);

const matchesFilters = (entry: NormalizedEntry, filters: SearchFilters): boolean => {
  if (filters.role !== undefined && entry.role !== filters.role) return false;
  if (filters.tool !== undefined && entry.toolName !== filters.tool) return false;
  if (filters.since !== undefined && entry.timestamp !== null && entry.timestamp < filters.since) return false;
  if (filters.until !== undefined && entry.timestamp !== null && entry.timestamp > filters.until) return false;
  return true;
};

const addressMatchesFilters = (address: DigestEntryAddress, filters: SearchFilters): boolean => {
  if (filters.role !== undefined && address[3] !== filters.role) return false;
  if (filters.tool !== undefined && address[4] !== filters.tool) return false;
  if (filters.since !== undefined && address[5] !== null && address[5] < filters.since) return false;
  if (filters.until !== undefined && address[5] !== null && address[5] > filters.until) return false;
  return true;
};

const hasFilters = (filters: SearchFilters): boolean => Object.keys(filters).length > 0;

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

const digestCanMatchFilters = (digest: DigestShard, filters: SearchFilters): boolean =>
  !hasFilters(filters) || digest.addresses.some((address) => addressMatchesFilters(address, filters));

const toDigestHit = (digest: DigestShard, score: number, matchedTerms: number): DigestHit => ({
  sessionId: digest.sessionId,
  sessionFile: digest.file,
  sourceHash: digest.sourceHash,
  cwd: digest.cwd,
  lastTs: digest.lastTs,
  sessionMtime: digest.mtime,
  score,
  tier: "cold",
  matchedTerms,
});

const scoreDigestTerms = (
  digests: DigestShard[],
  terms: string[],
  filters: SearchFilters,
): DigestHit[] => {
  if (digests.length === 0 || terms.length === 0) return [];
  const candidates = digests.map((digest) => {
    if (!digestCanMatchFilters(digest, filters)) return { digest, matches: [] as string[] };
    const vocabulary = new Set(digest.vocabulary);
    return { digest, matches: terms.filter((term) => vocabulary.has(term)) };
  });
  const documentFrequency = new Map<string, number>();
  for (const candidate of candidates) {
    for (const term of candidate.matches) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  return candidates.flatMap((candidate) => {
    if (candidate.matches.length === 0) return [];
    const score = candidate.matches.reduce((total, term) => {
      const df = documentFrequency.get(term) ?? 0;
      return total + Math.log((candidates.length - df + 0.5) / (df + 0.5) + 1);
    }, 0);
    return [toDigestHit(candidate.digest, score, candidate.matches.length)];
  });
};

interface RegexHotTarget {
  kind: "hot";
  shard: Shard;
  entry: NormalizedEntry;
}

interface RegexColdTarget {
  kind: "cold";
  digest: DigestShard;
}

type RegexTarget = RegexHotTarget | RegexColdTarget;

const collectRegexTargets = (
  shards: Shard[],
  digests: DigestShard[],
  filters: SearchFilters,
  maxTerms: number,
  maxBytes: number,
): { haystacks: string[]; targets: RegexTarget[]; complete: boolean; reasons: string[] } => {
  const haystacks: string[] = [];
  const targets: RegexTarget[] = [];
  let bytes = 0;
  let complete = true;
  const reasons = new Set<string>();
  const append = (haystack: string, target: RegexTarget): boolean => {
    const nextBytes = Buffer.byteLength(haystack, "utf8");
    if (haystacks.length >= maxTerms) {
      complete = false;
      reasons.add("regex_max_haystack_terms");
      return false;
    }
    if (bytes + nextBytes > maxBytes) {
      complete = false;
      reasons.add("regex_max_haystack_bytes");
      return false;
    }
    haystacks.push(haystack);
    targets.push(target);
    bytes += nextBytes;
    return true;
  };

  outer: for (const shard of shards) {
    for (const entry of shard.entries) {
      if (!matchesFilters(entry, filters)) continue;
      if (!append(entry.text, { kind: "hot", shard, entry })) break outer;
    }
  }
  if (complete) {
    outer: for (const digest of digests) {
      if (!digestCanMatchFilters(digest, filters)) continue;
      for (const term of digest.vocabulary) {
        if (!append(term, { kind: "cold", digest })) break outer;
      }
    }
  }
  return { haystacks, targets, complete, reasons: [...reasons].sort(compareLexical) };
};

const searchRegex = async (
  shards: Shard[],
  digests: DigestShard[],
  pattern: string,
  filters: SearchFilters,
  query: SearchQuery,
): Promise<{ located: LocatedEntry[]; digestHits: DigestHit[]; coverage: QueryCoverage }> => {
  const limits = query.regexLimits ?? {
    maxPatternBytes: DEFAULT_REGEX_MAX_PATTERN_BYTES,
    maxHaystackTerms: DEFAULT_REGEX_MAX_HAYSTACK_TERMS,
    maxHaystackBytes: DEFAULT_REGEX_MAX_HAYSTACK_BYTES,
    timeoutMs: DEFAULT_REGEX_TIMEOUT_MS,
  };
  const collected = collectRegexTargets(
    shards,
    digests,
    filters,
    limits.maxHaystackTerms,
    limits.maxHaystackBytes,
  );
  const execution = await executeBoundedRegex(pattern, collected.haystacks, {
    maxPatternBytes: limits.maxPatternBytes,
    timeoutMs: limits.timeoutMs,
  });
  if (!execution.complete) {
    return {
      located: [],
      digestHits: [],
      coverage: { complete: false, reasons: [execution.error.code], error: execution.error },
    };
  }

  const located: LocatedEntry[] = [];
  const coldMatches = new Map<DigestShard, number>();
  for (const index of execution.matched) {
    const target = collected.targets[index];
    if (!target) continue;
    if (target.kind === "hot") {
      located.push({
        entry: target.entry,
        matched: true,
        sessionMtime: target.shard.mtime,
        score: 1,
      });
    } else {
      coldMatches.set(target.digest, (coldMatches.get(target.digest) ?? 0) + 1);
    }
  }
  const reasons = new Set(collected.reasons);
  if (coldMatches.size > 0 && hasFilters(filters)) {
    reasons.add("cold_structural_filter_requires_hydration");
  }
  return {
    located,
    digestHits: [...coldMatches].map(([digest, count]) => toDigestHit(digest, count, count)),
    coverage: {
      complete: collected.complete && reasons.size === 0,
      reasons: [...reasons].sort(compareLexical),
    },
  };
};

const sortDigestHits = (hits: DigestHit[]): void => {
  hits.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.sessionMtime !== left.sessionMtime) return right.sessionMtime - left.sessionMtime;
    return compareLexical(left.sessionFile, right.sessionFile);
  });
};

export const searchMemoryIndex = async (
  shards: Shard[],
  digests: DigestShard[],
  query: SearchQuery,
): Promise<SearchResult> => {
  const filters: SearchFilters = query.filters ?? {};
  const plan = planMemoryQuery(query.query, query.queryMode ?? "literal");
  const limit = query.limit ?? 50;
  let located: LocatedEntry[];
  let digestHits: DigestHit[] = [];
  let queryCoverage: QueryCoverage = { complete: true, reasons: [] };
  const hasQuery = plan.kind !== "browse";

  if (plan.kind === "browse") {
    located = collectRecent(shards, filters);
  } else if (plan.kind === "regex") {
    const regexResult = await searchRegex(shards, digests, plan.pattern, filters, query);
    located = regexResult.located;
    digestHits = regexResult.digestHits;
    queryCoverage = regexResult.coverage;
    sortLocated(located);
  } else {
    located = collectTermMatches(shards, plan.terms, filters);
    digestHits = scoreDigestTerms(digests, plan.terms, filters);
    if (digestHits.length > 0 && hasFilters(filters)) {
      queryCoverage = {
        complete: false,
        reasons: ["cold_structural_filter_requires_hydration"],
      };
    }
  }

  located = located.slice(0, limit);
  sortDigestHits(digestHits);
  digestHits = digestHits.slice(0, limit);
  return groupIntoResults(shards, located, digestHits, hasQuery, limit, queryCoverage);
};

export const searchShards = (shards: Shard[], query: SearchQuery): Promise<SearchResult> =>
  searchMemoryIndex(shards, [], query);

const groupIntoResults = (
  shards: Shard[],
  located: LocatedEntry[],
  digestHits: DigestHit[],
  hasQuery: boolean,
  limit: number,
  queryCoverage: QueryCoverage,
): SearchResult => {
  if (located.length === 0 && digestHits.length === 0) {
    return {
      matchedCount: 0,
      segmentCount: 0,
      segments: [],
      digestHits: [],
      items: [],
      queryCoverage,
    };
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
        sourceHash: shard.sourceHash,
        sessionMtime: shard.mtime,
        range,
        entryRange: { first: currentStart, last: lastIndex },
        entries,
        exactMatches: matchedEntries.map(({ entry }) => ({
          index: entry.index,
          entryId: entry.entryId,
          operationAddress: entry.operationAddress ?? null,
        })),
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
    queryCoverage,
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

export const formatSearchResult = (
  result: SearchResult,
  query: string | undefined,
  coverage?: MemoryCoverage,
): string => {
  if (result.items.length === 0) {
    if (!query) return "No entries in scope.";
    if (coverage && !coverage.complete) {
      const reasons = coverage.reasons.length > 0 ? `; reasons: ${coverage.reasons.join(", ")}` : "";
      return `No indexed matches for "${query}"; coverage is incomplete (${coverage.indexedSessions}/${coverage.eligibleSessions} sessions indexed${reasons}).`;
    }
    if (!result.queryCoverage.complete) {
      const reasons = result.queryCoverage.reasons.join(", ");
      return `No indexed matches for "${query}"; query coverage is incomplete (${reasons}).`;
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
  return `> session ${hit.sessionId} (cold, ${hit.cwd}, ${timestamp}) has ${hit.matchedTerms} matching lexical term${hit.matchedTerms === 1 ? "" : "s"} — hydrate exact file ${JSON.stringify(hit.sessionFile)} with expectedSourceHash ${JSON.stringify(hit.sourceHash)}.`;
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
