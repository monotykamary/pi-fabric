import {
  buildSessionContext,
  calculateContextTokens,
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  sessionEntryToContextMessages,
  type CompactionResult,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionBeforeTreeEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { clipUtf8, MAX_SUMMARY_BYTES } from "./bounds.js";
import { NO_BUILTIN_ENRICHERS, runEnrichers, type CompactionEnricher } from "./enrichers.js";
import { compileFabricBranchSummary } from "./branch-summary.js";
import {
  decodeCompactionInstructions,
  type CompactionInstructionDecodeError,
  type CompactionInstructionPolicy,
} from "./instructions.js";
import { isPiCustomMessageEntry, normalizeEntries } from "./normalize.js";
import {
  projectWithMetadata,
  type ProjectionOmittedCounts,
  type Sections,
} from "./projections.js";
import { renderSummary } from "./render.js";

type CompactionEngine = "pi" | "fabric";

interface LiveEntry {
  entry: SessionEntry;
  branchIndex: number;
  turnBoundary: boolean;
  cutPoint: boolean;
  estimatedTokens: number;
  message?: {
    role?: unknown;
    content?: unknown;
    toolCallId?: unknown;
  };
}

interface CallResultSpan {
  first: number;
  last: number;
  hasCall: boolean;
  hasResult: boolean;
}

export interface FabricCompactionBudget {
  contextWindow: number;
  targetContextRatio: number;
  reserveTokens: number;
  keepRecentTokens: number;
}

export interface FabricCompactionBudgetDetails {
  strategy: "adaptive";
  contextWindow: number;
  targetContextRatio: number;
  targetContextTokens: number;
  reserveTokens: number;
  keepRecentTokens: number;
  rawTokensBefore: number;
  tokenScale: number;
  fixedOverheadTokens: number;
  retainedRawTokens: number;
  projectedTokensAfter: number;
}

interface AdaptiveCutPlan {
  contextWindow: number;
  targetContextRatio: number;
  targetContextTokens: number;
  reserveTokens: number;
  keepRecentTokens: number;
  rawTokensBefore: number;
  tokenScale: number;
  fixedOverheadTokens: number;
  recentRawTokenBudget: number;
}

const SUMMARY_RAW_TOKEN_BUDGET = Math.ceil(MAX_SUMMARY_BYTES / 4);
const HARD_CEILING_SAFETY_RATIO = 0.9;
const MAX_PRECOMPACTION_RATIO = 0.95;

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

const contextMessages = (entry: SessionEntry): ReturnType<typeof sessionEntryToContextMessages> => {
  try {
    return sessionEntryToContextMessages(entry);
  } catch {
    return [];
  }
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

const collectContextEntries = (entries: SessionEntry[], startIndex: number): LiveEntry[] => {
  const contextEntries: LiveEntry[] = [];
  for (let index = Math.max(0, startIndex); index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.type === "compaction") continue;
    if (entry.type === "custom_message" && !isPiCustomMessageEntry(entry)) continue;
    if (isMessageEntry(entry) && isHiddenEmptyCustom(entry.message)) continue;
    const messages = contextMessages(entry);
    if (messages.length === 0) continue;
    const roles = messages.map((message) => message.role);
    const rawMessage = isMessageEntry(entry)
      ? entry.message as NonNullable<LiveEntry["message"]>
      : undefined;
    contextEntries.push({
      entry,
      branchIndex: index,
      turnBoundary: roles.some((role) =>
        role === "user"
        || role === "custom"
        || role === "bashExecution"
        || role === "branchSummary"
        || role === "compactionSummary"),
      cutPoint: roles.some((role) => role !== "toolResult"),
      estimatedTokens: messages.reduce((total, message) => total + estimateTokens(message), 0),
      ...(rawMessage ? { message: rawMessage } : {}),
    });
  }
  return contextEntries;
};

const collectLive = (entries: SessionEntry[]): LiveEntry[] => {
  const last = findLastCompaction(entries);
  if (!last) return collectContextEntries(entries, 0);
  if (last.firstKeptEntryId) {
    const keptIndex = entries.findIndex((entry) => entry.id === last.firstKeptEntryId);
    if (keptIndex >= 0) return collectContextEntries(entries, keptIndex);
  }
  return collectContextEntries(entries, last.index + 1);
};

const previousBoundaryAtOrBefore = (live: LiveEntry[], branchIndex: number): number => {
  for (let index = live.length - 1; index >= 0; index--) {
    const item = live[index]!;
    if (item.branchIndex <= branchIndex && item.turnBoundary) return index;
  }
  return -1;
};

const lastBoundaryIndex = (live: LiveEntry[]): number => {
  for (let index = live.length - 1; index >= 0; index--) {
    if (live[index]!.turnBoundary) return index;
  }
  return -1;
};

const callResultSpans = (entries: SessionEntry[]): Map<string, CallResultSpan> => {
  const spans = new Map<string, CallResultSpan>();
  const record = (id: string, index: number, kind: "call" | "result"): void => {
    if (!id) return;
    const span = spans.get(id) ?? {
      first: index,
      last: index,
      hasCall: false,
      hasResult: false,
    };
    span.first = Math.min(span.first, index);
    span.last = Math.max(span.last, index);
    if (kind === "call") span.hasCall = true;
    else span.hasResult = true;
    spans.set(id, span);
  };
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (!isMessageEntry(entry)) continue;
    const message = entry.message as NonNullable<LiveEntry["message"]>;
    for (const id of toolCallIdsOf(message)) record(id, index, "call");
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      record(message.toolCallId, index, "result");
    }
  }
  return spans;
};

