import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryRequestCache,
  recallContinuationKey,
  expansionSelectionKey,
  type ExpansionSnapshot,
  type RecallContinuationCache,
  type ResolvedExpansionSelection,
} from "../src/memory/request-cache.js";
import type { SourceObservation } from "../src/memory/source-observation.js";

const observation = (file = "/session.jsonl"): SourceObservation => ({
  file,
  identity: { device: 1n, inode: 2n, size: 3n, modifiedAt: 4n, changedAt: 5n },
  liveBranchSignature: "leaf\0" + 1,
});

const snapshot = (file = "/session.jsonl"): ExpansionSnapshot => ({
  file,
  branches: "active",
  sourceHash: "source",
  lineageFingerprint: "lineage",
  observation: observation(file),
  entries: [],
  selections: new Map(),
  touchedAt: Date.now(),
});

const continuation = (): RecallContinuationCache => ({
  key: "query",
  result: {
    matchMode: "browse", matchedCount: 0, totalMatches: 0, totalItems: 0,
    segmentCount: 0, segments: [], digestHits: [], items: [],
    queryCoverage: { complete: true, reasons: [] },
  },
  coverage: {
    complete: true, indexedSessions: 1, eligibleSessions: 1,
    staleSessions: 0, incompleteSessions: 0, reasons: [],
  },
  requestArgs: {},
  observations: [observation()],
  touchedAt: Date.now(),
});

afterEach(() => vi.restoreAllMocks());

describe("memory request cache ownership", () => {
  it("isolates instances and only forgets the currently owned continuation", () => {
    const cache = new MemoryRequestCache();
    const old = continuation();
    const current = continuation();
    cache.rememberRecallContinuation(old);
    cache.rememberRecallContinuation(current);
    cache.forgetRecallContinuation(old);
    expect(cache.cachedRecallContinuation("query", [observation()])).toBe(current);
    expect(new MemoryRequestCache().cachedRecallContinuation("query", [observation()])).toBeUndefined();
    cache.forgetRecallContinuation(current);
    expect(cache.cachedRecallContinuation("query", [observation()])).toBeUndefined();
  });

  it("refreshes the five-minute idle TTL and expires both cache kinds", () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const cache = new MemoryRequestCache();
    const recall = continuation();
    const expansion = snapshot();
    cache.rememberRecallContinuation(recall);
    cache.rememberExpansionSnapshot(expansion);
    now = 300_000;
    expect(cache.cachedRecallContinuation("query", [observation()])).toBe(recall);
    expect(cache.cachedExpansionSnapshot(expansion.file, "active", observation())).toBe(expansion);
    now += 300_001;
    expect(cache.cachedRecallContinuation("query", [observation()])).toBeUndefined();
    expect(cache.cachedExpansionSnapshot(expansion.file, "active", observation())).toBeUndefined();
  });

  it.each(["missing", "identity", "lineage"])("invalidates %s observations without retaining stale state", (change) => {
    const cache = new MemoryRequestCache();
    const expansion = snapshot();
    cache.rememberRecallContinuation(continuation());
    cache.rememberExpansionSnapshot(expansion);
    const changed = observation();
    if (change === "identity") changed.identity.changedAt += 1n;
    if (change === "lineage") changed.liveBranchSignature = "another-leaf";
    const next = change === "missing" ? null : changed;
    expect(cache.cachedRecallContinuation("query", next ? [next] : null)).toBeUndefined();
    expect(cache.cachedExpansionSnapshot(expansion.file, "active", next)).toBeUndefined();
    expect(cache.cachedRecallContinuation("query", [observation()])).toBeUndefined();
    expect(cache.cachedExpansionSnapshot(expansion.file, "active", observation())).toBeUndefined();
  });

  it("retains two LRU snapshots, partitions branches, and ignores obsolete forgets", () => {
    const cache = new MemoryRequestCache();
    const first = snapshot("/first.jsonl");
    const second = snapshot("/second.jsonl");
    const third = snapshot("/third.jsonl");
    cache.rememberExpansionSnapshot(first);
    cache.rememberExpansionSnapshot(second);
    expect(cache.cachedExpansionSnapshot(first.file, "all", first.observation)).toBeUndefined();
    expect(cache.cachedExpansionSnapshot(first.file, "active", first.observation)).toBe(first);
    cache.rememberExpansionSnapshot(third);
    expect(cache.cachedExpansionSnapshot(second.file, "active", second.observation)).toBeUndefined();
    const replacement = snapshot(first.file);
    cache.rememberExpansionSnapshot(replacement);
    cache.forgetExpansionSnapshot(first);
    expect(cache.cachedExpansionSnapshot(first.file, "active", first.observation)).toBe(replacement);
  });

  it("bounds selection aliases to sixteen and refreshes repeated keys", () => {
    const cache = new MemoryRequestCache();
    const entry = snapshot();
    const selection: ResolvedExpansionSelection = { entries: [], canonical: { indices: [0] }, anchorIndex: null };
    cache.rememberExpansionSelection(entry, ["requested", "canonical", "requested"], selection);
    for (let index = 0; index < 14; index++) cache.rememberExpansionSelection(entry, [String(index)], selection);
    cache.rememberExpansionSelection(entry, ["requested", "new"], selection);
    expect(entry.selections.size).toBe(16);
    expect(entry.selections.has("canonical")).toBe(false);
    expect(entry.selections.get("requested")).toBe(selection);
  });

  it("omits page offset from recall keys while binding integrity and selector context", () => {
    expect(recallContinuationKey({ query: "term", offset: 0 }))
      .toBe(recallContinuationKey({ query: "term", offset: 20 }));
    expect(recallContinuationKey({ query: "term", expectedSourceHash: "old" }))
      .not.toBe(recallContinuationKey({ query: "term", expectedSourceHash: "new" }));
    expect(expansionSelectionKey({ indices: [0], before: 1 }))
      .not.toBe(expansionSelectionKey({ indices: [0], after: 1 }));
  });
});
