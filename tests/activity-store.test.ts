import { describe, expect, it, vi } from "vitest";
import { FabricActivityStore } from "../src/activity/store.js";

describe("FabricActivityStore", () => {
  it("tracks dynamic phases, calls, entities, metrics, and custom items", () => {
    const store = new FabricActivityStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.start("run-1", { name: "Repository audit", description: "Inspect every package" });
    const discover = store.phase("run-1", { name: "Discover", total: 2 });
    store.beginCall("run-1", {
      callId: "call-1",
      ref: "agents.run",
      args: { name: "package-a", task: "Audit package A" },
    });
    store.updateCall("run-1", "call-1", {
      type: "entity",
      id: "agent-1",
      kind: "agent",
      name: "package-a",
    });
    store.updateCall("run-1", "call-1", {
      type: "metrics",
      tokens: 1200,
      toolCalls: 4,
    });
    store.finishCall("run-1", "call-1", {
      success: true,
      result: {
        id: "agent-1",
        status: "completed",
        toolCalls: 5,
        usage: { input: 900, output: 500, cost: 0.01 },
      },
    });
    store.upsertItem("run-1", {
      id: "inventory",
      label: "Inventory packages",
      phase: discover.id,
      status: "completed",
      completed: 2,
      total: 2,
    });
    store.event("run-1", { message: "Inventory complete", level: "success" });

    const audit = store.phase("run-1", { name: "Audit", total: 4 });
    store.upsertItem("run-1", {
      id: "batch",
      label: "Audit packages",
      status: "running",
      completed: 1,
      total: 4,
    });

    let run = store.get("run-1");
    expect(run).toMatchObject({
      name: "Repository audit",
      status: "running",
      currentPhaseId: audit.id,
      phases: [
        { name: "Discover", status: "completed", total: 2 },
        { name: "Audit", status: "running", total: 4 },
      ],
      calls: [
        {
          label: "package-a",
          status: "completed",
          entityId: "agent-1",
          metrics: { tokens: 1400, toolCalls: 5, cost: 0.01 },
        },
      ],
      events: [{ message: "Inventory complete", level: "success" }],
    });

    store.finish("run-1", true);
    run = store.get("run-1");
    expect(run?.status).toBe("completed");
    expect(run?.phases[1]?.status).toBe("completed");
    expect(run?.items.find((item) => item.id === "batch")?.status).toBe("completed");
    expect(listener).toHaveBeenCalled();
  });

  it("summarizes finished call results into a detail field", () => {
    const store = new FabricActivityStore();
    store.start("run-d");
    store.beginCall("run-d", { callId: "bash-1", ref: "pi.bash", args: { command: "seq 1 3" } });
    store.finishCall("run-d", "bash-1", { success: true, result: { ok: true, output: "line1\nline2" } });
    store.beginCall("run-d", { callId: "read-1", ref: "pi.read", args: { path: "/a.ts" } });
    store.finishCall("run-d", "read-1", { success: true, result: "export const x = 1;" });
    store.beginCall("run-d", { callId: "fail-1", ref: "pi.bash", args: {} });
    store.finishCall("run-d", "fail-1", { success: false, error: "boom" });

    const run = store.get("run-d");
    expect(run?.calls.find((c) => c.id === "bash-1")?.detail).toBe("line1 line2");
    expect(run?.calls.find((c) => c.id === "read-1")?.detail).toBe("export const x = 1;");
    const failed = run?.calls.find((c) => c.id === "fail-1");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("boom");
    expect(failed?.detail).toBeUndefined();
  });

  it("marks failed calls and cancelled executions", () => {
    const store = new FabricActivityStore();
    store.start("run-2");
    store.phase("run-2", { name: "Execute" });
    store.beginCall("run-2", { callId: "call-2", ref: "pi.bash", args: {} });
    store.finishCall("run-2", "call-2", { success: false, error: "command failed" });
    store.finish("run-2", false, "Execution cancelled");

    expect(store.get("run-2")).toMatchObject({
      status: "cancelled",
      phases: [{ status: "failed" }],
      calls: [{ status: "failed", error: "command failed" }],
    });
  });
});
