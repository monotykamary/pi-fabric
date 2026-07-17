import type { NormalizedEntry } from "./normalize.js";
import type { Shard } from "./index.js";
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
}

export interface SearchResult {
  matchedCount: number;
  segmentCount: number;
  segments: SearchSegment[];
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

const matchesFilters = (
  entry: NormalizedEntry,
  filters: SearchFilters,
): boolean => {
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

const collectTermMatches = (shards: Shard[], query: string, filters: SearchFilters): LocatedEntry[] => {
  const terms = query
    .split(/\s+/)
    .map((term) => term.toLowerCase())
    .filter((term) => term.length > 0);
  const scored: ScoredEntry[] = bm25Score(shards, terms, filters);
  return scored.map((item) => ({
    entry: item.entry,
    matched: true,
    sessionMtime: item.sessionMtime,
    score: item.score,
  }));
};

const collectRecent = (shards: Shard[], filters: SearchFilters): LocatedEntry[] => {
  const recent = recentEntries(shards, filters, 25);
  return recent.map((item) => ({
    entry: item.entry,
    matched: true,
    sessionMtime: item.sessionMtime,
    score: 0,
  }));
};

/**
 * Run a query over loaded shards. A query that compiles as a regex is applied
 * directly; otherwise it is split into multiword OR terms ranked by BM25. The
 * returned segments are conversation turns (a segment begins at a
 * user / bashExecution / compaction entry and runs to the next one). Matched
 * entries are marked with `>`; the other entries in the same segment are
 * included as context. Segments are computed structurally from typed entry
 * roles — never by regex over rendered text.
 */
export const searchShards = (shards: Shard[], query: SearchQuery): SearchResult => {
  const filters: SearchFilters = query.filters ?? {};
  const rawQuery = query.query?.trim();
  const limit = query.limit ?? 50;

  let located: LocatedEntry[];
  let hasQuery: boolean;
  if (!rawQuery) {
    located = collectRecent(shards, filters);
    hasQuery = false;
  } else if (looksLikeRegex(rawQuery)) {
    const regex = tryCompileRegex(rawQuery)!;
    located = collectRegexMatches(shards, regex, filters);
    sortLocated(located);
    located = located.slice(0, limit);
    hasQuery = true;
  } else {
    located = collectTermMatches(shards, rawQuery, filters);
    located = located.slice(0, limit);
    hasQuery = true;
  }

  return groupIntoSegments(shards, located, hasQuery);
};

const groupIntoSegments = (
  shards: Shard[],
  located: LocatedEntry[],
  hasQuery: boolean,
): SearchResult => {
  if (located.length === 0) {
    return { matchedCount: 0, segmentCount: 0, segments: [] };
  }

  const shardsByFile = new Map<string, Shard>();
  for (const shard of shards) shardsByFile.set(shard.sessionFile, shard);

  // Group matched entries by session, preserving score sort within a session.
  const matchedBySession = new Map<string, Set<number>>();
  for (const item of located) {
    const set = matchedBySession.get(item.entry.sessionFile) ?? new Set<number>();
    set.add(item.entry.index);
    matchedBySession.set(item.entry.sessionFile, set);
  }

  const segments: SearchSegment[] = [];
  for (const item of located) {
    const file = item.entry.sessionFile;
    if (!matchedBySession.has(file)) continue;
    matchedBySession.delete(file); // process each session once

    const shard = shardsByFile.get(file);
    if (!shard) continue;
    const matchedSet = new Set<number>(
      located.filter((entry) => entry.entry.sessionFile === file).map((entry) => entry.entry.index),
    );

    let current: NormalizedEntry[] = [];
    let currentStart = 0;
    const flush = (): void => {
      if (current.length === 0) return;
      const segmentEntries: SearchSegmentEntry[] = current.map((entry) => {
        const matched = matchedSet.has(entry.index);
        return { entry, matched, marker: hasQuery ? (matched ? ">" : " ") : ">" };
      });
      const matchedCount = segmentEntries.filter((entry) => entry.matched).length;
      if (hasQuery && matchedCount === 0) {
        current = [];
        return;
      }
      const lastIndex = current[current.length - 1]!.index;
      const range =
        lastIndex === currentStart ? `#${currentStart}` : `#${currentStart}-#${lastIndex}`;
      segments.push({
        sessionId: shard.sessionId,
        sessionFile: shard.sessionFile,
        sessionMtime: shard.mtime,
        range,
        entries: segmentEntries,
        matchedCount,
      });
      current = [];
    };

    for (const entry of shard.entries) {
      const role = entry.role;
      const startsSegment =
        current.length > 0 && role !== null && segmentStartRoles.has(role);
      if (startsSegment) flush();
      if (current.length === 0) currentStart = entry.index;
      current.push(entry);
    }
    flush();
  }

  segments.sort((left, right) => {
    if (right.sessionMtime !== left.sessionMtime) return right.sessionMtime - left.sessionMtime;
    const leftIndex = left.entries[0]?.entry.index ?? 0;
    const rightIndex = right.entries[0]?.entry.index ?? 0;
    return leftIndex - rightIndex;
  });

  const matchedCount = segments.reduce((sum, segment) => sum + segment.matchedCount, 0);
  return { matchedCount, segmentCount: segments.length, segments };
};

/** Render a {@link SearchResult} as deterministic text for the model context. */
export const formatSearchResult = (result: SearchResult, query: string | undefined): string => {
  if (result.segments.length === 0) {
    return query ? `No matches for "${query}".` : "No entries in scope.";
  }
  const header = query
    ? `${result.matchedCount} matches across ${result.segmentCount} segment${result.segmentCount === 1 ? "" : "s"} for "${query}":`
    : `${result.matchedCount} most recent entries:`;
  const body = result.segments.map(formatSegment).join("\n\n");
  return `${header}\n\n${body}`;
};

const formatSegment = (segment: SearchSegment): string => {
  const lines: string[] = [];
  const contextOnly = segment.matchedCount === 0;
  lines.push(
    contextOnly
      ? `--- ${segment.range} (context) ---`
      : `--- ${segment.range} (${segment.matchedCount}/${segment.entries.length} match) ---`,
  );
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
