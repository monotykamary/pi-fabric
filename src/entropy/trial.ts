// Offline representation replay, not execution: a validation win says nothing
// about whether the historical operation would have succeeded.
import { Value } from "typebox/value";
import { COMPILED_SURFACE_VERSION, type CompiledSurfaceFile } from "./compiled-surface.js";
import { compareCodeUnits } from "./fingerprint.js";
import { measureEntropy } from "./meter.js";
import { applyNormalFormPlan, provesNormalFormPlan, type NormalFormPlan } from "./normal-form.js";
import { entropySurfaceHash } from "./surface.js";
import type { EntropyAuditCall, EntropySurfaceSnapshot, EntropyTraceInput } from "./types.js";

// Legacy classes/fields remain readable; restriction wins are never emitted.
export type EntropyTrialClass =
  | "both-accept" | "both-reject" | "normalization-win"
  | "tightening-cost" | "typed-failure-win" | "quarantine-win" | "quarantine-cost";
export interface EntropyTrialTotals {
  operations: number;
  bothAccept: number;
  bothReject: number;
  normalizationWin: number;
  canonicalIdentityChecks: number;
  canonicalIdentityCost: number;
  idempotenceCost: number;
  tighteningCost: number;
  typedFailureWin: number;
  quarantineWin: number;
  quarantineCost: number;
}
export interface EntropyTrialDivergence { ref: string; trialClass: EntropyTrialClass; count: number }
export type EntropyTrialVerdict = "no-evidence" | "clean" | "costly";
export interface EntropyTrialReport {
  verdict: EntropyTrialVerdict;
  /** Historical invocation rejection rate; normalization never rewrites outcomes. */
  declaredScore: number;
  effectiveScore: number;
  delta: number;
  totals: EntropyTrialTotals;
  divergences: EntropyTrialDivergence[];
}
const accepts = (schema: unknown, args: Record<string, unknown>): boolean => {
  try { return typeof schema === "object" && schema !== null && Value.Check(schema, args); }
  catch { return false; }
};

export const runEntropyTrial = (input: {
  traces: readonly EntropyTraceInput[];
  live: EntropySurfaceSnapshot;
  artifact?: CompiledSurfaceFile;
  auditCalls?: readonly EntropyAuditCall[];
}): EntropyTrialReport => {
  const schemas = new Map(input.live.actions.map((action) => [action.ref, action.inputSchema]));
  const plans = new Map<string, NormalFormPlan>();
  if (input.artifact?.version === COMPILED_SURFACE_VERSION) {
    for (const plan of input.artifact.normalizations ?? []) {
      if (provesNormalFormPlan(plan, schemas.get(plan.ref))) plans.set(plan.ref, plan);
    }
  }
  const report = measureEntropy({ traces: input.traces, surface: input.live, catalogDigest: entropySurfaceHash(input.live) });
  const totals: EntropyTrialTotals = {
    operations: 0, bothAccept: 0, bothReject: 0, normalizationWin: 0,
    canonicalIdentityChecks: 0, canonicalIdentityCost: 0, idempotenceCost: 0,
    tighteningCost: 0, typedFailureWin: 0, quarantineWin: 0, quarantineCost: 0,
  };
  const divergences = new Map<string, EntropyTrialDivergence>();
  let plannedOperations = 0;
  const record = (ref: string, args: Record<string, unknown>): void => {
    if (ref.startsWith("fabric.discovery.") || ref.startsWith("fabric.workflow.")) return;
    const schema = schemas.get(ref);
    if (schema === undefined) return;
    const plan = plans.get(ref);
    if (plan) plannedOperations++;
    const before = accepts(schema, args);
    const normalized = applyNormalFormPlan(ref, schema, args, plan);
    const after = accepts(schema, normalized.args);
    totals.operations++;
    if (before) {
      totals.canonicalIdentityChecks++;
      if (normalized.args !== args || normalized.witness) totals.canonicalIdentityCost++;
    }
    const twice = applyNormalFormPlan(ref, schema, normalized.args, plan);
    if (twice.args !== normalized.args || twice.witness) totals.idempotenceCost++;
    let trialClass: EntropyTrialClass;
    if (before && !after) { totals.tighteningCost++; trialClass = "tightening-cost"; }
    else if (before) { totals.bothAccept++; trialClass = "both-accept"; }
    else if (after && normalized.witness) { totals.normalizationWin++; trialClass = "normalization-win"; }
    else { totals.bothReject++; trialClass = "both-reject"; }
    if (trialClass !== "both-accept" && trialClass !== "both-reject") {
      const key = JSON.stringify([ref, trialClass]);
      const entry = divergences.get(key) ?? { ref, trialClass, count: 0 };
      entry.count++;
      divergences.set(key, entry);
    }
  };
  // Prefer the complete verbatim corpus by ref, not by position or outcome.
  // Audits have no execution outcome; projected traces are only a fallback.
  const auditedRefs = new Set<string>();
  for (const call of input.auditCalls ?? []) {
    auditedRefs.add(call.ref);
    record(call.ref, call.args);
  }
  for (const trace of input.traces) {
    for (const operation of trace.operations) {
      if (!auditedRefs.has(operation.ref)) record(operation.ref, operation.args);
    }
  }
  const costs = totals.tighteningCost + totals.canonicalIdentityCost + totals.idempotenceCost;
  return {
    verdict: costs > 0 ? "costly" : plannedOperations === 0 ? "no-evidence" : "clean",
    declaredScore: report.score, effectiveScore: report.score, delta: 0, totals,
    divergences: [...divergences.values()].sort((a, b) => compareCodeUnits(a.ref, b.ref) || compareCodeUnits(a.trialClass, b.trialClass)),
  };
};
