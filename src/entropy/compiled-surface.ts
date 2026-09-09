// Version 2 compiles compatibility normal forms, never schema restrictions.
// Version 1 restriction artifacts remain readable for migration but are inert.
import { Value } from "typebox/value";
import { stableJsonHash } from "../core/stable-hash.js";
import { ENTROPY_METRIC_VERSION } from "./types.js";
import { MAX_NORMAL_FORM_PLANS, provesNormalFormPlan, type NormalFormPlan } from "./normal-form.js";
import type { EntropyAuditCall, EntropyProposal, EntropySurfaceSnapshot, EntropyTraceInput } from "./types.js";

export const COMPILED_SURFACE_VERSION = 2 as const;
export const MAX_COMPILED_SURFACE_PROPOSALS = 256;
export interface CompiledSurfaceOverlayEntry {
  ref: string;
  inputSchema: Record<string, unknown>;
  baseSchemaDigest: string;
}
export interface CompiledSurfaceQuarantineEntry { ref: string; baseSchemaDigest: string }
export interface CompiledSurfaceAppliedProposal { kind: EntropyProposal["kind"]; ref: string; detail: string }
export interface CompiledSurfaceGateRecord { passed: boolean; beforeScore: number; afterScore: number; reasons: string[] }
export interface CompiledSurfaceFile {
  version: 1 | typeof COMPILED_SURFACE_VERSION;
  metricVersion: number;
  /** Legacy restrictions are retained only when reading version 1. Never enforced. */
  actions: CompiledSurfaceOverlayEntry[];
  quarantined: CompiledSurfaceQuarantineEntry[];
  normalizations?: NormalFormPlan[];
  applied: CompiledSurfaceAppliedProposal[];
  gate: CompiledSurfaceGateRecord;
  evidenceDigest: string;
}

export const emptyCompiledSurface = (): CompiledSurfaceFile => ({
  version: COMPILED_SURFACE_VERSION, metricVersion: ENTROPY_METRIC_VERSION,
  actions: [], quarantined: [], normalizations: [], applied: [],
  gate: { passed: true, beforeScore: 0, afterScore: 0, reasons: [] },
  evidenceDigest: stableJsonHash([]),
});
export const compiledSurfaceEffectChanged = (before: CompiledSurfaceFile | undefined, after: CompiledSurfaceFile): boolean =>
  stableJsonHash(before?.version === COMPILED_SURFACE_VERSION ? before.normalizations ?? [] : []) !==
  stableJsonHash(after.version === COMPILED_SURFACE_VERSION ? after.normalizations ?? [] : []);
const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const schemaDigest = (schema: unknown): string => stableJsonHash(schema);

// These compatibility APIs deliberately preserve the entire declaration.
// Neither a legacy artifact nor an imported schema may remove capabilities.
export const effectiveSchemaFor = (_ref: string, liveSchema: unknown, _file?: CompiledSurfaceFile): unknown => liveSchema;
export const applyCompiledSurface = (live: EntropySurfaceSnapshot, _file?: CompiledSurfaceFile): EntropySurfaceSnapshot => live;
export const quarantinedRefNames = (_file?: CompiledSurfaceFile): ReadonlySet<string> => new Set();
export const isQuarantinedRef = (_ref: string, _liveSchema: unknown, _file?: CompiledSurfaceFile): boolean => false;

export interface MergedCompiledSurface {
  file: CompiledSurfaceFile;
  droppedOverlays: number;
  droppedQuarantines: number;
  droppedNormalizations: number;
}

