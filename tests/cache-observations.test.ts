import { SessionManager, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { cacheSample, observePromptCache, CACHE_OBSERVATION_LIMIT } from "../src/cache/observations.js";

const usage = { input: 20, cacheRead: 80, cacheWrite: 0, output: 2, cost: { total: 0.02 } };
const timestamp = "2026-01-01T00:00:00.000Z";
const message = (id: string, value: unknown = usage) => ({ type: "message", id, timestamp, message: { role: "assistant", provider: "test", model: "model", usage: value } });
function context(entries: Record<string, unknown>[]) {
  const chain = entries.map((entry, index) => ({ ...entry, parentId: index ? entries[index - 1]!.id : null })) as unknown as SessionEntry[];
  const byId = new Map(chain.map(entry => [entry.id, entry]));
  const getEntry = vi.fn((id: string) => byId.get(id));
  return { host: { model: { provider: "test", id: "model" }, sessionManager: {
    getLeafEntry: () => chain.at(-1), getEntry,
    getBranch: () => { throw new Error("Unbounded branch scans are forbidden"); },
  } } as unknown as ExtensionContext, getEntry };
}

describe("prompt-cache observations", () => {
  it("reads real native session messages and maintenance receipts without duplicating accounting", () => {
    const manager = SessionManager.inMemory();
    const nativeUsage = { ...usage, totalTokens: 102, cost: { input: 0.01, output: 0.005, cacheRead: 0.005, cacheWrite: 0, total: 0.02 } };
    manager.appendModelChange("test", "model");
    const requestId = manager.appendMessage({ role: "assistant", api: "openai-completions", provider: "test", model: "model",
      content: [{ type: "text", text: "done" }], usage: nativeUsage, stopReason: "stop", timestamp: Date.now() });
    const refresh = manager.appendUsage("cache_warm", "test", "model", nativeUsage);
    const { host } = context([]);
    const observed = observePromptCache({ ...host, sessionManager: manager });
    expect(observed).toMatchObject({ lastRequest: { entryId: requestId }, lastRefresh: { entryId: refresh.id },
      maintenance: { requests: 1, reportedCostUsd: 0.02 }, window: { stoppedAt: "model_change" } });
    expect(manager.getEntries()).toHaveLength(3);
  });
  it("keeps the last measurable request and original timestamp through placeholders", () => {
    const { host } = context([message("measured"), message("zero", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), message("missing", {})]);
    expect(observePromptCache(host).lastRequest).toMatchObject({ entryId: "measured", observedAt: Date.parse(timestamp), cacheReadShare: 0.8, totalInput: 100 });
  });
  it("replaces a hit with a real measured miss, and distinguishes unknown fields", () => {
    const { host } = context([message("hit"), message("miss", { ...usage, cacheRead: 0 }), message("unknown", { input: 100, output: 1 })]);
    expect(observePromptCache(host).lastRequest).toMatchObject({ entryId: "miss", cacheReadShare: 0 });
    expect(cacheSample({ input: 100, output: 1 }, "id", timestamp)).toBeNull();
  });
  it.each([undefined, null, {}, { ...usage, input: -1 }, { ...usage, cacheRead: NaN }, { ...usage, input: Number.MAX_SAFE_INTEGER }])("rejects invalid or unknown samples: %j", value => {
    expect(cacheSample(value, "id", timestamp)).toBeNull();
  });
  it.each(["compaction", "branch_summary", "model_change", "thinking_level_change", "context_edit"])("does not resurrect samples before %s", type => {
    const { host } = context([message("old"), { type, id: "boundary" }, message("zero", { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })]);
    expect(observePromptCache(host)).toMatchObject({ lastRequest: null, window: { stoppedAt: type } });
  });
  it("ignores other models and stops at prompt/tool checkpoints", () => {
    const { host } = context([message("old"), { type: "message", id: "system", message: { role: "system" } }, { ...message("other"), message: { role: "assistant", provider: "other", model: "model", usage } }]);
    expect(observePromptCache(host).lastRequest).toBeNull();
  });
  it("separates warming from real requests and counts each receipt once", () => {
    const { host } = context([message("real"), { type: "usage", id: "warm", timestamp, kind: "cache_warm", provider: "test", model: "model", usage },
      { type: "usage", id: "unknown", timestamp, kind: "cache_warm", provider: "test", model: "model", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]);
    const first = observePromptCache(host);
    expect(first).toMatchObject({ lastRequest: { entryId: "real" }, lastRefresh: { entryId: "warm" },
      maintenance: { requests: 2, tokens: 102, reportedCostUsd: 0.02, unknownCostRequests: 1, unknownTokenRequests: 0 } });
    expect(observePromptCache(host)).toEqual(first);
  });
  it("discloses unknown maintenance counters rather than summing malformed values", () => {
    const { host } = context([{ type: "usage", id: "bad", timestamp, kind: "cache_warm", provider: "test", model: "model", usage: { ...usage, input: -1 } }]);
    expect(observePromptCache(host)).toMatchObject({ lastRefresh: null, maintenance: { tokens: 0, unknownTokenRequests: 1 } });
  });
  it("bounds traversal and discloses truncation without traversing a whole branch", () => {
    const { host, getEntry } = context(Array.from({ length: 300 }, (_, i) => ({ type: "custom", id: String(i) })));
    expect(observePromptCache(host).window).toEqual({ entries: CACHE_OBSERVATION_LIMIT, limit: CACHE_OBSERVATION_LIMIT, truncated: true, stoppedAt: null });
    expect(getEntry).toHaveBeenCalledTimes(CACHE_OBSERVATION_LIMIT);
  });
  it("handles unavailable history without pretending it is a measured miss", () => {
    expect(observePromptCache({ sessionManager: {} } as ExtensionContext)).toMatchObject({ lastRequest: null, window: { stoppedAt: "history-unavailable" } });
  });
});
