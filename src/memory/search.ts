import type { DigestEntryAddress } from "./digest.js";
import type { MemoryBranches } from "./lineage.js";
import type { NormalizedEntry } from "./normalize.js";
import type { DigestShard, MemoryCoverage, SearchFilters, Shard } from "./index.js";
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
const DEFAULT_SEARCH_MAX_CANDIDATE_ENTRIES = 50_000;
const DEFAULT_SEARCH_MAX_CANDIDATE_DIGESTS = 10_000;
const DEFAULT_SEARCH_MAX_CANDIDATE_ITEMS = 10_000;

export interface SearchQuery {
  query?: string;
  queryMode?: MemoryQueryMode;
  filters?: SearchFilters;
  limit?: number;
  candidateLimits?: {
    maxEntries: number;
    maxDigests: number;
    maxItems: number;
  };
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
  branches: MemoryBranches;
  lineageFingerprint: string;
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
  branches: MemoryBranches;
  lineageFingerprint: string;
  cwd: string;
  lastTs: number | null;
  sessionMtime: number;
  score: number;
  tier: "cold";
  matchedTerms: number;
  matchedStructuralEntries: number;
}

export type SearchItem =
  | { kind: "entry"; segment: SearchSegment }
  | { kind: "digest"; digest: DigestHit };

interface QueryCoverage {
  complete: boolean;
  reasons: string[];
  error?: RegexExecutionError;
}

type MemoryMatchMode = "browse" | "lexical" | "regex" | "structural" | "combined";

export interface SearchResult {
  matchMode: MemoryMatchMode;
  matchedCount: number;
  totalMatches: number;
  totalItems: number;
  segmentCount: number;
  segments: SearchSegment[];
  digestHits: DigestHit[];
  items: SearchItem[];
  queryCoverage: QueryCoverage;
}

const segmentStartRoles = new Set(["user", "bashExecution", "compaction"]);

const matchesFilters = (entry: NormalizedEntry, filters: SearchFilters): boolean => {
  if (filters.role !== undefined && entry.role !== filters.role) return false;
  if (filters.tool !== undefined && entry.toolName !== filters.tool) return false;
  if (filters.ref !== undefined && entry.ref !== filters.ref) return false;
  if (filters.provider !== undefined && entry.provider !== filters.provider) return false;
  if (filters.action !== undefined && entry.action !== filters.action) return false;
  if (filters.outcome !== undefined && entry.outcome !== filters.outcome) return false;
  if (filters.since !== undefined && entry.timestamp !== null && entry.timestamp < filters.since) return false;
  if (filters.until !== undefined && entry.timestamp !== null && entry.timestamp > filters.until) return false;
  return true;
};

