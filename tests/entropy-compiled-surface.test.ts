import { describe, expect, it } from "vitest";
import { deriveNormalFormPlan, MAX_NORMAL_FORM_PLANS, MAX_NORMAL_FORM_RULES } from "../src/entropy/normal-form.js";
import { parseCompiledSurfaceArtifact } from "../src/entropy/compiled-store.js";
import { emptyCompiledSurface, COMPILED_SURFACE_VERSION } from "../src/entropy/compiled-surface.js";
import {
  applyCompiledSurface,
  comparableCompiledSurfaceScore,
  compiledSurfaceEffectChanged,
  effectiveSchemaFor,
  isQuarantinedRef,
  quarantinedRefNames,
  replaySuccessfulCalls,
  replaySuccessfulCallsAsync,
  schemaDigest,
  type CompiledSurfaceFile,
  type EntropySurfaceSnapshot,
  type EntropyTraceInput,
} from "../src/entropy/index.js";

const liveSurface = (): EntropySurfaceSnapshot => ({
  version: 1,
  actions: [
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
      ref: "mcp.stale.old",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["x"],
        properties: { x: { type: "string" } },
      },
    },
    {
      ref: "memory.recall",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: { query: { type: "string" } },
      },
    },
  ],
});

const compiledArtifact = (live: EntropySurfaceSnapshot): CompiledSurfaceFile => {
  const recall = live.actions.find((action) => action.ref === "memory.recall")!;
  const flaky = live.actions.find((action) => action.ref === "mcp.flaky.run")!;
  return {
    version: 1,
    metricVersion: 2,
    actions: [
      {
        ref: "memory.recall",
        inputSchema: {
          ...(recall.inputSchema as Record<string, unknown>),
          properties: {
            query: { type: "string", enum: ["search", "expand", "recall"] },
          },
        },
        baseSchemaDigest: schemaDigest(recall.inputSchema),
      },
      // A stale overlay whose base no longer matches the live schema.
      {
        ref: "mcp.stale.old",
        inputSchema: { type: "object" },
        baseSchemaDigest: "0".repeat(64),
      },
    ],
    quarantined: [
      { ref: "mcp.flaky.run", baseSchemaDigest: schemaDigest(flaky.inputSchema) },
      // A stale quarantine entry must not hide the ref.
      { ref: "mcp.stale.old", baseSchemaDigest: "deadbeef" },
    ],
    applied: [{ kind: "enum-tighten", ref: "memory.recall", detail: "query: 3 observed values" }],
    gate: { passed: true, beforeScore: 0.25, afterScore: 0.18, reasons: [] },
    evidenceDigest: "abc123",
  };
};

const op = (
  ref: string,
  args: Record<string, unknown>,
  outcome: "succeeded" | "failed" = "succeeded",
): EntropyTraceInput["operations"][number] => ({ ref, args, outcome });

describe("compiled artifact parser", () => {
  const plan = deriveNormalFormPlan("memory.recall", liveSurface().actions[2]!.inputSchema)!;
  const valid = { ...emptyCompiledSurface(), normalizations: [plan] };

  it("accepts bounded v2 plans and retains v1 restrictions only as migration data", () => {
    expect(COMPILED_SURFACE_VERSION).toBe(2);
    expect(parseCompiledSurfaceArtifact(valid)).toEqual(valid);
    const legacy = compiledArtifact(liveSurface());
    expect(parseCompiledSurfaceArtifact(legacy)).toEqual(legacy);
    expect(parseCompiledSurfaceArtifact({ ...valid, normalizations: Array.from({ length: MAX_NORMAL_FORM_PLANS }, (_, i) => ({ ...plan, ref: `demo.action${i}` })) })).toBeDefined();
  });

  it.each([
    { version: 3 }, { normalizations: undefined }, { normalizations: [plan, plan] },
    { normalizations: [{ ...plan, version: 2 }] },
    { normalizations: [{ ...plan, baseSchemaDigest: "forged" }] },
    { normalizations: [{ ...plan, rules: [] }] },
    { normalizations: [{ ...plan, rules: [{ kind: "invented", key: "query" }] }] },
    { normalizations: [{ ...plan, rules: [{ kind: "key-form", key: "__proto__" }] }] },
    { normalizations: [{ ...plan, rules: Array(MAX_NORMAL_FORM_RULES + 1).fill(plan.rules[0]) }] },
    { normalizations: Array.from({ length: MAX_NORMAL_FORM_PLANS + 1 }, (_, i) => ({ ...plan, ref: `demo.action${i}` })) },
    { actions: compiledArtifact(liveSurface()).actions },
    { quarantined: compiledArtifact(liveSurface()).quarantined },
    { metricVersion: 0 }, { gate: { passed: true, beforeScore: Infinity, afterScore: 0, reasons: [] } },
  ])("rejects invalid, duplicate, oversized plans and v2 restrictions (case %#)", patch => {
    expect(parseCompiledSurfaceArtifact({ ...valid, ...patch })).toBeUndefined();
  });

  it("rejects malformed legacy duplicates instead of silently choosing an overlay", () => {
    const legacy = compiledArtifact(liveSurface());
    expect(parseCompiledSurfaceArtifact({ ...legacy, actions: [legacy.actions[0], legacy.actions[0]] })).toBeUndefined();
  });
});