const spanCrosses = (span: CallResultSpan, boundaryIndex: number): boolean =>
  span.hasCall
  && span.hasResult
  && span.first < boundaryIndex
  && span.last >= boundaryIndex;

const closureSafe = (spans: Map<string, CallResultSpan>, boundaryIndex: number): boolean =>
  [...spans.values()].every((span) => !spanCrosses(span, boundaryIndex));

const closeCut = (
  branchEntries: SessionEntry[],
  live: LiveEntry[],
  candidateLiveIndex: number,
): number => {
  const spans = callResultSpans(branchEntries);
  let liveIndex = candidateLiveIndex;
  while (liveIndex > 0) {
    const boundaryIndex = live[liveIndex]!.branchIndex;
    let earliestCrossing = boundaryIndex;
    for (const span of spans.values()) {
      if (spanCrosses(span, boundaryIndex)) {
        earliestCrossing = Math.min(earliestCrossing, span.first);
      }
    }
    if (earliestCrossing === boundaryIndex) return liveIndex;
    const closed = previousBoundaryAtOrBefore(live, earliestCrossing);
    if (closed < 0 || closed >= liveIndex) return 0;
    liveIndex = closed;
  }
  return 0;
};

const rawContextTokens = (branchEntries: SessionEntry[]): number =>
  buildSessionContext(branchEntries).messages.reduce(
    (total, message) => total + estimateTokens(message),
    0,
  );

interface UsageCheckpoint {
  rawTokens: number;
  contextTokens: number;
}

const usageCheckpoints = (branchEntries: SessionEntry[]): UsageCheckpoint[] => {
  const lastCompaction = findLastCompaction(branchEntries);
  const startIndex = lastCompaction ? lastCompaction.index + 1 : 0;
  let rawTokens = lastCompaction
    ? rawContextTokens(branchEntries.slice(0, lastCompaction.index + 1))
    : 0;
  const checkpoints: UsageCheckpoint[] = [];
  for (let index = startIndex; index < branchEntries.length; index++) {
    for (const message of contextMessages(branchEntries[index]!)) {
      rawTokens += estimateTokens(message);
      if (message.role !== "assistant") continue;
      const contextTokens = calculateContextTokens(message.usage);
      if (Number.isFinite(contextTokens) && contextTokens > 0) {
        checkpoints.push({ rawTokens, contextTokens });
      }
    }
  }
  return checkpoints;
};

// Fit an upper affine envelope: context ≈ fixed overhead + scale × raw messages.
// Only post-marker usage is comparable; the fallback treats all unexplained tokens as fixed.
const tokenCalibration = (
  branchEntries: SessionEntry[],
  tokensBefore: number,
  rawTokensBefore: number,
): { tokenScale: number; fixedOverheadTokens: number } => {
  const minimumDelta = Math.max(4_096, Math.floor(rawTokensBefore * 0.1));
  const checkpoints = usageCheckpoints(branchEntries).filter(
    (checkpoint) => checkpoint.rawTokens < rawTokensBefore
      && checkpoint.contextTokens <= tokensBefore,
  );
  const slopes = checkpoints.flatMap((checkpoint) => {
    const rawDelta = rawTokensBefore - checkpoint.rawTokens;
    const contextDelta = tokensBefore - checkpoint.contextTokens;
    return rawDelta >= minimumDelta && contextDelta >= 0
      ? [contextDelta / rawDelta]
      : [];
  }).filter((slope) => Number.isFinite(slope) && slope >= 0);

  if (slopes.length === 0) {
    return {
      tokenScale: 1,
      fixedOverheadTokens: Math.max(0, tokensBefore - rawTokensBefore),
    };
  }

  const tokenScale = Math.max(1, ...slopes);
  const fixedOverheadTokens = Math.max(
    0,
    tokensBefore - tokenScale * rawTokensBefore,
    ...checkpoints.map(
      (checkpoint) => checkpoint.contextTokens - tokenScale * checkpoint.rawTokens,
    ),
  );
  return { tokenScale, fixedOverheadTokens };
};