const addressMatchesFilters = (address: DigestEntryAddress, filters: SearchFilters): boolean => {
  if (filters.role !== undefined && address[3] !== filters.role) return false;
  if (filters.tool !== undefined && address[4] !== filters.tool) return false;
  if (filters.ref !== undefined && address[6] !== filters.ref) return false;
  if (filters.provider !== undefined && address[7] !== filters.provider) return false;
  if (filters.action !== undefined && address[8] !== filters.action) return false;
  if (filters.outcome !== undefined && address[9] !== filters.outcome) return false;
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

const filteredEntryCount = (shards: Shard[], filters: SearchFilters): number => {
  let count = 0;
  for (const shard of shards) {
    for (const entry of shard.entries) if (matchesFilters(entry, filters)) count += 1;
  }
  return count;
};

const collectTermMatches = (
  shards: Shard[],
  terms: string[],
  filters: SearchFilters,
  maxEntries: number,
): LocatedEntry[] => {
  const scored: ScoredEntry[] = bm25Score(shards, terms, filters, maxEntries);
  return scored.map((item) => ({
    entry: item.entry,
    matched: true,
    sessionMtime: item.sessionMtime,
    score: item.score,
  }));
};

const collectRecent = (
  shards: Shard[],
  filters: SearchFilters,
  maxEntries: number,
  score = 0,
): LocatedEntry[] =>
  recentEntries(shards, filters, maxEntries).map((item) => ({
    entry: item.entry,
    matched: true,
    sessionMtime: item.sessionMtime,
    score,
  }));

const digestStructuralMatchCount = (digest: DigestShard, filters: SearchFilters): number =>
  hasFilters(filters)
    ? digest.addresses.filter((address) => addressMatchesFilters(address, filters)).length
    : 0;

const digestCanMatchFilters = (digest: DigestShard, filters: SearchFilters): boolean =>
  !hasFilters(filters) || digestStructuralMatchCount(digest, filters) > 0;

const toDigestHit = (
  digest: DigestShard,
  score: number,
  matchedTerms: number,
  matchedStructuralEntries = 0,
): DigestHit => ({
  sessionId: digest.sessionId,
  sessionFile: digest.file,
  sourceHash: digest.sourceHash,
  branches: digest.branches,
  lineageFingerprint: digest.lineageFingerprint,
  cwd: digest.cwd,
  lastTs: digest.lastTs,
  sessionMtime: digest.mtime,
  score,
  tier: "cold",
  matchedTerms,
  matchedStructuralEntries,
});

const scoreDigestTerms = (
  digests: DigestShard[],
  terms: string[],
  filters: SearchFilters,
  maxDigests: number,
): { hits: DigestHit[]; complete: boolean } => {
  if (digests.length === 0 || terms.length === 0) return { hits: [], complete: true };
  const candidates: Array<{ digest: DigestShard; matches: string[]; structuralMatches: number }> = [];
  let matchingDigests = 0;
  for (const digest of digests) {
    if (!digestCanMatchFilters(digest, filters)) continue;
    const vocabulary = new Set(digest.vocabulary);
    const matches = terms.filter((term) => vocabulary.has(term));
    if (matches.length === 0) continue;
    matchingDigests += 1;
    if (candidates.length < maxDigests) {
      candidates.push({
        digest,
        matches,
        structuralMatches: digestStructuralMatchCount(digest, filters),
      });
    }
  }
  const documentFrequency = new Map<string, number>();
  for (const candidate of candidates) {
    for (const term of candidate.matches) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const hits = candidates.map((candidate) => {
    const score = candidate.matches.reduce((total, term) => {
      const df = documentFrequency.get(term) ?? 0;
      return total + Math.log((candidates.length - df + 0.5) / (df + 0.5) + 1);
    }, 0);
    return toDigestHit(
      candidate.digest,
      score,
      candidate.matches.length,
      candidate.structuralMatches,
    );
  });
  return { hits, complete: matchingDigests <= maxDigests };
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
    digestHits: [...coldMatches].map(([digest, count]) =>
      toDigestHit(digest, count, count, digestStructuralMatchCount(digest, filters))),
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
  const limits = query.candidateLimits ?? {
    maxEntries: DEFAULT_SEARCH_MAX_CANDIDATE_ENTRIES,
    maxDigests: DEFAULT_SEARCH_MAX_CANDIDATE_DIGESTS,
    maxItems: DEFAULT_SEARCH_MAX_CANDIDATE_ITEMS,
  };
  const maxEntries = Math.max(1, Math.floor(limits.maxEntries));
  const maxDigests = Math.max(1, Math.floor(limits.maxDigests));
  const maxItems = Math.max(1, Math.floor(limits.maxItems));
  let located: LocatedEntry[];
  let digestHits: DigestHit[] = [];
  let queryCoverage: QueryCoverage = { complete: true, reasons: [] };
  const structurallyFiltered = hasFilters(filters);
  const matchMode: MemoryMatchMode = plan.kind === "browse"
    ? structurallyFiltered ? "structural" : "browse"
    : structurallyFiltered ? "combined" : plan.kind === "regex" ? "regex" : "lexical";
  const markOnlyMatches = plan.kind !== "browse" || structurallyFiltered;
  const coverageReasons = new Set<string>();

  if (plan.kind === "browse") {
    const eligibleEntries = filteredEntryCount(shards, filters);
    located = collectRecent(shards, filters, maxEntries, structurallyFiltered ? 1 : 0);
    if (eligibleEntries > maxEntries) coverageReasons.add("candidate_entry_budget");
    let eligibleDigests = 0;
    for (const digest of digests) {
      if (!digestCanMatchFilters(digest, filters)) continue;
      eligibleDigests += 1;
      if (digestHits.length < maxDigests) {
        const structuralMatches = digestStructuralMatchCount(digest, filters);
        digestHits.push(toDigestHit(
          digest,
          structurallyFiltered ? 1 : 0,
          0,
          structuralMatches,
        ));
      }
    }
    if (eligibleDigests > maxDigests) coverageReasons.add("candidate_digest_budget");
  } else if (plan.kind === "regex") {
    const regexResult = await searchRegex(shards, digests, plan.pattern, filters, query);
    located = regexResult.located.slice(0, maxEntries);
    digestHits = regexResult.digestHits.slice(0, maxDigests);
    queryCoverage = regexResult.coverage;
    if (regexResult.located.length > maxEntries) coverageReasons.add("candidate_entry_budget");
    if (regexResult.digestHits.length > maxDigests) coverageReasons.add("candidate_digest_budget");
    sortLocated(located);
  } else {
    const eligibleEntries = filteredEntryCount(shards, filters);
    located = collectTermMatches(shards, plan.terms, filters, maxEntries);
    if (eligibleEntries > maxEntries) coverageReasons.add("candidate_entry_budget");
    const digestResult = scoreDigestTerms(digests, plan.terms, filters, maxDigests);
    digestHits = digestResult.hits;
    if (!digestResult.complete) coverageReasons.add("candidate_digest_budget");
    if (digestHits.length > 0 && hasFilters(filters)) {
      coverageReasons.add("cold_structural_filter_requires_hydration");
    }
  }

  sortDigestHits(digestHits);
  for (const reason of queryCoverage.reasons) coverageReasons.add(reason);
  queryCoverage = {
    ...queryCoverage,
    complete: queryCoverage.complete && coverageReasons.size === 0,
    reasons: [...coverageReasons].sort(compareLexical),
  };
  return groupIntoResults(
    shards,
    located,
    digestHits,
    markOnlyMatches,
    matchMode,
    maxItems,
    queryCoverage,
  );
};

export const searchShards = (shards: Shard[], query: SearchQuery): Promise<SearchResult> =>
  searchMemoryIndex(shards, [], query);

const groupIntoResults = (
  shards: Shard[],
  located: LocatedEntry[],
  digestHits: DigestHit[],
  markOnlyMatches: boolean,
  matchMode: MemoryMatchMode,
  maxItems: number,
  queryCoverage: QueryCoverage,
): SearchResult => {
  if (located.length === 0 && digestHits.length === 0) {
    return {
      matchMode,
      matchedCount: 0,
      totalMatches: 0,
      totalItems: 0,
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
        return { entry, matched, marker: markOnlyMatches ? (matched ? ">" : " ") : ">" };
      });
      const matchedEntries = entries.filter((entry) => entry.matched);
      if (markOnlyMatches && matchedEntries.length === 0) {
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
        branches: shard.branches,
        lineageFingerprint: shard.lineageFingerprint,
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
  const candidateItemsExceeded = items.length > maxItems;
  const limitedItems = items.slice(0, maxItems);
  const limitedSegments = limitedItems
    .filter((item): item is { kind: "entry"; segment: SearchSegment } => item.kind === "entry")
    .map((item) => item.segment);
  const limitedDigests = limitedItems
    .filter((item): item is { kind: "digest"; digest: DigestHit } => item.kind === "digest")
    .map((item) => item.digest);
  const matchedCount = limitedSegments.reduce((sum, segment) => sum + segment.matchedCount, 0)
    + limitedDigests.length;
  const finalCoverage = candidateItemsExceeded
    ? {
        ...queryCoverage,
        complete: false,
        reasons: [...new Set([...queryCoverage.reasons, "candidate_item_budget"])].sort(compareLexical),
      }
    : queryCoverage;
  return {
    matchMode,
    matchedCount,
    totalMatches: matchedCount,
    totalItems: limitedItems.length,
    segmentCount: limitedSegments.length,
    segments: limitedSegments,
    digestHits: limitedDigests,
    items: limitedItems,
    queryCoverage: finalCoverage,
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

const structuralFilterLabel = (filters: SearchFilters): string => {
  const ordered: Array<[keyof SearchFilters, unknown]> = [
    ["ref", filters.ref],
    ["provider", filters.provider],
    ["action", filters.action],
    ["outcome", filters.outcome],
    ["role", filters.role],
    ["tool", filters.tool],
    ["since", filters.since],
    ["until", filters.until],
  ];
  return ordered
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(", ");
};

export const formatSearchResult = (
  result: SearchResult,
  query: string | undefined,
  coverage?: MemoryCoverage,
  filters: SearchFilters = {},
): string => {
  const filterLabel = structuralFilterLabel(filters);
  if (result.items.length === 0) {
    if (result.totalItems > 0) return "No results on this page.";
    if (result.matchMode === "structural") {
      if (coverage && !coverage.complete) {
        const reasons = coverage.reasons.length > 0 ? `; reasons: ${coverage.reasons.join(", ")}` : "";
        return `No indexed invocations selected by exact structural filters (${filterLabel}); coverage is incomplete (${coverage.indexedSessions}/${coverage.eligibleSessions} sessions indexed${reasons}).`;
      }
      return `No invocations selected by exact structural filters (${filterLabel}).`;
    }
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
  const header = result.matchMode === "structural"
    ? `${result.matchedCount} structural result item${result.matchedCount === 1 ? "" : "s"} across ${result.segmentCount} segment${result.segmentCount === 1 ? "" : "s"}${coldSuffix} selected by exact filters (${filterLabel}):`
    : result.matchMode === "combined"
      ? `${result.matchedCount} lexical matches across ${result.segmentCount} segment${result.segmentCount === 1 ? "" : "s"}${coldSuffix} for "${query}" within exact structural filters (${filterLabel}):`
      : query
        ? `${result.matchedCount} matches across ${result.segmentCount} segment${result.segmentCount === 1 ? "" : "s"}${coldSuffix} for "${query}":`
        : `${result.matchedCount} most recent entries:`;
  const body = result.items.map((item) =>
    item.kind === "entry" ? formatSegment(item.segment) : formatDigestHit(item.digest, result.matchMode),
  ).join("\n\n");
  return `${header}\n\n${body}`;
};

const formatDigestHit = (hit: DigestHit, matchMode: MemoryMatchMode): string => {
  const timestamp = hit.lastTs === null ? "unknown time" : new Date(hit.lastTs).toISOString();
  const match = matchMode === "browse"
    ? "is available as a cold session pointer"
    : matchMode === "structural"
      ? `has ${hit.matchedStructuralEntries} retained entries selected by exact structural fields`
      : matchMode === "combined"
        ? `has ${hit.matchedTerms} matching lexical term${hit.matchedTerms === 1 ? "" : "s"} and ${hit.matchedStructuralEntries} independently matching structural entries; hydrate to establish entry-level co-location`
        : `has ${hit.matchedTerms} matching lexical term${hit.matchedTerms === 1 ? "" : "s"}`;
  return `> session ${hit.sessionId} (cold, ${hit.cwd}, ${timestamp}, branches=${hit.branches}) ${match} — hydrate exact file ${JSON.stringify(hit.sessionFile)} with branches ${JSON.stringify(hit.branches)}, expectedSourceHash ${JSON.stringify(hit.sourceHash)}, and expectedLineageFingerprint ${JSON.stringify(hit.lineageFingerprint)}.`;
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
