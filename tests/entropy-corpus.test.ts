import { describe, expect, it } from "vitest";
import {
  entropyAuditCallsFromSessionJsonl,
  entropyRepairRows,
  entropyTraceFromFabricTrace,
  entropyTracesFromSessionJsonl,
  entropyValueObservationsFromSessionJsonl,
  measureEntropy,
  proposeEntropyReductions,
} from "../src/entropy/index.js";
import type { FabricExecutionTraceV1 } from "../src/audit/trace.js";
import type { CatalogRepair } from "../src/repairs/types.js";

const fabricTrace = (phases: string[]): FabricExecutionTraceV1 => ({
  kind: "pi-fabric.execution",
  version: 1,
  outcome: "succeeded",
  phases,
  operations: [
    {
      type: "call",
      sequence: 0,
      ref: "pi.read",
      args: { path: "src/a.ts", limit: 10 },
      outcome: "succeeded",
    },
    {
      type: "call",
      sequence: 1,
      ref: "pi.bash",
      args: { command: "ls" },
      outcome: "failed",
      failureStage: "invoke",
      error: "boom",
    },
  ],
  counts: { droppedValues: 0, truncatedValues: 0, redactedValues: 0, droppedOperations: 0 },
});

describe("entropyTraceFromFabricTrace", () => {
  it("maps operations and derives the task key from the first phase", () => {
    const mapped = entropyTraceFromFabricTrace(fabricTrace(["build"]));
    expect(mapped.taskKey).toBe("build");
    expect(mapped.operations).toHaveLength(2);
    expect(mapped.operations[1]).toMatchObject({
      ref: "pi.bash",
      outcome: "failed",
      failureStage: "invoke",
    });
  });

  it("falls back to the default task key without phases", () => {
    expect(entropyTraceFromFabricTrace(fabricTrace([])).taskKey).toBe("(none)");
  });
});

describe("entropyTracesFromSessionJsonl", () => {
  it("skips malformed and non-trace lines and ingests guarded envelopes", () => {
    const envelope = fabricTrace(["build"]);
    const lines = [
      "{ not json",
      JSON.stringify({
        id: "e0",
        type: "message",
        message: { role: "user", content: "hi" },
      }),
      JSON.stringify({
        id: "e1",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "fabric_exec",
          content: [{ type: "text", text: "ok" }],
          details: { success: true, trace: envelope, audits: [], phases: ["build"] },
        },
      }),
      "",
    ]
      .join("\n")
      .split("\n");
    const traces = entropyTracesFromSessionJsonl(lines);
    expect(traces).toHaveLength(1);
    const report = measureEntropy({ traces });
    expect(report.totals.operations).toBe(2);
    expect(report.totals.succeeded).toBe(1);
    expect(report.totals.failed).toBe(1);
  });
});

describe("entropyRepairRows", () => {
  it("normalizes key and action aliases to their target refs", () => {
    const repairs: CatalogRepair[] = [
      { kind: "keyAlias", ref: "memory.expand", from: "sessionId", to: "session" },
      { kind: "actionAlias", provider: "memory", from: "expandEntry", to: "expand" },
    ];
    expect(entropyRepairRows(repairs)).toEqual([
      { kind: "keyAlias", ref: "memory.expand", from: "sessionId", to: "session" },
      { kind: "actionAlias", ref: "memory.expand", from: "expandEntry", to: "expand" },
    ]);
  });
});

describe("entropyAuditCallsFromSessionJsonl", () => {
  it("extracts one verbatim call per persisted audit and skips malformed entries", () => {
    const lines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          details: {
            trace: fabricTrace(["build"]),
            audits: [
              { ref: "pi.read", args: { path: "src/a.ts", limit: 10 } },
              { ref: "mcp.render", args: { format: "pdf" } },
              "not a record",
              { ref: 5, args: {} },
              { ref: "mcp.broken", args: "not a record" },
            ],
          },
        },
      }),
    ];
    expect(entropyAuditCallsFromSessionJsonl(lines)).toEqual([
      { ref: "pi.read", args: { path: "src/a.ts", limit: 10 } },
      { ref: "mcp.render", args: { format: "pdf" } },
    ]);
  });
});

describe("validate-rejected attempts", () => {
  it("pools attempt audits like failed calls: args join the value corpus and the replay corpus", () => {
    const lines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          details: {
            trace: fabricTrace(["build"]),
            audits: [
              {
                ref: "memory.recall",
                args: { role: "toolResult" },
                success: false,
                error: "Invalid arguments for memory.recall: role must be equal to one of the allowed values",
              },
            ],
            phases: ["build"],
          },
        },
      }),
    ];
    expect(entropyValueObservationsFromSessionJsonl(lines)).toEqual([
      { ref: "memory.recall", key: "role", value: "toolResult" },
    ]);
    expect(entropyAuditCallsFromSessionJsonl(lines)).toEqual([
      { ref: "memory.recall", args: { role: "toolResult" } },
    ]);
  });
});

describe("entropyValueObservationsFromSessionJsonl", () => {
  it("extracts verbatim audit values for an explicitly marked enum candidate", () => {
    const formats = ["pdf", "pdf", "pdf", "pdf", "pdf", "pdf", "pdf", "html"];
    const envelope: FabricExecutionTraceV1 = {
      kind: "pi-fabric.execution",
      version: 1,
      outcome: "succeeded",
      phases: ["build"],
      operations: formats.map((_, index) => ({
        type: "call" as const,
        sequence: index,
        ref: "mcp.report.render",
        args: {},
        outcome: "succeeded" as const,
      })),
      counts: { droppedValues: 0, truncatedValues: 0, redactedValues: 0, droppedOperations: 0 },
    };
    const audits = formats.map((format) => ({
      ref: "mcp.report.render",
      args: { format },
    }));
    const lines = JSON.stringify({
      id: "e1",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "fabric_exec",
        content: [{ type: "text", text: "ok" }],
        details: { success: true, trace: envelope, audits, phases: ["build"] },
      },
    }).split("\n");
    const traces = entropyTracesFromSessionJsonl(lines);
    const observations = entropyValueObservationsFromSessionJsonl(lines);
    expect(observations).toHaveLength(8);
    expect(observations[0]).toEqual({
      ref: "mcp.report.render",
      key: "format",
      value: "pdf",
    });
    const surface = {
      version: 1 as const,
      actions: [
        {
          ref: "mcp.report.render",
          inputSchema: {
            type: "object",
            properties: {
              format: { type: "string", "x-fabric-enum-candidate": true },
            },
            additionalProperties: false,
          },
        },
      ],
    };
    const report = measureEntropy({ traces, surface });
    expect(proposeEntropyReductions({ report, traces, surface }).every((proposal) => proposal.kind === "normal-form")).toBe(true);
    const proposals = proposeEntropyReductions({
      report,
      traces,
      surface,
      valueObservations: observations,
    });
    expect(proposals.filter((proposal) => proposal.kind === "declare-enum")).toHaveLength(1);
    expect(proposals.find((proposal) => proposal.kind === "declare-enum")).toMatchObject({
      kind: "declare-enum",
      ref: "mcp.report.render",
      key: "format",
      values: ["pdf", "html"],
      calls: 8,
      distinct: 2,
      topShare: 0.875,
    });
  });
});
