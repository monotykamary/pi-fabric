import { describe, expect, it } from "vitest";
import {
  applyNormalFormPlan, compileEntropySurface, emptyCompiledSurface, runEntropyTrial,
  type CompiledSurfaceFile, type EntropySurfaceSnapshot, type EntropyTraceInput,
} from "../src/entropy/index.js";

const ref = "mcp.report.render";
const schema = {
  type: "object", additionalProperties: false,
  properties: {
    outputFormat: { type: "string", enum: ["pdf", "html", "rare-format"] },
    limit: { type: "integer", minimum: 1 }, note: { type: "string" },
  }, required: ["outputFormat", "limit"],
};
const live: EntropySurfaceSnapshot = { version: 1, actions: [{ ref, inputSchema: schema }] };
const artifact = () => compileEntropySurface({ traces: [], surface: live }).artifact!;
const traces = (args: Record<string, unknown>[], outcome: "failed" | "succeeded" = "failed"): EntropyTraceInput[] =>
  [{ operations: args.map((args) => ({ ref, args, outcome, failureStage: "validate" })) }];
const canonical = { outputFormat: "rare-format", limit: 2 };
const spelling = { "output-format": "RARE FORMAT", limit: "2", note: null };

describe("normal-form trial", () => {
  it("counts invalid representation normalization without inventing operation success", () => {
    const input = { live, artifact: artifact(), traces: traces([spelling, canonical, { ...canonical, limit: "02" }]) };
    const before = JSON.stringify(input);
    const report = runEntropyTrial(input);
    expect(report.totals).toEqual({
      operations: 3, bothAccept: 1, bothReject: 1, normalizationWin: 1,
      canonicalIdentityChecks: 1, canonicalIdentityCost: 0, idempotenceCost: 0,
      tighteningCost: 0, typedFailureWin: 0, quarantineWin: 0, quarantineCost: 0,
    });
    expect(report).toMatchObject({ verdict: "clean", declaredScore: 1, effectiveScore: 1, delta: 0 });
    expect(report.divergences).toEqual([{ ref, trialClass: "normalization-win", count: 1 }]);
    expect(JSON.stringify(runEntropyTrial(input))).toBe(JSON.stringify(report));
    expect(JSON.stringify(input)).toBe(before);
  });

  it("prefers verbatim audits by ref, preserving fallback for unaudited refs", () => {
    const other = "pi.other";
    const report = runEntropyTrial({
      live: { version: 1, actions: [...live.actions, { ref: other, inputSchema: schema }] },
      artifact: artifact(),
      traces: [{ operations: [
        ...traces([{}, {}, {}], "succeeded")[0]!.operations,
        { ref: other, args: canonical, outcome: "succeeded" },
        { ref: "unknown", args: {}, outcome: "failed" },
        { ref: "fabric.discovery.search", args: {}, outcome: "succeeded" },
      ] }],
      auditCalls: [{ ref, args: canonical }, { ref, args: spelling }],
    });
    expect(report.totals).toMatchObject({ operations: 3, bothAccept: 2, bothReject: 0, normalizationWin: 1 });
    expect(report.effectiveScore).toBe(report.declaredScore);
  });

  it("preserves every canonical enum member and direct normalizer identity/idempotence", () => {
    const plan = artifact().normalizations![0]!;
    for (const outputFormat of schema.properties.outputFormat.enum) {
      const args = { outputFormat, limit: 1 };
      expect(applyNormalFormPlan(ref, schema, args, plan)).toEqual({ args });
      expect(applyNormalFormPlan(ref, schema, args, plan).args).toBe(args);
    }
    const once = applyNormalFormPlan(ref, schema, spelling, plan);
    expect(once.args).toEqual(canonical);
    expect(applyNormalFormPlan(ref, schema, once.args, plan)).toEqual({ args: once.args });
    expect(runEntropyTrial({ live, artifact: artifact(), traces: traces([spelling]) }).totals.normalizationWin).toBe(1);
  });

  it("refuses ambiguous aliases, lossy numbers and partial repairs", () => {
    const args = [
      { ...canonical, "output-format": "PDF" },
      { "output-format": "PDF", "output_format": "HTML", limit: 1 },
      { ...canonical, limit: "01" }, { ...canonical, limit: "9007199254740993" },
      { ...spelling, unexpected: true },
    ];
    expect(runEntropyTrial({ live, artifact: artifact(), traces: traces(args) }).totals).toMatchObject({ bothReject: 5, normalizationWin: 0 });
  });

  it("makes legacy restrictions inert, including formerly successful quarantined calls", () => {
    const legacy: CompiledSurfaceFile = {
      ...emptyCompiledSurface(), version: 1, metricVersion: 2,
      actions: [{ ref, inputSchema: { type: "null" }, baseSchemaDigest: "stale" }],
      quarantined: [{ ref, baseSchemaDigest: "stale" }], normalizations: artifact().normalizations!,
    };
    const report = runEntropyTrial({ live, artifact: legacy, traces: traces([canonical, spelling], "succeeded") });
    expect(report).toMatchObject({ verdict: "no-evidence", delta: 0, totals: {
      bothAccept: 1, bothReject: 1, normalizationWin: 0, quarantineWin: 0, quarantineCost: 0, tighteningCost: 0,
    } });
  });

  it("ignores forged and schema-drifted plans", () => {
    const forged = artifact();
    forged.normalizations![0]!.rules.pop();
    for (const input of [
      { live, artifact: forged },
      { live: { version: 1 as const, actions: [{ ref, inputSchema: { ...schema, required: ["note"] } }] }, artifact: artifact() },
    ]) {
      expect(runEntropyTrial({ ...input, traces: traces([spelling]) })).toMatchObject({ verdict: "no-evidence", totals: { normalizationWin: 0, bothReject: 1 } });
    }
  });

  it("reports no evidence with no plans, no calls, or only unrelated calls", () => {
    expect(runEntropyTrial({ live, traces: traces([canonical]) }).verdict).toBe("no-evidence");
    expect(runEntropyTrial({ live, artifact: artifact(), traces: [] }).verdict).toBe("no-evidence");
    expect(runEntropyTrial({ live, artifact: artifact(), traces: [{ operations: [{ ref: "unknown", args: {}, outcome: "succeeded" }] }] }).verdict).toBe("no-evidence");
  });
});
