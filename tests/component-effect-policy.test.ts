import { describe, expect, it } from "vitest";
import { actionEffect, compareEffectInfo, effectConflictsBetween, registrationEffect, summarizeEffects, trackedRegistration } from "../src/components/effect-policy.js";
import type { FabricComponentEffectInfo } from "../src/components/types.js";

const effect = (resources: string[], ordering: "commutative" | "unknown" = "unknown"): FabricComponentEffectInfo => ({ label: "effect", kind: "transactional", resources, ordering });
const conflicts = (left: FabricComponentEffectInfo[], right: FabricComponentEffectInfo[]) => effectConflictsBetween(summarizeEffects(left), summarizeEffects(right));

describe("component effect policy", () => {
  it("normalizes registrations with bounded resources and conservative defaults", () => {
    expect(trackedRegistration("named", "fallback")).toEqual({ label: "named" });
    expect(registrationEffect(trackedRegistration(undefined, "fallback"))).toEqual({ label: "fallback", kind: "transactional", resources: ["*"], ordering: "unknown" });
    const normalized = registrationEffect({ label: " named ", resources: ["", "a", "a", "x".repeat(300)] });
    expect(normalized.label).toBe("named");
    expect(normalized.resources).toEqual(["a", "x".repeat(256)]);
    expect(registrationEffect({ resources: Array.from({ length: 70 }, (_, index) => String(index)) }).resources).toHaveLength(64);
  });

  it("ignores read-only actions and projects effectful action metadata", () => {
    const base = { provider: "demo", ref: "demo.read", name: "read", description: "Read", inputSchema: {}, risk: "read" as const };
    expect(actionEffect({ ...base, effect: { kind: "none", ordering: "commutative" } })).toBeUndefined();
    expect(actionEffect({ ...base, effect: { kind: "emission", ordering: "unknown" } })).toEqual({ label: "demo.read", kind: "emission", resources: ["*"], ordering: "unknown" });
  });

  it("distinguishes disjoint, shared, unknown and commutative footprints", () => {
    expect(conflicts([effect(["a"])], [effect(["b"])])).toEqual([]);
    expect(conflicts([effect(["b", "a"])], [effect(["a", "b"])])).toEqual([{ resources: ["a", "b"], reason: "shared_resource" }]);
    expect(conflicts([effect(["*"])], [effect(["b"])])).toEqual([{ resources: ["*"], reason: "unknown_resource" }]);
    expect(conflicts([effect(["*"], "commutative")], [effect(["b"], "commutative")])).toEqual([]);
    expect(conflicts([], [effect(["*"])])).toEqual([]);
    expect(conflicts([{ ...effect(["*"]), kind: "none" }], [effect(["a"])])).toEqual([]);
  });

  it("preserves conflict symmetry across mixed summaries", () => {
    const samples = [[], [effect(["a"])], [effect(["*"])], [effect(["a"], "commutative")], [effect(["*"], "commutative"), effect(["a"])], [effect(["b"]), effect(["a"], "commutative")]];
    for (const left of samples) for (const right of samples) expect(conflicts(left, right)).toEqual(conflicts(right, left));
  });

  it("orders snapshots deterministically without mutating effects", () => {
    const values = [{ ...effect(["b"]), label: "z" }, { ...effect(["a"]), label: "a" }];
    expect([...values].sort(compareEffectInfo).map((value) => value.label)).toEqual(["a", "z"]);
    expect(values[0]?.label).toBe("z");
  });
});
