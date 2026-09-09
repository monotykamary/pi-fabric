import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stableJsonHash, stableJsonHashArrayAsync } from "../src/core/stable-hash.js";
import {
  compileEntropySurface, compileEntropySurfaceAsync, entropyReviewSignals,
  formatEntropyReviewSignal, loadCompiledSurface, loadCompiledSurfaceAsync,
  measureEntropy, saveCompiledSurface, saveCompiledSurfaceAsync, schemaDigest,
  applyCompiledSurface, effectiveSchemaFor, emptyCompiledSurface,
  type CompiledSurfaceFile, type EntropySurfaceSnapshot, type EntropyTraceInput,
} from "../src/entropy/index.js";
import { AUTO_APPLY_PROPOSAL_KINDS } from "../src/entropy/compiler.js";
import { applyNormalFormPlan, deriveNormalFormPlan } from "../src/entropy/normal-form.js";
import { compiledSurfaceDirectory, parseCompiledSurfaceArtifact } from "../src/entropy/compiled-store.js";

const tmpRoots: string[] = [];
const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-entropy-compiler-"));
  tmpRoots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const ref = "mcp.report.render";
const schema = { type: "object", additionalProperties: false, required: ["format"], properties: {
  format: { type: "string", enum: ["docx", "html", "pdf", "web"] },
} };
const surface: EntropySurfaceSnapshot = { version: 1, actions: [
  { ref, inputSchema: schema },
  { ref: "mcp.flaky.run", inputSchema: { type: "object", additionalProperties: false, required: ["mode"], properties: { mode: { type: "string" } } } },
] };
const traces: EntropyTraceInput[] = [{ operations: [
  ...Array.from({ length: 8 }, () => ({ ref, args: { format: "pdf" }, outcome: "succeeded" as const })),
  { ref, args: { format: "html" }, outcome: "succeeded" },
  { ref: "mcp.flaky.run", args: {}, outcome: "failed", failureStage: "validate" },
  { ref: "mcp.flaky.run", args: {}, outcome: "failed", failureStage: "invoke" },
] }];
const legacy = (): CompiledSurfaceFile => ({ ...emptyCompiledSurface(), version: 1,
  actions: [{ ref, baseSchemaDigest: schemaDigest(schema), inputSchema: { ...schema, properties: { format: { type: "string", enum: ["pdf", "html"] } } } }],
  quarantined: [{ ref: "mcp.flaky.run", baseSchemaDigest: schemaDigest(surface.actions[1]!.inputSchema) }],
});