// Import proves the complete rule plan by re-derivation, not merely a base
// digest. Forged rule kinds/targets, drift, and every legacy restriction drop.
export const mergeCompiledSurfaces = (
  local: CompiledSurfaceFile | undefined,
  incoming: CompiledSurfaceFile,
  live: EntropySurfaceSnapshot,
): MergedCompiledSurface => {
  const schemas = new Map(live.actions.map((action) => [action.ref, action.inputSchema]));
  const plans = new Map<string, NormalFormPlan>();
  let droppedNormalizations = 0;
  for (const file of [local, incoming]) {
    if (!file || file.version !== COMPILED_SURFACE_VERSION) continue;
    for (const plan of file.normalizations ?? []) {
      if (!provesNormalFormPlan(plan, schemas.get(plan.ref))) { droppedNormalizations++; continue; }
      if (plans.size >= MAX_NORMAL_FORM_PLANS || plans.has(plan.ref)) continue;
      plans.set(plan.ref, plan);
    }
  }
  const normalizations = [...plans.values()].sort((a, b) => a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
  return {
    file: {
      ...emptyCompiledSurface(), normalizations,
      applied: normalizations.slice(0, MAX_COMPILED_SURFACE_PROPOSALS).map((plan) => ({ kind: "normal-form", ref: plan.ref, detail: `${plan.rules.length} proven rules` })),
      evidenceDigest: stableJsonHash(normalizations),
    },
    droppedOverlays: (local?.actions.length ?? 0) + incoming.actions.length,
    droppedQuarantines: (local?.quarantined.length ?? 0) + incoming.quarantined.length,
    droppedNormalizations,
  };
};

export interface ReplayViolation {
  ref: string;
  reason: string;
}

// Replay preservation: every successful call to a ref the compile touched
// must still parse against the candidate surface — resolution plus the same
// TypeBox check the registry's validate stage uses. Untouched refs keep
// their schema by identity, so replay stays scoped to the touched set.
// When a touched ref has verbatim audit calls, they are the replay corpus:
// trace V1 projects values away per ref, so validating the projected trace
// args would phantom-reject calls that actually parsed. Audits the declared
// surface already rejected are not protected — those calls never executed,
// so no compile can invalidate them.
export const replaySuccessfulCalls = (
  surface: EntropySurfaceSnapshot,
  before: EntropySurfaceSnapshot,
  traces: readonly EntropyTraceInput[],
  touchedRefs: ReadonlySet<string>,
  auditCalls?: readonly EntropyAuditCall[],
): ReplayViolation[] => {
  const schemaByRef = new Map(surface.actions.map((action) => [action.ref, action.inputSchema]));
  const beforeByRef = new Map(before.actions.map((action) => [action.ref, action.inputSchema]));
  const accepts = (schema: unknown, args: Record<string, unknown>): boolean => {
    try {
      return isPlainRecord(schema) && Value.Check(schema, args);
    } catch {
      return false;
    }
  };
  const violations: ReplayViolation[] = [];
  const auditedRefs = new Set<string>();
  if (auditCalls) {
    const auditArgsByRef = new Map<string, Record<string, unknown>[]>();
    for (const call of auditCalls) {
      if (!touchedRefs.has(call.ref)) continue;
      const bucket = auditArgsByRef.get(call.ref) ?? [];
      bucket.push(call.args);
      auditArgsByRef.set(call.ref, bucket);
    }
    for (const [ref, argsList] of auditArgsByRef) {
      auditedRefs.add(ref);
      const schema = schemaByRef.get(ref);
      if (schema === undefined) {
        violations.push({ ref, reason: "absent from the candidate surface" });
        continue;
      }
      const declared = beforeByRef.get(ref);
      for (const args of argsList) {
        if (declared !== undefined && !accepts(declared, args)) continue;
        if (!accepts(schema, args)) {
          violations.push({
            ref,
            reason: "recorded arguments no longer validate against the compiled schema",
          });
        }
      }
    }
  }
  for (const sourceTrace of traces) {
    for (const operation of sourceTrace.operations) {
      if (operation.outcome !== "succeeded") continue;
      if (operation.ref.startsWith("fabric.")) continue;
      if (!touchedRefs.has(operation.ref)) continue;
      if (auditedRefs.has(operation.ref)) continue;
      const schema = schemaByRef.get(operation.ref);
      if (schema === undefined) {
        violations.push({ ref: operation.ref, reason: "absent from the candidate surface" });
        continue;
      }
      if (!accepts(schema, operation.args)) {
        violations.push({
          ref: operation.ref,
          reason: "recorded arguments no longer validate against the compiled schema",
        });
      }
    }
  }
  return violations;
};

const COOPERATIVE_REPLAY_CHUNK = 64;

const replayYield = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

// Hook-safe replay gate. The ordering and validation rules match the pure
// certification path exactly, with fixed operation chunks between TUI turns.
export const replaySuccessfulCallsAsync = async (
  surface: EntropySurfaceSnapshot,
  before: EntropySurfaceSnapshot,
  traces: readonly EntropyTraceInput[],
  touchedRefs: ReadonlySet<string>,
  auditCalls?: readonly EntropyAuditCall[],
): Promise<ReplayViolation[]> => {
  const schemaByRef = new Map(surface.actions.map((action) => [action.ref, action.inputSchema]));
  const beforeByRef = new Map(before.actions.map((action) => [action.ref, action.inputSchema]));
  const accepts = (schema: unknown, args: Record<string, unknown>): boolean => {
    try {
      return isPlainRecord(schema) && Value.Check(schema, args);
    } catch {
      return false;
    }
  };
  const violations: ReplayViolation[] = [];
  const auditedRefs = new Set<string>();
  let processed = 0;
  await replayYield();
  if (auditCalls) {
    const auditArgsByRef = new Map<string, Record<string, unknown>[]>();
    for (const call of auditCalls) {
      if (touchedRefs.has(call.ref)) {
        const bucket = auditArgsByRef.get(call.ref) ?? [];
        bucket.push(call.args);
        auditArgsByRef.set(call.ref, bucket);
      }
      processed += 1;
      if (processed % COOPERATIVE_REPLAY_CHUNK === 0) await replayYield();
    }
    for (const [ref, argsList] of auditArgsByRef) {
      auditedRefs.add(ref);
      const schema = schemaByRef.get(ref);
      if (schema === undefined) {
        violations.push({ ref, reason: "absent from the candidate surface" });
        continue;
      }
      const declared = beforeByRef.get(ref);
      for (const args of argsList) {
        if (declared === undefined || accepts(declared, args)) {
          if (!accepts(schema, args)) {
            violations.push({
              ref,
              reason: "recorded arguments no longer validate against the compiled schema",
            });
          }
        }
        processed += 1;
        if (processed % COOPERATIVE_REPLAY_CHUNK === 0) await replayYield();
      }
    }
  }
  for (const sourceTrace of traces) {
    for (const operation of sourceTrace.operations) {
      if (
        operation.outcome === "succeeded" &&
        !operation.ref.startsWith("fabric.") &&
        touchedRefs.has(operation.ref) &&
        !auditedRefs.has(operation.ref)
      ) {
        const schema = schemaByRef.get(operation.ref);
        if (schema === undefined) {
          violations.push({ ref: operation.ref, reason: "absent from the candidate surface" });
        } else if (!accepts(schema, operation.args)) {
          violations.push({
            ref: operation.ref,
            reason: "recorded arguments no longer validate against the compiled schema",
          });
        }
      }
      processed += 1;
      if (processed % COOPERATIVE_REPLAY_CHUNK === 0) await replayYield();
    }
  }
  return violations;
};