describe("compiled surface preservation", () => {
  it("distinguishes enforcement changes from provenance-only updates", () => {
    const artifact = compiledArtifact(liveSurface());
    const provenanceOnly = {
      ...artifact,
      evidenceDigest: "new evidence",
      gate: { ...artifact.gate, beforeScore: 0.2 },
      applied: [...artifact.applied, { kind: "enum-tighten" as const, ref: "other", detail: "new" }],
    };
    expect(compiledSurfaceEffectChanged(artifact, provenanceOnly)).toBe(false);
    expect(
      compiledSurfaceEffectChanged(artifact, {
        ...provenanceOnly,
        quarantined: provenanceOnly.quarantined.slice(1),
      }),
    ).toBe(false);
    const plan = deriveNormalFormPlan("memory.recall", liveSurface().actions[2]!.inputSchema)!;
    const normalized = { ...emptyCompiledSurface(), normalizations: [plan] };
    expect(compiledSurfaceEffectChanged(artifact, normalized)).toBe(true);
    expect(compiledSurfaceEffectChanged(normalized, emptyCompiledSurface())).toBe(true);
    expect(compiledSurfaceEffectChanged(undefined, emptyCompiledSurface())).toBe(false);
    expect(compiledSurfaceEffectChanged(normalized, { ...normalized, evidenceDigest: "new" })).toBe(false);
  });

  it("yields a baseline score only for comparable current-version artifacts", () => {
    const current = {
      ...emptyCompiledSurface(),
      metricVersion: 7,
      gate: { passed: true, beforeScore: 0.004458, afterScore: 0.004458, reasons: [] },
    };
    expect(comparableCompiledSurfaceScore(current, 7)).toBe(0.004458);
    expect(comparableCompiledSurfaceScore({ ...current, metricVersion: 6 }, 7)).toBeUndefined();
    expect(comparableCompiledSurfaceScore(undefined, 7)).toBeUndefined();
    const legacy = compiledArtifact(liveSurface());
    expect(legacy.version).toBe(1);
    expect(comparableCompiledSurfaceScore(legacy, 7)).toBeUndefined();
  });

  it("preserves digest-matched and stale declarations by identity", () => {
    const live = liveSurface();
    const liveJson = JSON.stringify(live);
    const effective = applyCompiledSurface(live, compiledArtifact(live));
    expect(JSON.stringify(live)).toBe(liveJson);
    expect(effective).toBe(live);
    expect(effective.actions.map((action) => action.ref)).toEqual([
      "mcp.flaky.run", "mcp.stale.old", "memory.recall",
    ]);
    const recall = effective.actions.find((action) => action.ref === "memory.recall")!;
    const schema = recall.inputSchema as Record<string, unknown>;
    const query = (schema.properties as Record<string, { enum?: unknown[] }>).query;
    expect(query?.enum).toBeUndefined();
    const stale = effective.actions.find((action) => action.ref === "mcp.stale.old")!;
    expect(JSON.stringify(stale.inputSchema)).toBe(
      JSON.stringify(liveSurface().actions.find((a) => a.ref === "mcp.stale.old")!.inputSchema),
    );
  });

  it("returns the live surface untouched without an artifact", () => {
    const live = liveSurface();
    expect(applyCompiledSurface(live, undefined)).toBe(live);
    expect(effectiveSchemaFor("memory.recall", { type: "object" }, undefined)).toEqual({
      type: "object",
    });
  });

  it("ignores even digest-matched legacy overlays", () => {
    const live = liveSurface();
    const file = compiledArtifact(live);
    const recallLive = live.actions.find((a) => a.ref === "memory.recall")!.inputSchema;
    expect(effectiveSchemaFor("memory.recall", recallLive, file)).toBe(
      recallLive,
    );
    const staleLive = live.actions.find((a) => a.ref === "mcp.stale.old")!.inputSchema;
    expect(effectiveSchemaFor("mcp.stale.old", staleLive, file)).toBe(staleLive);
  });

  it("never quarantines either matched or stale legacy refs", () => {
    const live = liveSurface();
    const file = compiledArtifact(live);
    const flakyLive = live.actions.find((a) => a.ref === "mcp.flaky.run")!.inputSchema;
    expect(isQuarantinedRef("mcp.flaky.run", flakyLive, file)).toBe(false);
    const staleLive = live.actions.find((a) => a.ref === "mcp.stale.old")!.inputSchema;
    expect(isQuarantinedRef("mcp.stale.old", staleLive, file)).toBe(false);
    expect(quarantinedRefNames(file)).toEqual(new Set());
  });
});

