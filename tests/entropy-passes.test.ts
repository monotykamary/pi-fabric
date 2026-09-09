import { describe, expect, it } from "vitest";
import {
  applyProposalsToSurface,
  evaluateGate,
  measureEntropy,
  proposeEntropyReductions,
  type EntropyOperationInput,
  type EntropySurfaceSnapshot,
  type EntropyTraceInput,
} from "../src/entropy/index.js";

const op = (
  ref: string,
  args: Record<string, unknown>,
  outcome: "succeeded" | "failed" = "succeeded",
  failureStage?: string,
): EntropyOperationInput => ({
  ref,
  args,
  outcome,
  ...(failureStage ? { failureStage } : {}),
});

const trace = (
  operations: EntropyOperationInput[],
  taskKey?: string,
): EntropyTraceInput => ({
  operations,
  ...(taskKey ? { taskKey } : {}),
});

const surfaceOf = (actions: Array<{ ref: string; inputSchema: unknown }>): EntropySurfaceSnapshot => ({
  version: 1,
  actions,
});

const ratchetTraces = (): EntropyTraceInput[] => [
  trace(
    [
      op("mcp.report.render", { format: "pdf" }),
      op("mcp.report.render", { format: "pdf" }),
      op("mcp.report.render", { format: "pdf" }),
      op("mcp.report.render", { format: "pdf" }),
      op("mcp.report.render", { format: "pdf" }),
      op("mcp.report.render", { format: "pdf" }),
      op("mcp.report.render", { format: "pdf" }),
      op("mcp.report.render", { format: "html" }),
    ],
    "ratchet",
  ),
  trace(
    [
      op("mcp.flaky.run", { mode: "fast" }, "failed", "validate"),
      op("mcp.flaky.run", { mode: "slow" }, "failed", "invoke"),
      op("mcp.flaky.run", { mode: "fast" }, "failed", "validate"),
      op("mcp.flaky.run", { mode: "fast" }, "failed", "invoke"),
    ],
    "ratchet",
  ),
  trace(
    [
      op("memory.expand", { session: "s1" }),
      ...["s2", "s3", "s4", "s5", "s6", "s7", "s8"].map((session) =>
        op("memory.expand", { session }),
      ),
    ],
    "ratchet",
  ),
];

const ratchetSurface = (): EntropySurfaceSnapshot =>
  surfaceOf([
    {
      ref: "mcp.report.render",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["format"],
        properties: { format: { type: "string", enum: ["docx", "html", "pdf", "web"] } },
      },
    },
    {
      ref: "mcp.flaky.run",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["mode"],
        properties: { mode: { type: "string" } },
      },
    },
    {
      ref: "memory.expand",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["session"],
        properties: { session: { type: "string" } },
      },
    },
  ]);

const ratchetRepairs = () => [
  { kind: "keyAlias" as const, ref: "memory.expand", from: "sessionId", to: "session" },
];

const structureTraces = (): EntropyTraceInput[] => [
  trace(
    [
      op("pi.read", { path: "a" }),
      op("pi.grep", { path: "." }),
      op("pi.edit", { path: "a" }),
    ],
    "loop",
  ),
  trace(
    [
      op("pi.read", { path: "b" }),
      op("pi.grep", { path: "." }),
      op("pi.edit", { path: "b" }),
    ],
    "loop",
  ),
  trace(
    [
      op("mcp.store.put", { key: "k", value: "v" }),
      op("mcp.store.put", { key: "k", value: "v" }),
      op("mcp.store.put", { key: "k", value: "v" }),
      op("mcp.store.put", { prefix: "p", limit: 10 }),
      op("mcp.store.put", { prefix: "p", limit: 10 }),
      op("mcp.store.put", { prefix: "p", limit: 10 }),
    ],
    "structure",
  ),
];

