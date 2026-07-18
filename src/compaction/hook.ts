import type {
  CompactionResult,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeTreeEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { clipUtf8 } from "./bounds.js";
import { NO_BUILTIN_ENRICHERS, runEnrichers, type CompactionEnricher } from "./enrichers.js";
import { compileFabricBranchSummary } from "./branch-summary.js";
import {
  decodeCompactionInstructions,
  type CompactionInstructionDecodeError,
  type CompactionInstructionPolicy,
} from "./instructions.js";
import { normalizeEntries } from "./normalize.js";
import {
  projectWithMetadata,
  type ProjectionOmittedCounts,
  type Sections,
} from "./projections.js";
import { renderSummary } from "./render.js";

type CompactionEngine = "pi" | "fabric";

interface MessageEntry {
  entry: SessionEntry;
  branchIndex: number;
  message: {
    role?: unknown;
    content?: unknown;
    toolCallId?: unknown;
  };
}

const isMessageEntry = (entry: SessionEntry): entry is Extract<SessionEntry, { type: "message" }> =>
  entry.type === "message";

const isHiddenEmptyCustom = (message: unknown): boolean => {
  if (!message || typeof message !== "object") return false;
  const candidate = message as { role?: unknown; display?: unknown; content?: unknown };
  if (candidate.role !== "custom" || candidate.display !== false) return false;
  const content = candidate.content;
  return content === "" || (Array.isArray(content) && content.length === 0);
};

const toolCallIdsOf = (message: { content?: unknown }): string[] => {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object" || !("type" in part) || part.type !== "toolCall") continue;
    const id = (part as { id?: unknown }).id;
    if (typeof id === "string") ids.push(id);
  }
  return ids;
};

const findLastCompaction = (entries: SessionEntry[]): { index: number; firstKeptEntryId: string } | undefined => {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type === "compaction") {
      return { index, firstKeptEntryId: entry.firstKeptEntryId };
    }
  }
  return undefined;
};

const collectMessages = (entries: SessionEntry[], startIndex: number): MessageEntry[] => {
  const messages: MessageEntry[] = [];
  for (let index = Math.max(0, startIndex); index < entries.length; index++) {
    const entry = entries[index]!;
    if (!isMessageEntry(entry) || isHiddenEmptyCustom(entry.message)) continue;
    messages.push({
      entry,
      branchIndex: index,
      message: entry.message as MessageEntry["message"],
    });
  }
  return messages;
};

const collectLive = (entries: SessionEntry[]): MessageEntry[] => {
  const last = findLastCompaction(entries);
  if (!last) return collectMessages(entries, 0);
  if (last.firstKeptEntryId) {
    const keptIndex = entries.findIndex((entry) => entry.id === last.firstKeptEntryId);
    if (keptIndex >= 0) return collectMessages(entries, keptIndex);
  }
  return collectMessages(entries, last.index + 1);
};

const previousUserAtOrBefore = (live: MessageEntry[], branchIndex: number): number => {
  for (let index = live.length - 1; index >= 0; index--) {
    const item = live[index]!;
    if (item.branchIndex <= branchIndex && item.message.role === "user") return index;
  }
  return -1;
};

const lastUserIndex = (live: MessageEntry[]): number => {
  for (let index = live.length - 1; index >= 0; index--) {
    if (live[index]!.message.role === "user") return index;
  }
  return -1;
};

const callResultSpans = (entries: SessionEntry[]): Map<string, { first: number; last: number }> => {
  const spans = new Map<string, { first: number; last: number }>();
  const record = (id: string, index: number): void => {
    if (!id) return;
    const span = spans.get(id);
    if (span) {
      span.first = Math.min(span.first, index);
      span.last = Math.max(span.last, index);
    } else {
      spans.set(id, { first: index, last: index });
    }
  };
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (!isMessageEntry(entry)) continue;
    const message = entry.message as MessageEntry["message"];
    for (const id of toolCallIdsOf(message)) record(id, index);
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      record(message.toolCallId, index);
    }
  }
  return spans;
};

