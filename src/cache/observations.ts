import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FabricCacheObservation, FabricCacheSample } from "./types.js";

export const CACHE_OBSERVATION_LIMIT = 256;
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const price = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Unknown counters are not zero-percent cache misses. */
export function cacheSample(usage: unknown, entryId: string, timestamp: string): FabricCacheSample | null {
  if (!usage || typeof usage !== "object") return null;
  const value = usage as Record<string, unknown>;
  const { input, cacheRead, cacheWrite, output } = value;
  if (!count(input) || !count(cacheRead) || !count(cacheWrite) || !count(output)) return null;
  const totalInput = input + cacheRead + cacheWrite;
  const observedAt = Date.parse(timestamp);
  if (!Number.isSafeInteger(totalInput + output) || totalInput === 0 || !Number.isFinite(observedAt)) return null;
  const cost = value.cost && typeof value.cost === "object"
    ? (value.cost as Record<string, unknown>).total : undefined;
  return { entryId, observedAt, input, cacheRead, cacheWrite, output, totalInput,
    cacheReadShare: cacheRead / totalInput, reportedCostUsd: price(cost) ? cost : null };
}

/** Bounded active-branch walk; never scans session files or abandoned branches. */
export function observePromptCache(context: ExtensionContext): FabricCacheObservation {
  const result: FabricCacheObservation = {
    lastRequest: null, lastRefresh: null,
    maintenance: { requests: 0, tokens: 0, reportedCostUsd: 0, unknownCostRequests: 0, unknownTokenRequests: 0 },
    window: { entries: 0, limit: CACHE_OBSERVATION_LIMIT, truncated: false, stoppedAt: null },
  };
  const manager = context.sessionManager;
  if (typeof manager.getLeafEntry !== "function" || typeof manager.getEntry !== "function") {
    result.window.stoppedAt = "history-unavailable";
    return result;
  }
  const seen = new Set<string>();
  let entry = manager.getLeafEntry();
  while (entry && result.window.entries < CACHE_OBSERVATION_LIMIT) {
    if (seen.has(entry.id)) { result.window.stoppedAt = "invalid-history"; break; }
    seen.add(entry.id);
    result.window.entries++;
    if (["compaction", "branch_summary", "model_change", "thinking_level_change", "context_edit"].includes(entry.type)
      || (entry.type === "message" && entry.message.role === "system")) {
      result.window.stoppedAt = entry.type;
      break;
    }
    if (entry.type === "message" && entry.message.role === "assistant") {
      const message = entry.message;
      if (message.provider === context.model?.provider && message.model === context.model.id) {
        result.lastRequest ??= cacheSample(message.usage, entry.id, entry.timestamp);
      }
    } else if (entry.type === "usage" && entry.kind === "cache_warm"
      && entry.provider === context.model?.provider && entry.model === context.model.id) {
      const sample = cacheSample(entry.usage, entry.id, entry.timestamp);
      result.lastRefresh ??= sample;
      result.maintenance.requests++;
      // Account each persisted receipt once, independently from display selection.
      const counters = [entry.usage.input, entry.usage.output, entry.usage.cacheRead, entry.usage.cacheWrite];
      const tokens = counters.reduce((sum, value) => sum + value, 0);
      if (counters.every(count) && count(tokens) && count(result.maintenance.tokens + tokens)) result.maintenance.tokens += tokens;
      else result.maintenance.unknownTokenRequests++;
      const cost = entry.usage.cost?.total;
      if (price(cost) && price(result.maintenance.reportedCostUsd + cost)) result.maintenance.reportedCostUsd += cost;
      else result.maintenance.unknownCostRequests++;
    }
    const parentId = entry.parentId;
    entry = parentId ? manager.getEntry(parentId) : undefined;
    if (parentId && !entry) result.window.stoppedAt = "missing-parent";
  }
  result.window.truncated = Boolean(entry) && result.window.stoppedAt === null;
  return result;
}
