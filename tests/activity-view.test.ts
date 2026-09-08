import { afterEach, describe, expect, it, vi } from "vitest";
import { FabricActivityStore } from "../src/activity/store.js";

const fixture = () => {
  const store = new FabricActivityStore();
  store.start("history");
  store.beginCall("history", { callId: "old", ref: "pi.read", args: { path: "old.ts" } });
  store.finish("history", true);
  store.start("live");
  store.phase("live", { name: "Build" });
  for (const callId of ["a", "b"]) {
    store.beginCall("live", { callId, ref: "pi.read", args: { path: `${callId}.ts`, nested: { text: "secret" } } });
  }
  store.upsertItem("live", { id: "item", label: "Item", data: { secret: true } });
  store.event("live", { message: "event", data: { secret: true } });
  return store;
};

afterEach(() => vi.restoreAllMocks());

describe("revisioned activity views", () => {
  it("matches legacy summaries and detail, without sharing mutable payloads", () => {
    const store = fixture();
    const read = store.createRunView();
    expect(read()).toEqual(store.runSummaries());
    const detailed = read(true);
    expect(detailed).toEqual(store.runs());
    const args = detailed[0]!.calls[0]!.args!;
    expect(Object.isFrozen(args.nested)).toBe(true);
    expect(() => { args.path = "corrupt"; }).toThrow();
    const legacy = store.runs();
    legacy[0]!.calls[0]!.args!.path = "independent";
    expect(store.get("live")!.calls[0]!.args!.path).toBe("a.ts");
    expect(read()).toEqual(store.runSummaries());
    expect(read()[0]!.calls[0]).not.toHaveProperty("args");
    expect(read()[0]!.items[0]).not.toHaveProperty("data");
    expect(read()[0]!.events[0]).not.toHaveProperty("data");
  });

  it.each([false, true])("reuses untouched runs, rows and payloads (detailed=%s)", (detailed) => {
    vi.spyOn(Date, "now").mockReturnValue(100);
    const store = fixture();
    const read = store.createRunView();
    const before = read(detailed);
    const clones = vi.spyOn(globalThis, "structuredClone");
    const unchanged = read(detailed);
    expect(clones).not.toHaveBeenCalled();
    expect(unchanged).not.toBe(before);
    expect(unchanged[0]).toBe(before[0]);
    unchanged.reverse();
    expect(read(detailed)[0]!.id).toBe("live");
    store.updateCall("live", "a", { type: "progress", message: "changed in same millisecond" });
    const after = read(detailed);
    expect(after[1]).toBe(before[1]);
    expect(after[0]!.calls[1]).toBe(before[0]!.calls[1]);
    expect(after[0]!.phases[0]).toBe(before[0]!.phases[0]);
    expect(after[0]!.items[0]).toBe(before[0]!.items[0]);
    expect(after[0]!.events[0]).toBe(before[0]!.events[0]);
    expect(after[0]!.calls[0]).not.toBe(before[0]!.calls[0]);
    expect(after[0]!.calls[0]!.args).toBe(before[0]!.calls[0]!.args);
    expect(before[0]!.calls[0]).not.toHaveProperty("progress");
    expect(after).toEqual(detailed ? store.runs() : store.runSummaries());
  });

  it("does not consume changes for another reader, and replaces obsolete projections after reset/restart", () => {
    const store = fixture();
    const fast = store.createRunView();
    const slow = store.createRunView();
    const old = slow();
    fast();
    store.updateCall("live", "a", { type: "metrics", tokens: 42 });
    fast();
    store.finishCall("live", "a", { success: false, error: "failed" });
    fast();
    expect(slow()).toEqual(store.runSummaries());
    expect(old[0]!.calls[0]!.status).toBe("running");
    store.start("live", { name: "Replacement" });
    expect(fast()[0]!.name).toBe("Replacement");
    expect(slow()[0]!.calls).toEqual([]);
    store.reset();
    expect(fast()).toEqual([]);
    expect(slow()).toEqual([]);
    store.start("live");
    expect(slow()[0]).not.toBe(old[0]);
  });

  it("tracks all mutation paths, ordering, payload replacement, and retention", () => {
    const store = fixture();
    const read = store.createRunView();
    const check = () => expect(read(true)).toEqual(store.runs());
    check();
    store.configure("live", { name: "Configured" }); check();
    store.phase("live", { name: "Next" }); check();
    store.updateCallArgs("live", "a", { path: "new.ts" }); check();
    store.updateCall("live", "a", { type: "entity", id: "entity", kind: "agent", name: "Agent" }); check();
    store.updateCall("live", "a", { type: "metrics", tokens: 7, cost: 0.1 }); check();
    store.finishCall("live", "a", { success: true, result: { output: "result" }, preview: { text: "preview" } }); check();
    store.beginCall("live", { callId: "a", ref: "pi.read", args: { path: "restart.ts" } }); check();
    store.upsertItem("live", { id: "item", label: "Updated", status: "completed" }); check();
    store.event("live", { message: "same event" }); check();
    store.event("live", { message: "same event" }); check();
    expect(read()[0]!.events).toHaveLength(3);
    store.finish("live", false, "cancelled"); check();
    store.resume("live"); check();
    for (let i = 0; i < 30; i++) { store.start(`run-${i}`); store.finish(`run-${i}`, true); check(); }
    expect(read().length).toBeLessThanOrEqual(24);
    expect(read().some((run) => run.id === "live")).toBe(true);
    for (let i = 0; i < 1005; i++) {
      store.beginCall("live", { callId: `call-${i}`, ref: "pi.read", args: {} });
      read();
    }
    expect(read().find((run) => run.id === "live")!.calls).toHaveLength(1000);
    expect(read()).toEqual(store.runSummaries());
  });

  it("suppresses normalized no-op updates but preserves real changes and lifecycle notifications", () => {
    const store = fixture();
    const listener = vi.fn();
    store.subscribe(listener);
    const updates = [
      { type: "progress", message: " working " },
      { type: "entity", id: "agent", kind: "agent", name: "Agent" },
      { type: "metrics", tokens: 5, cost: -1, toolCalls: 2 },
    ] as const;
    for (const update of updates) store.updateCall("live", "a", update);
    const before = store.get("live");
    const revision = store.revision();
    listener.mockClear();
    for (let i = 0; i < 100; i++) for (const update of updates) store.updateCall("live", "a", update);
    store.updateCall("live", "a", { type: "progress", message: "" });
    store.updateCall("live", "a", { type: "metrics" });
    expect(listener).not.toHaveBeenCalled();
    expect(store.revision()).toBe(revision);
    expect(store.get("live")).toEqual(before);
    store.updateCall("live", "a", { type: "metrics", tokens: 6 });
    expect(listener).toHaveBeenCalledTimes(1);
    store.finishCall("live", "a", { success: true });
    store.finish("live", true);
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
