import { describe, expect, it } from "vitest";
import type { FabricActivityRun } from "../src/activity/types.js";
import type { MeshEvent } from "../src/mesh/store.js";
import {
  buildProjectMeshTopology,
  buildRunTopologyRows,
  windowProjectMeshTopology,
  windowRunTopologyRows,
} from "../src/ui/topology.js";
import type { FabricUiActor, FabricUiAgent, FabricUiStateEntry } from "../src/ui/types.js";

const run = (): FabricActivityRun => ({
  id: "run-topology",
  name: "Run topology",
  status: "running",
  phases: [
    {
      id: "analyze",
      name: "Analyze",
      status: "running",
      startedAt: 1,
      updatedAt: 1,
    },
  ],
  calls: [],
  items: [],
  events: [],
  currentPhaseId: "analyze",
  startedAt: 1,
  updatedAt: 1,
});

const agent = (
  id: string,
  startedAt: number,
  overrides: Partial<FabricUiAgent> = {},
): FabricUiAgent => ({
  id,
  name: id,
  status: "completed",
  runner: "pi",
  transport: "process",
  cwd: "/tmp/project",
  runId: "run-topology",
  phaseId: "analyze",
  startedAt,
  updatedAt: startedAt,
  ...overrides,
});

const actor = (overrides: Partial<FabricUiActor> = {}): FabricUiActor => ({
  id: "actor-1",
  name: "advisor",
  status: "idle",
  runner: "pi",
  events: ["turn_end"],
  topics: ["team.review"],
  delivery: "mailbox",
  responseMode: "directive",
  triggerTurn: false,
  coalesce: true,
  queued: 0,
  messages: 0,
  createdAt: 1,
  updatedAt: 1,
  instructions: "Review project decisions.",
  recentMessages: [],
  ...overrides,
});

const stateEntry = (index: number): FabricUiStateEntry => ({
  key: `tasks/task-${index}`,
  label: `Task ${index}`,
  status: index === 25 ? "blocked" : "claimed",
  owner: "advisor",
  value: { status: "claimed", owner: "advisor" },
  version: index + 1,
  updatedAt: index + 1,
});

const event = (
  id: string,
  sequence: number,
  overrides: Partial<MeshEvent> = {},
): MeshEvent => ({
  id,
  sequence,
  topic: "team.review",
  kind: "finding",
  from: { id: "actor-1", name: "advisor", kind: "actor" },
  createdAt: sequence * 100,
  ...overrides,
});