const closeCut = (
  branchEntries: SessionEntry[],
  live: MessageEntry[],
  candidateLiveIndex: number,
): number => {
  const spans = callResultSpans(branchEntries);
  let liveIndex = candidateLiveIndex;
  while (liveIndex > 0) {
    const boundaryIndex = live[liveIndex]!.branchIndex;
    let earliestCrossing = boundaryIndex;
    for (const span of spans.values()) {
      if (span.first < boundaryIndex && span.last >= boundaryIndex) {
        earliestCrossing = Math.min(earliestCrossing, span.first);
      }
    }
    if (earliestCrossing === boundaryIndex) return liveIndex;
    const closed = previousUserAtOrBefore(live, earliestCrossing);
    if (closed < 0 || closed >= liveIndex) return 0;
    liveIndex = closed;
  }
  return 0;
};

export type CutResult =
  | {
      ok: true;
      summarized: SessionEntry[];
      firstKeptEntryId: string;
      firstSummarizedEntryId: string;
      lastSummarizedEntryId: string;
      lastTimestamp: string;
    }
  | { ok: false; reason: "empty" };

const boundary = (summarized: SessionEntry[], firstKeptEntryId: string): CutResult => {
  if (summarized.length === 0) return { ok: false, reason: "empty" };
  const first = summarized[0]!;
  const last = summarized.at(-1)!;
  return {
    ok: true,
    summarized,
    firstKeptEntryId,
    firstSummarizedEntryId: first.id,
    lastSummarizedEntryId: last.id,
    lastTimestamp: last.timestamp,
  };
};

export const computeCut = (branchEntries: SessionEntry[]): CutResult => {
  const live = collectLive(branchEntries);
  if (live.length === 0) return { ok: false, reason: "empty" };

  const lastUser = lastUserIndex(live);
  if (lastUser <= 0) return boundary(live.map((item) => item.entry), "");
  const closed = closeCut(branchEntries, live, lastUser);
  if (closed <= 0) return boundary(live.map((item) => item.entry), "");

  return boundary(
    live.slice(0, closed).map((item) => item.entry),
    live[closed]!.entry.id,
  );
};

interface FabricCompactionDetailsV1 {
  compactor: "fabric";
  version: 1;
  sections: string[];
  summarizedEntryRange: { first: string; last: string };
  sourceEntryCount: number;
  firstKeptEntryId: string;
  timestamp: string;
}

interface EntryRange {
  first: string;
  last: string;
}

export interface FabricCompactionDetailsV2 {
  compactor: "fabric";
  version: 2;
  sections: string[];
  coverage: {
    cumulativeSourceRange: EntryRange;
    liveCutRange: EntryRange;
  };
  counts: {
    branchEntries: number;
    cumulativeSourceEntries: number;
    sourceEvents: number;
    liveCutEntries: number;
    priorFabricV1: number;
    priorFabricV2: number;
  };
  omittedCounts: ProjectionOmittedCounts & { preserve: number };
  instructionPolicy: CompactionInstructionPolicy;
  stableAddresses: {
    firstKeptEntryId: string;
    cumulativeSourceRange: EntryRange;
    recall: "session-entry-id-range";
  };
  timestamp: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isEntryRange = (value: unknown): boolean =>
  isRecord(value) && typeof value.first === "string" && typeof value.last === "string";

const isStringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isFabricV1Details = (value: Record<string, unknown>): boolean =>
  isStringArray(value.sections)
  && isEntryRange(value.summarizedEntryRange)
  && typeof value.sourceEntryCount === "number"
  && Number.isFinite(value.sourceEntryCount)
  && typeof value.firstKeptEntryId === "string"
  && typeof value.timestamp === "string";

const hasFiniteNumbers = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  keys.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]));

