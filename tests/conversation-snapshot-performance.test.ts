import { describe, expect, it, vi } from "vitest";
import type { FabricState } from "../src/fabric-state.js";
import { FabricActivityStore } from "../src/activity/store.js";
import { createDashboardSnapshot, FabricDashboardSnapshotCache } from "../src/ui/snapshot.js";

const worker = (id: string, actorId: string, status = "completed", updatedAt = 1, startedAt = 1) => ({
  id, actorId, name: id, status, startedAt, updatedAt, cwd: "/tmp", runner: "pi", transport: "process",
  task: "", turns: 0, toolCalls: 0, usage: { input: 0, output: 0 },
});
const stateFor = (records: ReturnType<typeof worker>[], actorIds: string[]) => ({
  config: { mesh: { enabled: false } }, activity: { runs: () => [] }, agents: { listForUi: () => records },
  actors: { list: () => actorIds.map((id) => ({ id, name: id, status: "idle", updatedAt: 1 })),
    instructions: vi.fn(() => ""), messages: vi.fn(() => []) },
  mainAgentInfo: () => ({ id: "main", name: "Main", kind: "main", status: "idle", runner: "pi", transport: "host",
    startedAt: 1, updatedAt: 1, cwd: "/tmp", pendingMessages: false, local: true }),
  globalActors: { list: () => [] },
}) as unknown as FabricState;

describe("conversation dashboard projection", () => {
  it("shares immutable activity in the poll cache while still copying externally mutable domains", () => {
    const activity = new FabricActivityStore();
    activity.start("live");
    activity.beginCall("live", { callId: "call", ref: "pi.read", args: { path: "a.ts" } });
    const read = activity.createRunView();
    const records = [worker("a", "actor")];
    const state = stateFor(records, ["actor"]);
    const cache = new FabricDashboardSnapshotCache();
    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      const runs = read();
      clone.mockClear();
      const first = createDashboardSnapshot(state, [], undefined, runs, cache, true);
      // Cache input copies exclude the already immutable activity tree.
      expect(clone.mock.calls.some(([input]) => input !== null && typeof input === "object" && "runs" in input)).toBe(false);
      const unchanged = createDashboardSnapshot(state, [], undefined, read(), cache, true);
      expect(unchanged.agents).toBe(first.agents);
      expect(unchanged.runs[0]).toBe(runs[0]);
      records[0]!.usage.output = 12;
      const usage = createDashboardSnapshot(state, [], undefined, read(), cache, true);
      expect(usage.actors[0]!.worker!.usage!.output).toBe(12);
      activity.updateCall("live", "call", { type: "progress", message: "new" });
      const progress = createDashboardSnapshot(state, [], undefined, read(), cache, true);
      expect(progress.runs[0]!.calls[0]!.progress).toBe("new");
      expect(first.runs[0]!.calls[0]).not.toHaveProperty("progress");
      activity.reset();
      expect(createDashboardSnapshot(state, [], undefined, read(), cache, true).runs).toEqual([]);
    } finally {
      clone.mockRestore();
    }
  });
  it("indexes workers once, preserving active/finite recency/source-order ties", () => {
    const ids = Array.from({ length: 80 }, (_, i) => `actor-${i}`);
    const records = ids.flatMap((id) => [
      worker(`${id}-terminal`, id, "completed", 999),
      worker(`${id}-old`, id, "running", 10),
      worker(`${id}-first-tie`, id, "running", Number.NaN, 20),
      worker(`${id}-second-tie`, id, "running", 20),
    ]);
    let workerFilterVisits = 0;
    const originalFilter = Array.prototype.filter;
    const filter = vi.spyOn(Array.prototype, "filter").mockImplementation(function (this: unknown[], callback, thisArg) {
      if ((this[0] as { actorId?: string } | undefined)?.actorId) workerFilterVisits += this.length;
      return originalFilter.call(this, callback, thisArg);
    });
    let snapshot;
    try {
      snapshot = createDashboardSnapshot(stateFor(records, ids), []);
    } finally {
      filter.mockRestore();
    }
    expect(workerFilterVisits).toBeLessThanOrEqual(records.length * 2);
    expect(snapshot.actors.map((actor) => actor.worker?.id)).toEqual(ids.map((id) => `${id}-first-tie`));
  });

  it("reuses unchanged domains but observes in-place stats changes and explicit event invalidation", () => {
    const records = [worker("a", "actor")];
    const state = stateFor(records, ["actor"]);
    const cache = new FabricDashboardSnapshotCache();
    const first = createDashboardSnapshot(state, [], undefined, [], cache);
    const second = createDashboardSnapshot(state, [], undefined, [], cache);
    expect(second.actors).toBe(first.actors);
    expect(second.agents).toBe(first.agents);
    expect(state.actors.messages).toHaveBeenCalledTimes(1);
    records[0]!.usage.output = 80;
    const next = createDashboardSnapshot(state, [], undefined, [], cache);
    expect(next.actors[0]?.worker?.usage?.output).toBe(80);
    expect(next.actors).not.toBe(first.actors);
    cache.clear();
    createDashboardSnapshot(state, [], undefined, [], cache);
    expect(state.actors.messages).toHaveBeenCalledTimes(3);
  });
});