describe("replay preservation", () => {
  it("checks only touched refs and skips failures", () => {
    const live = liveSurface();
    const file = compiledArtifact(live);
    // Exercise the generic replay guard with an explicitly narrowed candidate,
    // not the retired artifact restriction application.
    const effective: EntropySurfaceSnapshot = { version: 1, actions: [{ ref: "memory.recall", inputSchema: file.actions[0]!.inputSchema }] };
    const touched = new Set(["memory.recall", "mcp.flaky.run"]);
    const traces: EntropyTraceInput[] = [
      {
        operations: [
          op("memory.recall", { query: "search" }),
          op("memory.recall", { query: "bogus" }),
          op("memory.recall", { query: "anything" }, "failed"),
          op("mcp.flaky.run", { mode: "fast" }),
          op("mcp.stale.old", { totally: "wrong shape" }),
        ],
      },
    ];
    const violations = replaySuccessfulCalls(effective, live, traces, touched);
    expect(violations).toEqual([
      { ref: "memory.recall", reason: "recorded arguments no longer validate against the compiled schema" },
      { ref: "mcp.flaky.run", reason: "absent from the candidate surface" },
    ]);
  });

  it("replays verbatim audit args when present and ignores projected trace args", () => {
    const live: EntropySurfaceSnapshot = {
      version: 1,
      actions: [
        {
          ref: "mcp.render",
          inputSchema: {
            type: "object",
            properties: { format: { type: "string" } },
            required: ["format"],
            additionalProperties: false,
          },
        },
      ],
    };
    const candidate: EntropySurfaceSnapshot = {
      version: 1,
      actions: [
        {
          ref: "mcp.render",
          inputSchema: {
            type: "object",
            properties: { format: { type: "string", enum: ["pdf", "html"] } },
            required: ["format"],
            additionalProperties: false,
          },
        },
      ],
    };
    const touched = new Set(["mcp.render"]);
    const traces: EntropyTraceInput[] = [{ operations: [op("mcp.render", {})] }];
    expect(
      replaySuccessfulCalls(candidate, live, traces, touched, [
        { ref: "mcp.render", args: { format: "pdf" } },
        { ref: "mcp.render", args: { format: "html" } },
        { ref: "mcp.render", args: { format: 5 } },
      ]),
    ).toEqual([]);
    expect(
      replaySuccessfulCalls(candidate, live, [], touched, [
        { ref: "mcp.render", args: { format: "docx" } },
      ]),
    ).toEqual([
      { ref: "mcp.render", reason: "recorded arguments no longer validate against the compiled schema" },
    ]);
    expect(
      replaySuccessfulCalls({ version: 1, actions: [] }, live, [], touched, [
        { ref: "mcp.render", args: { format: "pdf" } },
      ]),
    ).toEqual([{ ref: "mcp.render", reason: "absent from the candidate surface" }]);
  });
  it("matches pure replay while yielding throughout a large audit corpus", async () => {
    const live: EntropySurfaceSnapshot = {
      version: 1,
      actions: [{
        ref: "mcp.render",
        inputSchema: {
          type: "object",
          properties: { format: { type: "string" } },
          required: ["format"],
          additionalProperties: false,
        },
      }],
    };
    const candidate: EntropySurfaceSnapshot = {
      version: 1,
      actions: [{
        ref: "mcp.render",
        inputSchema: {
          type: "object",
          properties: { format: { type: "string", enum: ["pdf"] } },
          required: ["format"],
          additionalProperties: false,
        },
      }],
    };
    const audits = Array.from({ length: 512 }, (_, index) => ({
      ref: "mcp.render",
      args: { format: index % 2 === 0 ? "pdf" : "docx" },
    }));
    const touched = new Set(["mcp.render"]);
    const expected = replaySuccessfulCalls(candidate, live, [], touched, audits);
    let turns = 0;
    let running = true;
    const pulse = (): void => {
      turns += 1;
      if (running) setImmediate(pulse);
    };
    setImmediate(pulse);
    const actual = await replaySuccessfulCallsAsync(candidate, live, [], touched, audits);
    running = false;
    expect(turns).toBeGreaterThanOrEqual(4);
    expect(actual).toEqual(expected);
  });

});