const isFabricV2Details = (value: Record<string, unknown>): boolean => {
  if (!isStringArray(value.sections) || !isRecord(value.coverage) || !isRecord(value.counts)) return false;
  if (!isRecord(value.omittedCounts) || !isRecord(value.instructionPolicy) || !isRecord(value.stableAddresses)) {
    return false;
  }
  const instructionModes = new Set(["none", "plain", "typed-v1", "malformed-typed-prefix"]);
  return isEntryRange(value.coverage.cumulativeSourceRange)
    && isEntryRange(value.coverage.liveCutRange)
    && hasFiniteNumbers(value.counts, [
      "branchEntries",
      "cumulativeSourceEntries",
      "sourceEvents",
      "liveCutEntries",
      "priorFabricV1",
      "priorFabricV2",
    ])
    && hasFiniteNumbers(value.omittedCounts, [
      "goal",
      "files",
      "outstanding",
      "earlierTurns",
      "transcript",
      "preserve",
    ])
    && (value.omittedCounts.activity === undefined
      || (typeof value.omittedCounts.activity === "number" && Number.isFinite(value.omittedCounts.activity)))
    && (value.omittedCounts.commits === undefined
      || (typeof value.omittedCounts.commits === "number" && Number.isFinite(value.omittedCounts.commits)))
    && typeof value.instructionPolicy.mode === "string"
    && instructionModes.has(value.instructionPolicy.mode)
    && typeof value.instructionPolicy.canonicalized === "boolean"
    && typeof value.instructionPolicy.truncated === "boolean"
    && hasFiniteNumbers(value.instructionPolicy, [
      "sourceBytes",
      "preserveCount",
      "omittedPreserveCount",
    ])
    && typeof value.stableAddresses.firstKeptEntryId === "string"
    && isEntryRange(value.stableAddresses.cumulativeSourceRange)
    && value.stableAddresses.recall === "session-entry-id-range"
    && typeof value.timestamp === "string";
};

export const fabricCompactionVersion = (details: unknown): 1 | 2 | undefined => {
  if (!isRecord(details) || details.compactor !== "fabric") return undefined;
  if (details.version === 1 && isFabricV1Details(details)) return 1;
  if (details.version === 2 && isFabricV2Details(details)) return 2;
  return undefined;
};

const cumulativeSource = (
  branchEntries: SessionEntry[],
  firstKeptEntryId: string,
): { entries: SessionEntry[]; events: ReturnType<typeof normalizeEntries>; range: EntryRange; timestamp: string } => {
  const boundaryIndex = firstKeptEntryId
    ? branchEntries.findIndex((entry) => entry.id === firstKeptEntryId)
    : branchEntries.length;
  const prefix = branchEntries.slice(0, boundaryIndex >= 0 ? boundaryIndex : branchEntries.length);
  const events = normalizeEntries(prefix);
  const contentEntryIds = new Set(events.map((event) => event.sourceEntryId));
  const entries = prefix.filter((entry) => contentEntryIds.has(entry.id));
  return {
    entries,
    events,
    range: {
      first: entries[0]?.id ?? "",
      last: entries.at(-1)?.id ?? "",
    },
    timestamp: entries.at(-1)?.timestamp ?? "",
  };
};

const priorFabricVersions = (entries: SessionEntry[]): { v1: number; v2: number } => {
  let v1 = 0;
  let v2 = 0;
  for (const entry of entries) {
    if (entry.type !== "compaction") continue;
    const version = fabricCompactionVersion((entry as SessionEntry & { details?: unknown }).details);
    if (version === 1) v1 += 1;
    if (version === 2) v2 += 1;
  }
  return { v1, v2 };
};

