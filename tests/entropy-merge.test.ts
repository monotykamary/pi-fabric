import { describe, expect, it } from "vitest";
import {
  emptyCompiledSurface, mergeCompiledSurfaces, schemaDigest,
  type CompiledSurfaceFile, type EntropySurfaceSnapshot,
} from "../src/entropy/index.js";
import { deriveNormalFormPlan, MAX_NORMAL_FORM_PLANS, type NormalFormPlan } from "../src/entropy/normal-form.js";

const schema = { type: "object", additionalProperties: false, properties: { outputFormat: { type: "string", enum: ["pdf", "html", "docx"] } }, required: ["outputFormat"] };
const live: EntropySurfaceSnapshot = { version: 1, actions: ["demo.a", "demo.b", "demo.c"].map(ref => ({ ref, inputSchema: schema })) };
const plan = (ref: string) => deriveNormalFormPlan(ref, schema)!;
const artifact = (normalizations: NormalFormPlan[]): CompiledSurfaceFile => ({ ...emptyCompiledSurface(), normalizations });
const legacy = (): CompiledSurfaceFile => ({ ...emptyCompiledSurface(), version: 1,
  actions: [
    { ref: "demo.a", inputSchema: { type: "object" }, baseSchemaDigest: schemaDigest(schema) },
    { ref: "demo.b", inputSchema: {}, baseSchemaDigest: "stale" },
  ],
  quarantined: [{ ref: "demo.c", baseSchemaDigest: schemaDigest(schema) }],
  applied: [{ kind: "enum-tighten", ref: "demo.a", detail: "old restriction" }],
});

describe("mergeCompiledSurfaces", () => {
  it("drops every local and incoming legacy restriction including digest matches", () => {
    const merged = mergeCompiledSurfaces(legacy(), legacy(), live);
    expect(merged.file).toMatchObject({ version: 2, actions: [], quarantined: [], normalizations: [], applied: [] });
    expect(merged.droppedOverlays).toBe(4);
    expect(merged.droppedQuarantines).toBe(2);
    expect(merged.droppedNormalizations).toBe(0);
    expect(mergeCompiledSurfaces(undefined, legacy(), live).droppedOverlays).toBe(2);
  });

  it("accepts only exact rederived plans, merges sorted and deduplicated, and rebuilds provenance", () => {
    const a = plan("demo.a");
    const b = plan("demo.b");
    const local = artifact([b]);
    const incoming = { ...artifact([a, b]), gate: { passed: false, beforeScore: 99, afterScore: 100, reasons: ["untrusted"] }, evidenceDigest: "peer", applied: [{ kind: "noise-quarantine" as const, ref: "demo.a", detail: "untrusted" }] };
    const merged = mergeCompiledSurfaces(local, incoming, live);
    expect(merged.file.normalizations).toEqual([a, b]);
    expect(merged.file.actions).toEqual([]);
    expect(merged.file.quarantined).toEqual([]);
    expect(merged.file.applied.map(p => p.kind)).toEqual(["normal-form", "normal-form"]);
    expect(merged.file.gate).toEqual(emptyCompiledSurface().gate);
    expect(merged.file.evidenceDigest).not.toBe("peer");
    expect(merged.droppedNormalizations).toBe(0);
    expect(mergeCompiledSurfaces(undefined, artifact([a]), live).file.normalizations).toEqual([a]);
  });

  it("rejects forged targets, omitted/extra/reordered rules, unknown refs and live drift despite matching digest", () => {
    const a = plan("demo.a");
    const forged: NormalFormPlan[] = [
      { ...a, rules: a.rules.slice(1) },
      { ...a, rules: [...a.rules].reverse() },
      { ...a, rules: [...a.rules, { kind: "numeric-string", key: "outputFormat" }] },
      { ...a, rules: [{ kind: "key-form", key: "other" }] },
      { ...a, baseSchemaDigest: "0".repeat(64) },
      plan("missing.action"),
    ];
    const merged = mergeCompiledSurfaces(artifact(forged.slice(0, 2)), artifact(forged.slice(2)), live);
    expect(merged.droppedNormalizations).toBe(forged.length);
    expect(merged.file.normalizations).toEqual([]);
    const drift: EntropySurfaceSnapshot = { version: 1, actions: [{ ref: a.ref, inputSchema: { ...schema, required: [] } }] };
    expect(mergeCompiledSurfaces(undefined, artifact([a]), drift).droppedNormalizations).toBe(1);
  });

  it("does not let a stale local plan or legacy quarantine block a proven incoming plan", () => {
    const a = plan("demo.a");
    const merged = mergeCompiledSurfaces(artifact([{ ...a, baseSchemaDigest: "0".repeat(64) }]), artifact([a]), live);
    expect(merged.file.normalizations).toEqual([a]);
    expect(merged.droppedNormalizations).toBe(1);
    expect(mergeCompiledSurfaces(legacy(), artifact([plan("demo.c")]), live).file.normalizations).toEqual([plan("demo.c")]);
  });

  it("is deterministic, idempotent and independent of valid incoming order", () => {
    const incoming = artifact([plan("demo.b"), plan("demo.a")]);
    const first = mergeCompiledSurfaces(undefined, incoming, live);
    expect(mergeCompiledSurfaces(undefined, incoming, live)).toEqual(first);
    expect(mergeCompiledSurfaces(undefined, artifact([...incoming.normalizations!].reverse()), live).file).toEqual(first.file);
    expect(mergeCompiledSurfaces(first.file, incoming, live).file).toEqual(first.file);
  });

  it("bounds the merged plan union", () => {
    const actions = Array.from({ length: MAX_NORMAL_FORM_PLANS + 1 }, (_, i) => ({ ref: `demo.action${i}`, inputSchema: schema }));
    const plans = actions.map(a => plan(a.ref));
    const result = mergeCompiledSurfaces(artifact(plans.slice(0, 500)), artifact(plans.slice(500)), { version: 1, actions });
    expect(result.file.normalizations).toHaveLength(MAX_NORMAL_FORM_PLANS);
    expect(result.file.applied.length).toBeLessThanOrEqual(256);
  });
});