describe("Run topology layout", () => {
  it("orders recursive children beneath their parent inside a phase", () => {
    const agents = [
      agent("sibling", 4),
      agent("child", 2, { parentId: "parent" }),
      agent("parent", 1),
      agent("grandchild", 3, { parentId: "child" }),
    ];

    const rows = buildRunTopologyRows(run(), agents);
    expect(
      rows.map((row) => (row.kind === "phase" ? `phase:${row.name}` : row.agent.id)),
    ).toEqual(["phase:Analyze", "parent", "child", "grandchild", "sibling"]);

    const child = rows.find(
      (row) => row.kind === "agent" && row.agent.id === "child",
    );
    const grandchild = rows.find(
      (row) => row.kind === "agent" && row.agent.id === "grandchild",
    );
    expect(child).toMatchObject({ ancestorLast: [false], isLast: true });
    expect(grandchild).toMatchObject({ ancestorLast: [false, true], isLast: true });
  });

  it("keeps the selected agent visible and summarizes both omitted sides", () => {
    const agents = Array.from({ length: 40 }, (_, index) =>
      agent(`worker-${index}`, index, {
        status: index === 0 ? "failed" : index === 25 ? "running" : "completed",
      }),
    );
    const rows = buildRunTopologyRows(run(), agents);
    const visible = windowRunTopologyRows(rows, "agent:worker-25", 8);

    expect(visible).toHaveLength(8);
    expect(
      visible.some((row) => row.kind === "agent" && row.agent.id === "worker-25"),
    ).toBe(true);
    expect(visible[0]).toMatchObject({ kind: "omission", direction: "before", failed: 1 });
    expect(visible.at(-1)).toMatchObject({ kind: "omission", direction: "after" });
  });

  it("uses a combined omission row when only two rows fit", () => {
    const rows = buildRunTopologyRows(
      run(),
      Array.from({ length: 8 }, (_, index) => agent(`worker-${index}`, index)),
    );
    const visible = windowRunTopologyRows(rows, "agent:worker-4", 2);

    expect(visible).toMatchObject([
      { kind: "omission", direction: "both" },
      { kind: "agent", entityId: "agent:worker-4" },
    ]);
  });

  it("carries hidden phase and ancestor context into a truncated window", () => {
    const agents = Array.from({ length: 15 }, (_, index) =>
      agent(`node-${index}`, index, {
        ...(index > 0 ? { parentId: `node-${index - 1}` } : {}),
      }),
    );
    const rows = buildRunTopologyRows(run(), agents);
    const visible = windowRunTopologyRows(rows, "agent:node-14", 4);
    const summary = visible[0];

    expect(summary).toMatchObject({ kind: "omission", direction: "before" });
    if (summary?.kind !== "omission") throw new Error("missing omission summary");
    expect(summary.context).toEqual(["Analyze", "node-9", "node-10", "node-11"]);
    expect(visible.at(-1)).toMatchObject({ kind: "agent", entityId: "agent:node-14" });
  });

  it("keeps unphased agents separate from a colliding phase id", () => {
    const collisionRun = run();
    collisionRun.phases = [
      {
        id: "__fabric_run_topology_unphased",
        name: "Collision phase",
        status: "completed",
        startedAt: 1,
        updatedAt: 1,
      },
    ];
    const unphased = agent("unphased", 1);
    delete unphased.phaseId;
    const phased = agent("phased", 2, { phaseId: "__fabric_run_topology_unphased" });
    const rows = buildRunTopologyRows(collisionRun, [unphased, phased]);

    expect(rows.filter((row) => row.kind === "phase").map((row) => row.name)).toEqual([
      "Run activity",
      "Collision phase",
    ]);
    expect(rows.filter((row) => row.kind === "agent").map((row) => row.agent.id)).toEqual([
      "unphased",
      "phased",
    ]);
  });

  it("does not mark an unknown phase of stopped agents as running", () => {
    const rows = buildRunTopologyRows(
      run(),
      [agent("stopped", 1, { phaseId: "ad-hoc", status: "stopped" })],
      { includeEmptyPhases: false },
    );
    expect(rows.find((row) => row.kind === "phase" && row.id === "ad-hoc")).toMatchObject({
      status: "stopped",
    });
  });

  it("never exceeds the viewport while keeping every possible selection visible", () => {
    for (let count = 2; count <= 30; count++) {
      const rows = buildRunTopologyRows(
        run(),
        Array.from({ length: count }, (_, index) => agent(`bounded-${index}`, index)),
      );
      for (let limit = 1; limit <= 12; limit++) {
        for (let selected = 0; selected < count; selected++) {
          const entityId = `agent:bounded-${selected}`;
          const visible = windowRunTopologyRows(rows, entityId, limit);
          expect(visible.length).toBeLessThanOrEqual(limit);
          expect(
            visible.some((row) => row.kind === "agent" && row.entityId === entityId),
          ).toBe(true);
        }
      }
    }
  });

  it("uses the only available row for the selected agent", () => {
    const rows = buildRunTopologyRows(run(), [agent("first", 1), agent("selected", 2)]);
    expect(windowRunTopologyRows(rows, "agent:selected", 1)).toMatchObject([
      { kind: "agent", entityId: "agent:selected" },
    ]);
  });
});