describe("static normal-form compiler", () => {
  it("compiles v2 proven plans, never restrictions or counterfactual score improvements", () => {
    const outcome = compileEntropySurface({ surface, traces });
    expect(AUTO_APPLY_PROPOSAL_KINDS).toEqual(["normal-form"]);
    expect(outcome.status).toBe("compiled");
    expect(outcome.report.score).toBe(measureEntropy({ surface, traces }).score);
    expect(outcome.report.totals.invocationRejections).toBe(1);
    expect(outcome.after).toEqual(outcome.report);
    expect(outcome.gate).toEqual({ passed: true, beforeScore: outcome.report.score, afterScore: outcome.report.score, delta: 0, reasons: [] });
    expect(outcome.artifact).toMatchObject({ version: 2, actions: [], quarantined: [] });
    expect(outcome.artifact!.normalizations).toEqual([...surface.actions].sort((a, b) => a.ref.localeCompare(b.ref)).map(a => deriveNormalFormPlan(a.ref, a.inputSchema)));
    expect(outcome.artifact!.applied.every(p => p.kind === "normal-form")).toBe(true);
    expect(parseCompiledSurfaceArtifact(outcome.artifact)).toEqual(outcome.artifact);
  });

  it("preserves rare docx and all actions after pdf/html dominance and repeated failures", () => {
    const outcome = compileEntropySurface({ surface, traces, valueObservations: [
      { ref, key: "format", value: "pdf", count: 10000 }, { ref, key: "format", value: "html", count: 1000 },
    ] });
    expect(applyCompiledSurface(surface, outcome.artifact)).toBe(surface);
    expect(effectiveSchemaFor(ref, schema, outcome.artifact)).toBe(schema);
    const args = { format: "docx" };
    expect(applyNormalFormPlan(ref, schema, args, outcome.artifact!.normalizations!.find(p => p.ref === ref))).toEqual({ args });
    expect(applyNormalFormPlan(ref, schema, args, outcome.artifact!.normalizations!.find(p => p.ref === ref)).args).toBe(args);
  });

  it("derives the same effect and digest from empty, projected, contradictory and reordered observations", () => {
    const baseline = compileEntropySurface({ surface, traces: [] });
    expect(baseline.status).toBe("compiled");
    for (const input of [
      { surface, traces },
      { surface, traces: traces.map(t => ({ ...t, operations: [...t.operations].reverse() })) },
      { surface, traces: [{ operations: [{ ref, args: {}, outcome: "succeeded" as const }] }], valueObservations: [{ ref, key: "format", value: "pdf", count: 999 }] },
      { surface, traces, auditCalls: [{ ref, args: { format: "web" } }], repairs: [{ kind: "keyAlias" as const, ref, from: "notAnAlias", to: "format" }] },
    ]) {
      const outcome = compileEntropySurface(input);
      expect(outcome.status).toBe("compiled");
      expect(outcome.artifact!.normalizations).toEqual(baseline.artifact!.normalizations);
      expect(outcome.artifact!.evidenceDigest).toBe(baseline.artifact!.evidenceDigest);
      expect(outcome.artifact!.actions).toEqual([]);
      expect(outcome.artifact!.quarantined).toEqual([]);
    }
  });

  it("sorts plans independently of declaration order", () => {
    const first = compileEntropySurface({ surface, traces: [] });
    const reversed = compileEntropySurface({ surface: { ...surface, actions: [...surface.actions].reverse() }, traces: [] });
    expect(reversed.artifact!.normalizations).toEqual(first.artifact!.normalizations);
  });

  it("converges on the identical second compile without rewriting the artifact", () => {
    const first = compileEntropySurface({ surface, traces });
    const second = compileEntropySurface({ surface, traces, artifact: first.artifact! });
    expect(second.status).toBe("converged");
    expect(second.artifact).toBe(first.artifact);
    expect(second.gate).toBeUndefined();
    expect(second.proposals.some(p => p.kind === "normal-form")).toBe(false);
    expect(compileEntropySurface({ surface: { version: 1, actions: [] }, traces: [] }).status).toBe("converged");
  });

  it("migrates readable legacy restrictions rather than keeping an enum floor or quarantine", () => {
    const incumbent = parseCompiledSurfaceArtifact(legacy())!;
    expect(incumbent.version).toBe(1);
    const outcome = compileEntropySurface({ surface, traces, artifact: incumbent });
    expect(outcome.status).toBe("compiled");
    expect(outcome.artifact).toMatchObject({ version: 2, actions: [], quarantined: [] });
    expect(outcome.artifact!.normalizations).toEqual(compileEntropySurface({ surface, traces: [] }).artifact!.normalizations);
    expect(incumbent.actions).toHaveLength(1);
    expect(compileEntropySurface({ surface: { version: 1, actions: [] }, traces: [], artifact: incumbent }).artifact).toMatchObject({ version: 2, actions: [], quarantined: [], normalizations: [] });
  });

  it("keeps the hook-safe compiler deterministic while yielding", async () => {
    const large: EntropySurfaceSnapshot = { version: 1, actions: Array.from({ length: 96 }, (_, i) => ({ ref: `demo.action${i}`, inputSchema: schema })) };
    let yielded = false;
    setImmediate(() => { yielded = true; });
    const outcome = await compileEntropySurfaceAsync({ surface: large, traces });
    expect(yielded).toBe(true);
    expect(outcome).toEqual(compileEntropySurface({ surface: large, traces }));
  });

  it("hashes large evidence arrays cooperatively without changing canonical bytes", async () => {
    const values = Array.from({ length: 512 }, (_, index) => ({ z: index, nested: { b: index % 3, a: `value-${index}` } }));
    let turns = 0;
    let running = true;
    const pulse = (): void => { turns++; if (running) setImmediate(pulse); };
    setImmediate(pulse);
    const actual = await stableJsonHashArrayAsync(values);
    running = false;
    expect(turns).toBeGreaterThanOrEqual(4);
    expect(actual).toBe(stableJsonHash(values));
  });
});