const adaptiveCutPlan = (
  branchEntries: SessionEntry[],
  tokensBefore: number,
  budget: FabricCompactionBudget,
): AdaptiveCutPlan | undefined => {
  if (!Number.isFinite(budget.contextWindow) || budget.contextWindow <= 0) return undefined;
  const contextWindow = Math.floor(budget.contextWindow);
  const reserveTokens = Math.max(0, Math.floor(budget.reserveTokens));
  const keepRecentTokens = Math.max(0, Math.floor(budget.keepRecentTokens));
  const targetContextRatio = Math.max(0.25, Math.min(0.85, budget.targetContextRatio));
  const rawTokensBefore = rawContextTokens(branchEntries);
  const { tokenScale, fixedOverheadTokens } = tokenCalibration(
    branchEntries,
    tokensBefore,
    rawTokensBefore,
  );
  const hardCeiling = Math.max(1, contextWindow - reserveTokens);
  const safeCeiling = Math.max(1, Math.floor(hardCeiling * HARD_CEILING_SAFETY_RATIO));
  const configuredTarget = Math.floor(contextWindow * targetContextRatio);
  const keepRecentTarget = Math.ceil(
    fixedOverheadTokens + (keepRecentTokens + SUMMARY_RAW_TOKEN_BUDGET) * tokenScale,
  );
  const reductionCeiling = Math.max(1, Math.floor(tokensBefore * MAX_PRECOMPACTION_RATIO));
  const targetContextTokens = Math.min(
    safeCeiling,
    reductionCeiling,
    Math.max(configuredTarget, keepRecentTarget),
  );
  const rawPostBudget = Math.max(
    0,
    Math.floor((targetContextTokens - fixedOverheadTokens) / tokenScale),
  );
  return {
    contextWindow,
    targetContextRatio,
    targetContextTokens,
    reserveTokens,
    keepRecentTokens,
    rawTokensBefore,
    tokenScale,
    fixedOverheadTokens,
    recentRawTokenBudget: Math.max(0, rawPostBudget - SUMMARY_RAW_TOKEN_BUDGET),
  };
};

export type CutResult =
  | {
      ok: true;
      summarized: SessionEntry[];
      firstKeptEntryId: string;
      firstSummarizedEntryId: string;
      lastSummarizedEntryId: string;
      lastTimestamp: string;
      budget?: Omit<FabricCompactionBudgetDetails, "projectedTokensAfter">;
    }
  | { ok: false; reason: "empty" };

const boundary = (
  summarized: SessionEntry[],
  firstKeptEntryId: string,
  budget?: Omit<FabricCompactionBudgetDetails, "projectedTokensAfter">,
): CutResult => {
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
    ...(budget ? { budget } : {}),
  };
};

const computeAdaptiveCut = (
  branchEntries: SessionEntry[],
  live: LiveEntry[],
  plan: AdaptiveCutPlan,
): CutResult => {
  const suffixTokens = new Array<number>(live.length + 1).fill(0);
  for (let index = live.length - 1; index >= 0; index--) {
    suffixTokens[index] = suffixTokens[index + 1]! + live[index]!.estimatedTokens;
  }
  const spans = callResultSpans(branchEntries);
  // Pi replays entries contiguously from firstKeptEntryId, including compaction markers.
  const previousCompactionIndex = findLastCompaction(branchEntries)?.index ?? -1;
  let cutIndex = live.length;
  for (let index = 1; index < live.length; index++) {
    const item = live[index]!;
    if (item.branchIndex <= previousCompactionIndex) continue;
    if (!item.cutPoint || suffixTokens[index]! > plan.recentRawTokenBudget) continue;
    if (!closureSafe(spans, item.branchIndex)) continue;
    cutIndex = index;
    break;
  }
  const retainedRawTokens = suffixTokens[cutIndex] ?? 0;
  const details = {
    strategy: "adaptive" as const,
    contextWindow: plan.contextWindow,
    targetContextRatio: plan.targetContextRatio,
    targetContextTokens: plan.targetContextTokens,
    reserveTokens: plan.reserveTokens,
    keepRecentTokens: plan.keepRecentTokens,
    rawTokensBefore: plan.rawTokensBefore,
    tokenScale: plan.tokenScale,
    fixedOverheadTokens: plan.fixedOverheadTokens,
    retainedRawTokens,
  };
  if (cutIndex >= live.length) {
    return boundary(live.map((item) => item.entry), "", details);
  }
  return boundary(
    live.slice(0, cutIndex).map((item) => item.entry),
    live[cutIndex]!.entry.id,
    details,
  );
};

