import { describe, expect, it } from "vitest";
import type { FabricActivityRun } from "../src/activity/types.js";
import type { FabricState } from "../src/fabric-state.js";
import type { SubagentRunRecord } from "../src/subagents/types.js";
import { createDashboardSnapshot } from "../src/ui/snapshot.js";

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0 };

const record = (id: string, nestedAgents?: SubagentRunRecord[]): SubagentRunRecord => ({
  id,
  name: id,
  task: `Inspect ${id}`,
  status: "running",
  transport: "process",
  cwd: "/tmp/project",
  startedAt: 100,
  updatedAt: 200,
  turns: 1,
  toolCalls: 1,
  text: "",
  usage,
  ...(nestedAgents ? { nestedAgents } : {}),
});

const run = (
  id: string,
  ref: string,
  entityId: string,
  startedAt: number,
  phaseId?: string,
): FabricActivityRun => ({
  id,
  name: id,
  status: "completed",
  phases: phaseId
    ? [{ id: phaseId, name: phaseId, status: "completed", startedAt, updatedAt: startedAt }]
    : [],
  calls: [
    {
      id: `${id}-call`,
      ref,
      label: ref,
      kind: "agent",
      status: "completed",
      entityId,
      startedAt,
      updatedAt: startedAt,
      ...(phaseId ? { phaseId } : {}),
    },
  ],
  items: [],
  events: [],
  startedAt,
  updatedAt: startedAt,
  finishedAt: startedAt,
});

const fakeState = (runs: FabricActivityRun[], records: SubagentRunRecord[]): FabricState =>
  ({
    activity: { runs: () => runs },
    subagents: { list: () => records },
    actors: { list: () => [], instructions: () => "", messages: () => [] },
    globalActors: { list: () => [] },
    config: { mesh: { enabled: false } },
    mesh: { list: () => [] },
  }) as unknown as FabricState;

describe("dashboard snapshot agent ownership", () => {
  it("orders agents by attention before recency", () => {
    const queued = { ...record("queued"), status: "queued" as const, updatedAt: 900 };
    const running = { ...record("running"), status: "running" as const, updatedAt: 500 };
    const failed = { ...record("failed"), status: "failed" as const, updatedAt: 600 };
    const completed = { ...record("completed"), status: "completed" as const, updatedAt: 700 };
    const stopped = { ...record("stopped"), status: "stopped" as const, updatedAt: 800 };

    const snapshot = createDashboardSnapshot(
      fakeState([], [stopped, completed, failed, running, queued]),
      [],
    );

    expect(snapshot.agents.map((agent) => agent.id)).toEqual([
      "queued",
      "running",
      "failed",
      "completed",
      "stopped",
    ]);
  });

  it("keeps launch ownership when a later status call returns the same agent id", () => {
    const child = record("agent-child");
    const parent = record("agent-parent", [child]);
    const launch = run("launch-run", "agents.spawn", parent.id, 100, "investigate");
    const status = run("status-run", "agents.status", parent.id, 200);

    const snapshot = createDashboardSnapshot(fakeState([status, launch], [parent]), []);
    const parentUi = snapshot.agents.find((agent) => agent.id === parent.id);
    const childUi = snapshot.agents.find((agent) => agent.id === child.id);

    expect(snapshot.runs[0]?.id).toBe("launch-run");
    expect(parentUi).toMatchObject({ runId: "launch-run", phaseId: "investigate" });
    expect(childUi).toMatchObject({
      parentId: parent.id,
      runId: "launch-run",
      phaseId: "investigate",
    });
  });
});