describe("capability-preserving entropy proposals", () => {
  it("derives normal forms without any observations and never proposes restrictions", () => {
    const surface = ratchetSurface();
    const proposals = proposeEntropyReductions({ report: measureEntropy({ traces: [], surface }), traces: [], surface });
    expect(proposals).toHaveLength(3);
    expect(proposals.every((proposal) => proposal.kind === "normal-form")).toBe(true);
    expect(applyProposalsToSurface(surface, proposals)).toBe(surface);
    const busy = proposeEntropyReductions({ report: measureEntropy({ traces: ratchetTraces(), surface }), traces: ratchetTraces(), surface });
    expect(busy.filter((proposal) => proposal.kind === "normal-form")).toEqual(proposals);
    expect(busy.some((proposal) => ["enum-tighten", "noise-quarantine"].includes(proposal.kind))).toBe(false);
  });

  it("leaves canonical names and every rare enum capability untouched", () => {
    const surface = ratchetSurface();
    const saved = JSON.stringify(surface);
    const proposals = proposeEntropyReductions({ report: measureEntropy({ traces: ratchetTraces(), surface }), traces: ratchetTraces(), surface, repairs: ratchetRepairs() });
    expect(applyProposalsToSurface(surface, proposals)).toBe(surface);
    expect(JSON.stringify(surface)).toBe(saved);
    expect(applyProposalsToSurface(surface, [
      { kind: "enum-tighten", ref: "mcp.report.render", key: "format", values: ["pdf"], calls: 8, distinct: 1, topShare: 1 },
      { kind: "noise-quarantine", ref: "mcp.flaky.run", calls: 4, failed: 4, succeeded: 0, failureStageEntropyBits: 1 },
    ])).toBe(surface);
  });

  it("does not infer domains from strings, numeric ranges, booleans, or unknown refs", () => {
    const surface = surfaceOf([{ ref: "demo.call", inputSchema: {
      type: "object", additionalProperties: false,
      properties: { text: { type: "string" }, count: { type: "number", minimum: 1 }, all: { type: "boolean" } },
    } }]);
    const traces = [trace(Array.from({ length: 8 }, (_, index) => op("demo.call", { text: index < 7 ? "a" : "b", count: index % 2 + 1, all: index % 2 === 0, undeclared: "x" }))), trace([op("ghost.run", { value: "a" })])];
    const proposals = proposeEntropyReductions({ report: measureEntropy({ traces, surface }), traces, surface });
    expect(proposals.every((proposal) => proposal.kind === "normal-form")).toBe(true);
    expect(proposals).toHaveLength(1);
  });

  it("retains opted-in vocabulary suggestions without applying them", () => {
    const surface = surfaceOf([{ ref: "demo.call", inputSchema: {
      type: "object", additionalProperties: false, properties: { format: { type: "string", "x-fabric-enum-candidate": true } },
    } }]);
    const valueObservations = [
      { ref: "demo.call", key: "format", value: "pdf", count: 7 },
      { ref: "demo.call", key: "format", value: "html", count: 1 },
    ];
    const report = measureEntropy({ traces: [], surface });
    const proposals = proposeEntropyReductions({ report, traces: [], surface, valueObservations });
    expect(proposals.find((proposal) => proposal.kind === "declare-enum")).toMatchObject({ values: ["pdf", "html"], calls: 8, distinct: 2, topShare: 0.875 });
    expect(applyProposalsToSurface(surface, proposals)).toBe(surface);
    expect(proposeEntropyReductions({ report, traces: [], surface }).some((proposal) => proposal.kind === "declare-enum")).toBe(false);
  });

  it("does not reinterpret a declared enum when pooled or pre-birth values differ", () => {
    const surface = ratchetSurface();
    const proposals = proposeEntropyReductions({ report: measureEntropy({ traces: [], surface }), traces: [], surface,
      valueObservations: [
        { ref: "mcp.report.render", key: "format", value: "pdf", count: 70 },
        { ref: "mcp.report.render", key: "format", value: "rtf", count: 10 },
      ],
    });
    expect(proposals.every((proposal) => proposal.kind === "normal-form")).toBe(true);
    expect(applyProposalsToSurface(surface, proposals)).toBe(surface);
  });

  it("checks observed regression without rewarding surface shrinkage", () => {
    const before = measureEntropy({ traces: ratchetTraces(), surface: ratchetSurface() });
    const same = measureEntropy({ traces: ratchetTraces(), surface: ratchetSurface() });
    expect(evaluateGate(before, same)).toMatchObject({ passed: true, delta: 0 });
    expect(evaluateGate(before, { ...same, score: before.score + 0.1 }).passed).toBe(false);
    expect(evaluateGate(before, { ...same, totals: { ...same.totals, succeeded: 0 } }).reasons.join(" ")).toContain("successful calls dropped");
  });

  it("does not mistake repeated Pi primitives for a composite action", () => {
    const report = measureEntropy({ traces: structureTraces() });
    const proposals = proposeEntropyReductions({
      report,
      traces: structureTraces(),
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: "overload-split",
      ref: "mcp.store.put",
      shapeEntropyBits: 1,
      clusters: [
        { keys: ["key", "value"], calls: 3 },
        { keys: ["limit", "prefix"], calls: 3 },
      ],
    });
  });

  it("requires a high-level sequence to recur in independent executions", () => {
    const workflow = [
      op("memory.recall", { query: "needle" }),
      op("memory.expand", { session: "s1" }),
      op("state.get", { key: "answer" }),
    ];
    const repeated = [trace(workflow), trace(workflow), trace(workflow)];
    const proposals = proposeEntropyReductions({
      report: measureEntropy({ traces: repeated }),
      traces: repeated,
    });
    expect(proposals).toEqual([
      expect.objectContaining({
        kind: "sequence-fuse",
        sequence: ["memory.recall", "memory.expand", "state.get"],
        occurrences: 3,
      }),
    ]);

    const oneExecution = trace([...workflow, ...workflow]);
    expect(
      proposeEntropyReductions({
        report: measureEntropy({ traces: [oneExecution] }),
        traces: [oneExecution],
      }),
    ).toEqual([]);

    const repeatedRefWorkflow = Array.from({ length: 3 }, () =>
      trace([
        op("extensions.fovea_sketch", {}),
        op("extensions.fovea_focus", {}),
        op("extensions.fovea_focus", {}),
      ]),
    );
    expect(
      proposeEntropyReductions({
        report: measureEntropy({ traces: repeatedRefWorkflow }),
        traces: repeatedRefWorkflow,
      }),
    ).toEqual([]);
  });


});