export const computeCut = (
  branchEntries: SessionEntry[],
  options?: { tokensBefore: number; budget: FabricCompactionBudget },
): CutResult => {
  const live = collectLive(branchEntries);
  if (live.length === 0) return { ok: false, reason: "empty" };

  if (options) {
    const plan = adaptiveCutPlan(branchEntries, options.tokensBefore, options.budget);
    if (plan) return computeAdaptiveCut(branchEntries, live, plan);
  }

  const lastBoundary = lastBoundaryIndex(live);
  if (lastBoundary <= 0) return boundary(live.map((item) => item.entry), "");
  const closed = closeCut(branchEntries, live, lastBoundary);
  const previousCompactionIndex = findLastCompaction(branchEntries)?.index ?? -1;
  if (closed <= 0 || live[closed]!.branchIndex <= previousCompactionIndex) {
    return boundary(live.map((item) => item.entry), "");
  }

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
  budget?: FabricCompactionBudgetDetails;
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
    && (value.budget === undefined || (
      isRecord(value.budget)
      && value.budget.strategy === "adaptive"
      && hasFiniteNumbers(value.budget, [
        "contextWindow",
        "targetContextRatio",
        "targetContextTokens",
        "reserveTokens",
        "keepRecentTokens",
        "rawTokensBefore",
        "tokenScale",
        "fixedOverheadTokens",
        "retainedRawTokens",
        "projectedTokensAfter",
      ])
    ))
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
  budget?: FabricCompactionBudget,
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
  const cut = computeCut(
    branchEntries,
    budget ? { tokensBefore, budget } : undefined,
  );
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
  const projectedTokensAfter = cut.budget
    ? Math.ceil(
        cut.budget.fixedOverheadTokens
        + (cut.budget.retainedRawTokens + Math.ceil(summary.length / 4))
        * cut.budget.tokenScale,
      )
    : undefined;
  const budgetDetails = cut.budget && projectedTokensAfter !== undefined
    ? { ...cut.budget, projectedTokensAfter }
    : undefined;
  // The maximum-summary reservation should make this unreachable unless fixed overhead alone
  // makes the target infeasible. Never persist an expanding or nominally unsafe result.
  if (budgetDetails && budgetDetails.projectedTokensAfter > budgetDetails.targetContextTokens) {
    return {
      cancel: true,
      reason: "fabric: no deterministic summary fits the adaptive context target",
    };
  }
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
    ...(budgetDetails ? { budget: budgetDetails } : {}),
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
  getTargetContextRatio?: () => number;
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
    const contextWindow = context?.model?.contextWindow;
    const targetContextRatio = options.getTargetContextRatio?.();
    const settings = preparation.settings ?? DEFAULT_COMPACTION_SETTINGS;
    const budget = typeof contextWindow === "number"
      && Number.isFinite(contextWindow)
      && typeof targetContextRatio === "number"
      && Number.isFinite(targetContextRatio)
      ? {
          contextWindow,
          targetContextRatio,
          reserveTokens: settings.reserveTokens,
          keepRecentTokens: settings.keepRecentTokens,
        }
      : undefined;
    const result = compileFabricSummary(
      branchEntries ?? [],
      preparation.tokensBefore,
      options.enrichers,
      event.customInstructions,
      budget,
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
    // Pi's replacement mode delegates an arbitrary summarizer prompt. Fabric's
    // deterministic projections cannot execute it without pretending that it
    // is append-only context, so leave this explicit mode to the next/default handler.
    if (preparation.replaceInstructions === true) return;
    const instructions = decodeCompactionInstructions(preparation.customInstructions);
    if (!instructions.ok) {
      notifyInstructionError(context, instructions.error);
      return { cancel: true };
    }
    const compiled = compileFabricBranchSummary(
      preparation.entriesToSummarize,
      preparation.customInstructions,
      options.enrichers,
      preparation.oldLeafId,
    );
    if (!compiled) return;
    return { summary: compiled };
  });
};