describe("compiled surface store", () => {
  it("round-trips v2 and legacy artifacts and no-ops identical sync/async writes", async () => {
    for (const artifact of [compileEntropySurface({ surface, traces }).artifact!, legacy()]) {
      const agentDir = makeTempDir();
      expect(compiledSurfaceDirectory(agentDir)).toBe(path.join(agentDir, "fabric", "entropy"));
      expect(loadCompiledSurface(agentDir)).toEqual({});
      expect(await loadCompiledSurfaceAsync(agentDir)).toEqual({});
      expect(saveCompiledSurface(agentDir, artifact).written).toBe(true);
      expect(loadCompiledSurface(agentDir).file).toEqual(parseCompiledSurfaceArtifact(artifact));
      expect(saveCompiledSurface(agentDir, artifact).written).toBe(false);
      expect((await saveCompiledSurfaceAsync(agentDir, artifact)).written).toBe(false);
      expect(await loadCompiledSurfaceAsync(agentDir)).toEqual(loadCompiledSurface(agentDir));
    }
    const dir = makeTempDir();
    const artifact = emptyCompiledSurface();
    expect((await saveCompiledSurfaceAsync(dir, artifact)).written).toBe(true);
    expect(loadCompiledSurface(dir)).toEqual({ file: artifact });
  });

  it.each([['{ nope', "malformed JSON"], ['{}', "invalid"]])("surfaces damage and blocks both overwrite paths: %s", async (raw, reason) => {
    const dir = makeTempDir();
    const artifact = emptyCompiledSurface();
    saveCompiledSurface(dir, artifact);
    const file = path.join(compiledSurfaceDirectory(dir), "compiled.json");
    fs.writeFileSync(file, raw);
    expect(loadCompiledSurface(dir).error).toBe(`compiled surface is ${reason}`);
    expect(await loadCompiledSurfaceAsync(dir)).toEqual(loadCompiledSurface(dir));
    expect(() => saveCompiledSurface(dir, artifact)).toThrow(reason);
    await expect(saveCompiledSurfaceAsync(dir, artifact)).rejects.toThrow(reason);
    expect(fs.readFileSync(file, "utf8")).toBe(raw);
  });
});

describe("entropyReviewSignals", () => {
  it("excludes auto kinds and repair aliases from the review queue", () => {
    expect(entropyReviewSignals({ surface, traces, report: measureEntropy({ surface, traces }), repairs: [{ kind: "keyAlias", ref, from: "Format", to: "format" }] })).toEqual([]);
  });

  it("surfaces marked declare-enum domains for review only", () => {
    const marked: EntropySurfaceSnapshot = { version: 1, actions: [{ ref, inputSchema: { ...schema, properties: { format: { type: "string", "x-fabric-enum-candidate": true } } } }] };
    const review = entropyReviewSignals({ surface: marked, traces, report: measureEntropy({ surface: marked, traces }) });
    expect(review).toHaveLength(1);
    expect(formatEntropyReviewSignal(review[0]!)).toBe(`declare-enum ${ref}.format (pdf, html)`);
  });

  it("formats structural signals, fallback and truncated vocabularies", () => {
    expect(formatEntropyReviewSignal({ kind: "sequence-fuse", sequence: ["pi.read", "pi.edit"], occurrences: 2 })).toBe("sequence-fuse pi.read -> pi.edit");
    expect(formatEntropyReviewSignal({ kind: "declare-enum", ref, key: "format", values: ["a", "b", "c", "d", "e"], calls: 20, distinct: 5, topShare: 0.5 })).toBe(`declare-enum ${ref}.format (a, b, c, d, ...)`);
    expect(formatEntropyReviewSignal({ kind: "normal-form", ref, baseSchemaDigest: schemaDigest(schema), rules: [] })).toBe(`normal-form ${ref}`);
    expect(formatEntropyReviewSignal({ kind: "overload-split", ref, shapeEntropyBits: 1, clusters: [{ keys: ["a"], calls: 4 }, { keys: ["b"], calls: 4 }] })).toBe(`overload-split ${ref} (2 key-set clusters)`);
  });
});
