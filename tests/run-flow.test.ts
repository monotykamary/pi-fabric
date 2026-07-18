import { describe, expect, it } from "vitest";
import type { FabricActivityRun } from "../src/activity/types.js";
import {
  buildRunFlowRows,
  windowRunFlowRows,
} from "../src/ui/run-flow.js";
import type { FabricUiAgent } from "../src/ui/types.js";

const run = (): FabricActivityRun => ({
  id: "run-flow",
  name: "Run flow",
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
  runId: "run-flow",
  phaseId: "analyze",
  startedAt,
  updatedAt: startedAt,
  ...overrides,
});

describe("Run Flow layout", () => {
  it("orders recursive children beneath their parent inside a phase", () => {
    const agents = [
      agent("sibling", 4),
      agent("child", 2, { parentId: "parent" }),
      agent("parent", 1),
      agent("grandchild", 3, { parentId: "child" }),
    ];

    const rows = buildRunFlowRows(run(), agents);
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
    const rows = buildRunFlowRows(run(), agents);
    const visible = windowRunFlowRows(rows, "agent:worker-25", 8);

    expect(visible).toHaveLength(8);
    expect(
      visible.some((row) => row.kind === "agent" && row.agent.id === "worker-25"),
    ).toBe(true);
    expect(visible[0]).toMatchObject({ kind: "omission", direction: "before", failed: 1 });
    expect(visible.at(-1)).toMatchObject({ kind: "omission", direction: "after" });
  });

  it("uses a combined omission row when only two rows fit", () => {
    const rows = buildRunFlowRows(
      run(),
      Array.from({ length: 8 }, (_, index) => agent(`worker-${index}`, index)),
    );
    const visible = windowRunFlowRows(rows, "agent:worker-4", 2);

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
    const rows = buildRunFlowRows(run(), agents);
    const visible = windowRunFlowRows(rows, "agent:node-14", 4);
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
        id: "__fabric_run_flow_unphased",
        name: "Collision phase",
        status: "completed",
        startedAt: 1,
        updatedAt: 1,
      },
    ];
    const unphased = agent("unphased", 1);
    delete unphased.phaseId;
    const phased = agent("phased", 2, { phaseId: "__fabric_run_flow_unphased" });
    const rows = buildRunFlowRows(collisionRun, [unphased, phased]);

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
    const rows = buildRunFlowRows(
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
      const rows = buildRunFlowRows(
        run(),
        Array.from({ length: count }, (_, index) => agent(`bounded-${index}`, index)),
      );
      for (let limit = 1; limit <= 12; limit++) {
        for (let selected = 0; selected < count; selected++) {
          const entityId = `agent:bounded-${selected}`;
          const visible = windowRunFlowRows(rows, entityId, limit);
          expect(visible.length).toBeLessThanOrEqual(limit);
          expect(
            visible.some((row) => row.kind === "agent" && row.entityId === entityId),
          ).toBe(true);
        }
      }
    }
  });

  it("uses the only available row for the selected agent", () => {
    const rows = buildRunFlowRows(run(), [agent("first", 1), agent("selected", 2)]);
    expect(windowRunFlowRows(rows, "agent:selected", 1)).toMatchObject([
      { kind: "agent", entityId: "agent:selected" },
    ]);
  });
});
