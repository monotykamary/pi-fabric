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
  runner: "pi",
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

const fakeState = (
  runs: FabricActivityRun[],
  records: SubagentRunRecord[],
  actors: unknown[] = [],
): FabricState =>
  ({
    activity: { runs: () => runs },
    subagents: { list: () => records },
    actors: { list: () => actors, instructions: () => "", messages: () => [] },
    globalActors: { list: () => [] },
    config: { mesh: { enabled: false } },
    mesh: { list: () => [] },
  }) as unknown as FabricState;

describe("dashboard snapshot agent ownership", () => {
  it("orders agents by creation regardless of status or recent activity", () => {
    const first = {
      ...record("first"),
      status: "completed" as const,
      startedAt: 100,
      updatedAt: 900,
    };
    const second = {
      ...record("second"),
      status: "running" as const,
      startedAt: 200,
      updatedAt: 800,
    };
    const third = {
      ...record("third"),
      status: "queued" as const,
      startedAt: 300,
      updatedAt: 700,
    };

    const snapshot = createDashboardSnapshot(fakeState([], [third, first, second]), []);

    expect(snapshot.agents.map((agent) => agent.id)).toEqual(["first", "second", "third"]);
  });

  it("preserves structured agent result values", () => {
    const structured = {
      ...record("structured"),
      status: "completed" as const,
      value: { findings: [{ severity: "high" }], approved: false },
    };

    const snapshot = createDashboardSnapshot(fakeState([], [structured]), []);

    expect(snapshot.agents[0]?.value).toEqual(structured.value);
    expect(snapshot.agents[0]?.value).not.toBe(structured.value);
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

  it("includes recursively nested agents with inherited ownership", () => {
    const grandchild = { ...record("agent-grandchild"), logFile: "/tmp/agent-grandchild/events.jsonl" };
    const child = record("agent-child", [grandchild]);
    const parent = record("agent-parent", [child]);
    const launch = run("launch-run", "agents.spawn", parent.id, 100, "investigate");

    const snapshot = createDashboardSnapshot(fakeState([launch], [parent]), []);
    expect(snapshot.agents.find((agent) => agent.id === grandchild.id)).toMatchObject({
      parentId: child.id,
      runId: "launch-run",
      phaseId: "investigate",
      logFile: "/tmp/agent-grandchild/events.jsonl",
    });
  });

  it("bounds historical one-shot agents to the newest creation window", () => {
    const records = Array.from({ length: 300 }, (_, index) => ({
      ...record(`agent-${index}`),
      status: (index === 299 ? "running" : "completed") as "running" | "completed",
      startedAt: index,
      updatedAt: 300 - index,
    }));

    const snapshot = createDashboardSnapshot(fakeState([], records), []);
    expect(snapshot.agents).toHaveLength(240);
    expect(snapshot.agents[0]?.id).toBe("agent-60");
    expect(snapshot.agents.at(-1)?.id).toBe("agent-299");
  });

  it("prefers an active actor worker over a newer retained failure", () => {
    const failed = {
      ...record("actor-failed"),
      actorId: "actor-1",
      status: "failed" as const,
      updatedAt: 900,
    };
    const running = {
      ...record("actor-running"),
      actorId: "actor-1",
      status: "running" as const,
      updatedAt: 800,
    };
    const actor = {
      id: "actor-1",
      name: "reviewer",
      status: "running",
      events: [],
      topics: [],
      delivery: "mailbox",
      responseMode: "text",
      triggerTurn: false,
      coalesce: true,
      queued: 0,
      messages: 0,
      createdAt: 100,
      updatedAt: 900,
    };

    const snapshot = createDashboardSnapshot(fakeState([], [failed, running], [actor]), []);
    expect(snapshot.actors[0]?.worker?.id).toBe("actor-running");
  });
});