export const compileFabricSummary = (
  branchEntries: SessionEntry[],
  tokensBefore: number,
  enrichers: readonly CompactionEnricher[] = NO_BUILTIN_ENRICHERS,
  customInstructions?: string,
): { compaction: CompactionResult<FabricCompactionDetailsV2> } | {
  cancel: true;
  reason: string;
  instructionError?: CompactionInstructionDecodeError;
} => {
  const instructions = decodeCompactionInstructions(customInstructions);
  if (!instructions.ok) {
    return {
      cancel: true,
      reason: `fabric: ${instructions.error.code}: ${instructions.error.message}`,
      instructionError: instructions.error,
    };
  }
  const cut = computeCut(branchEntries);
  if (!cut.ok) return { cancel: true, reason: "fabric: nothing to compact" };

  const source = cumulativeSource(branchEntries, cut.firstKeptEntryId);
  if (source.events.length === 0) return { cancel: true, reason: "fabric: no raw cumulative source" };
  const projected = projectWithMetadata(source.events);
  const sections: Sections = projected.sections;
  runEnrichers(enrichers, source.events, sections);

  const summary = renderSummary(sections, {
    firstEntryId: source.range.first,
    lastEntryId: source.range.last,
    lastTimestamp: source.timestamp,
    requestLines: instructions.requestLines,
  });
  const versions = priorFabricVersions(branchEntries);
  const sectionHeaders = SECTION_HEADERS
    .filter(({ key }) => sections[key].length > 0)
    .map(({ header }) => header);
  if (instructions.requestLines.length > 0) sectionHeaders.splice(1, 0, "[Compaction Request]");

  const details: FabricCompactionDetailsV2 = {
    compactor: "fabric",
    version: 2,
    sections: sectionHeaders,
    coverage: {
      cumulativeSourceRange: source.range,
      liveCutRange: {
        first: cut.firstSummarizedEntryId,
        last: cut.lastSummarizedEntryId,
      },
    },
    counts: {
      branchEntries: branchEntries.length,
      cumulativeSourceEntries: source.entries.length,
      sourceEvents: source.events.length,
      liveCutEntries: cut.summarized.length,
      priorFabricV1: versions.v1,
      priorFabricV2: versions.v2,
    },
    omittedCounts: {
      ...projected.omittedCounts,
      preserve: instructions.policy.omittedPreserveCount,
    },
    instructionPolicy: instructions.policy,
    stableAddresses: {
      firstKeptEntryId: cut.firstKeptEntryId,
      cumulativeSourceRange: source.range,
      recall: "session-entry-id-range",
    },
    timestamp: source.timestamp,
  };

  return {
    compaction: {
      summary,
      firstKeptEntryId: cut.firstKeptEntryId,
      tokensBefore,
      details,
    },
  };
};

const SECTION_HEADERS: { key: keyof Sections; header: string }[] = [
  { key: "goal", header: "[Session Goal]" },
  { key: "files", header: "[Files And Changes]" },
  { key: "activity", header: "[Fabric Activity]" },
  { key: "outstanding", header: "[Outstanding Context]" },
  { key: "earlierTurns", header: "[Earlier Turns]" },
  { key: "status", header: "[Current Status]" },
];

export interface CompactionHookOptions {
  getEngine: () => CompactionEngine;
  enrichers?: readonly CompactionEnricher[];
}

const notifyInstructionError = (
  context: ExtensionContext | undefined,
  error: CompactionInstructionDecodeError,
): void => {
  if (!context?.hasUI) return;
  context.ui.notify(clipUtf8(`Fabric compaction rejected: ${error.code}: ${error.message}`, 512), "error");
};

export const registerCompactionHook = (pi: ExtensionAPI, options: CompactionHookOptions): void => {
  pi.on("session_before_compact", (event: SessionBeforeCompactEvent, context: ExtensionContext) => {
    if (event.customInstructions === "__pi_vcc__") return;
    if (options.getEngine() !== "fabric") return;
    const { preparation, branchEntries } = event;
    const result = compileFabricSummary(
      branchEntries ?? [],
      preparation.tokensBefore,
      options.enrichers,
      event.customInstructions,
    );
    if ("cancel" in result) {
      if (result.instructionError) {
        notifyInstructionError(context, result.instructionError);
        return { cancel: true };
      }
      if ((event as SessionBeforeCompactEvent & { _piVccOverriding?: unknown })._piVccOverriding) {
        return;
      }
      return { cancel: true };
    }
    (event as SessionBeforeCompactEvent & { _fabricCompaction?: boolean })._fabricCompaction = true;
    return { compaction: result.compaction };
  });

  pi.on("session_before_tree", (event: SessionBeforeTreeEvent, context: ExtensionContext) => {
    if (options.getEngine() !== "fabric") return;
    const { preparation } = event;
    if (!preparation.userWantsSummary) return;
    const instructions = decodeCompactionInstructions(preparation.customInstructions);
    if (!instructions.ok) {
      notifyInstructionError(context, instructions.error);
      return { cancel: true };
    }
    const compiled = compileFabricBranchSummary(
      preparation.entriesToSummarize,
      preparation.customInstructions,
      options.enrichers,
    );
    if (!compiled) return;
    return { summary: compiled };
  });
};