describe("Project mesh topology layout", () => {
  it("connects actors, topics, shared state, and normalized recent routes", () => {
    const actors = [actor()];
    const events: MeshEvent[] = [
      event("topic", 1),
      event("input", 2, {
        topic: "fabric.actor.input",
        kind: "message",
        from: { id: "main", name: "main", kind: "main" },
        data: { actorId: "actor-1" },
      }),
      event("output", 3, {
        topic: "fabric.actor.output",
        kind: "directive",
      }),
      event("lifecycle", 4, {
        topic: "fabric.actor.lifecycle",
        kind: "settled",
      }),
    ];

    const model = buildProjectMeshTopology({
      actors,
      agents: [],
      state: [stateEntry(0)],
      events,
      now: 1_000,
    });

    expect(model.topics).toMatchObject([
      {
        id: "topic:team.review",
        subscribers: [{ id: "actor-1", name: "advisor" }],
        recentEvents: 1,
        status: "running",
      },
    ]);
    expect(model.routes).toHaveLength(3);
    expect(model.routes.map((route) => route.targetKind).sort()).toEqual([
      "actor",
      "main",
      "topic",
    ]);
    expect(model.entityOrder).toEqual([
      "actor:actor-1",
      "topic:team.review",
      "state:tasks/task-0",
      expect.stringContaining("route:"),
      expect.stringContaining("route:"),
      expect.stringContaining("route:"),
    ]);
    expect(model.rows.some((row) => row.kind === "meshLink")).toBe(true);
  });

  it("aggregates identical traffic routes and keeps the latest payload", () => {
    const model = buildProjectMeshTopology({
      actors: [actor()],
      agents: [],
      state: [],
      events: [
        event("first", 1, { text: "first" }),
        event("second", 2, { text: "second" }),
      ],
      now: 1_000,
    });

    expect(model.routes).toMatchObject([
      { count: 2, lastAt: 200, text: "second", targetName: "team.review" },
    ]);
  });

  it("keeps a selected node visible while summarizing a large project mesh", () => {
    const model = buildProjectMeshTopology({
      actors: [actor()],
      agents: [],
      state: Array.from({ length: 40 }, (_, index) => stateEntry(index)),
      events: [],
      now: 1_000,
    });
    const visible = windowProjectMeshTopology(
      model.rows,
      "state:tasks/task-25",
      8,
    );

    expect(visible).toHaveLength(8);
    expect(
      visible.some(
        (row) => row.kind === "meshState" && row.entityId === "state:tasks/task-25",
      ),
    ).toBe(true);
    expect(visible[0]).toMatchObject({ kind: "meshOmission", direction: "before" });
    expect(visible.at(-1)).toMatchObject({ kind: "meshOmission", direction: "after" });
  });

  it("never exceeds the project topology viewport for selectable nodes", () => {
    const model = buildProjectMeshTopology({
      actors: [actor()],
      agents: [],
      state: Array.from({ length: 12 }, (_, index) => stateEntry(index)),
      events: Array.from({ length: 45 }, (_, index) =>
        event(`event-${index}`, index + 1, { kind: `kind-${index}` }),
      ),
      now: 10_000,
    });
    expect(model.routes).toHaveLength(45);

    for (let limit = 1; limit <= 10; limit++) {
      for (const entityId of model.entityOrder) {
        const visible = windowProjectMeshTopology(model.rows, entityId, limit);
        expect(visible.length).toBeLessThanOrEqual(limit);
        expect(
          visible.some((row) => "entityId" in row && row.entityId === entityId),
        ).toBe(true);
      }
    }
  });
  it("maps known and external transient agents observed in mesh traffic", () => {
    const known = agent("worker-1", 1, { name: "researcher", status: "running" });
    const model = buildProjectMeshTopology({
      actors: [actor()],
      agents: [known],
      state: [],
      events: [
        event("known-agent", 1, {
          from: { id: "worker-1", name: "researcher", kind: "agent" },
        }),
        event("external-agent", 2, {
          from: { id: "external-1", name: "external scout", kind: "agent" },
        }),
      ],
      now: 1_000,
    });

    expect(model.participants).toMatchObject([
      {
        id: "worker-1",
        entityId: "agent:worker-1",
        name: "researcher",
        status: "running",
        routes: 1,
        agent: { id: "worker-1" },
      },
      {
        id: "external-1",
        entityId: "participant:external-1",
        name: "external scout",
        status: "idle",
        routes: 1,
      },
    ]);
    expect(model.rows.filter((row) => row.kind === "meshAgent")).toHaveLength(2);
  });

  it("keeps structured routes distinct when free-form fields contain separators", () => {
    const model = buildProjectMeshTopology({
      actors: [],
      agents: [],
      state: [],
      events: [
        event("separator-target", 1, {
          to: "worker|topic",
          topic: "team.review",
          kind: "finding",
          from: { id: "main-1", name: "main", kind: "main" },
        }),
        event("separator-kind", 2, {
          to: "worker",
          topic: "topic",
          kind: "team.review|finding",
          from: { id: "main-1", name: "main", kind: "main" },
        }),
      ],
      now: 1_000,
    });

    expect(model.routes).toHaveLength(2);
    expect(new Set(model.routes.map((route) => route.id)).size).toBe(2);
  });

  it("recognizes a main-session identity when traffic addresses it", () => {
    const model = buildProjectMeshTopology({
      actors: [actor()],
      agents: [],
      state: [],
      events: [
        event("main-presence", 1, {
          from: { id: "main-1", name: "main", kind: "main" },
        }),
        event("to-main", 2, { to: "main-1" }),
      ],
      now: 1_000,
    });

    expect(model.routes).toHaveLength(2);
    expect(model.routes.some((route) => route.targetKind === "main")).toBe(true);
    expect(model.participants.some((participant) => participant.id === "main-1")).toBe(false);
  });

  it("marks explicit failure event kinds without misclassifying benign substrings", () => {
    const model = buildProjectMeshTopology({
      actors: [],
      agents: [],
      state: [],
      events: [
        event("failover", 1, { kind: "failover.started" }),
        event("tool-error", 2, { kind: "tool_error" }),
      ],
      now: 1_000,
    });

    expect(model.routes.find((route) => route.kind === "failover.started")?.status).toBe(
      "completed",
    );
    expect(model.routes.find((route) => route.kind === "tool_error")?.status).toBe("failed");
  });

});
