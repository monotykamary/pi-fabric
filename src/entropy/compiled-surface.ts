// The compiled entropy surface: the durable artifact the autonomous
// compiler maintains beside the repair table. Every overlay entry records
// the digest of the live schema it was compiled against, and every consult
// re-proves that digest against the live declared schema — an entry whose
// base changed underneath it drops out instead of mis-enforcing. The
// artifact is clock-free and deterministic: the same evidence compiles to
// the same bytes.

import { Value } from "typebox/value";
import { stableJsonHash } from "../core/stable-hash.js";
import type {
  EntropyAuditCall,
  EntropyProposal,
  EntropySurfaceSnapshot,
  EntropyTraceInput,
} from "./types.js";

export const COMPILED_SURFACE_VERSION = 1 as const;
export const MAX_COMPILED_SURFACE_PROPOSALS = 256;

export interface CompiledSurfaceOverlayEntry {
  ref: string;
  inputSchema: Record<string, unknown>;
  baseSchemaDigest: string;
}

export interface CompiledSurfaceQuarantineEntry {
  ref: string;
  baseSchemaDigest: string;
}

export interface CompiledSurfaceAppliedProposal {
  kind: EntropyProposal["kind"];
  ref: string;
  detail: string;
}

export interface CompiledSurfaceGateRecord {
  passed: boolean;
  beforeScore: number;
  afterScore: number;
  reasons: string[];
}

export interface CompiledSurfaceFile {
  version: typeof COMPILED_SURFACE_VERSION;
  metricVersion: number;
  actions: CompiledSurfaceOverlayEntry[];
  quarantined: CompiledSurfaceQuarantineEntry[];
  applied: CompiledSurfaceAppliedProposal[];
  gate: CompiledSurfaceGateRecord;
  evidenceDigest: string;
}

// Gate user-facing compile notices on enforcement changes, not provenance-only
// updates to the evidence digest, gate score, or applied ledger.
export const compiledSurfaceEffectChanged = (
  before: CompiledSurfaceFile | undefined,
  after: CompiledSurfaceFile,
): boolean => stableJsonHash({
  actions: before?.actions ?? [],
  quarantined: before?.quarantined ?? [],
}) !== stableJsonHash({
  actions: after.actions,
  quarantined: after.quarantined,
});

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const schemaDigest = (schema: unknown): string => stableJsonHash(schema);

// A base digest binds provenance, not authority: an imported or damaged
// artifact must not replace required fields, types, or other schema guards.
// Only top-level property enum restrictions may differ from the declaration.
const isEnumRestriction = (live: unknown, candidate: Record<string, unknown>): boolean => {
  if (!isPlainRecord(live)) return false;
  if (schemaDigest(live) === schemaDigest(candidate)) return true;
  if (!isPlainRecord(live.properties) || !isPlainRecord(candidate.properties)) return false;
  const restored = { ...candidate.properties };
  if (Object.keys(restored).length !== Object.keys(live.properties).length) return false;
  for (const [key, property] of Object.entries(live.properties)) {
    if (!Object.hasOwn(restored, key)) return false;
    const overlay = restored[key];
    if (schemaDigest(property) === schemaDigest(overlay)) continue;
    if (
      !isPlainRecord(property) || !isPlainRecord(overlay) ||
      !Array.isArray(overlay.enum) || overlay.enum.length === 0
    ) return false;
    if (Array.isArray(property.enum)) {
      const allowed = new Set(property.enum.map((value) => stableJsonHash(value)));
      if (!overlay.enum.every((value) => allowed.has(stableJsonHash(value)))) return false;
    }
    const rest = { ...overlay };
    const base = { ...property };
    delete rest.enum;
    delete base.enum;
    if (schemaDigest(rest) !== schemaDigest(base)) return false;
    Object.defineProperty(restored, key, {
      value: property, enumerable: true, configurable: true, writable: true,
    });
  }
  return schemaDigest({ ...candidate, properties: restored }) === schemaDigest(live);
};

const provesOverlay = (live: unknown, entry: CompiledSurfaceOverlayEntry): boolean =>
  schemaDigest(live) === entry.baseSchemaDigest && isEnumRestriction(live, entry.inputSchema);

// Overlay consult for one ref: the compiled schema replaces the declared
// schema only while the base digest still proves the declared surface did
// not change underneath the compile.
export const effectiveSchemaFor = (
  ref: string,
  liveSchema: unknown,
  file?: CompiledSurfaceFile,
): unknown => {
  const entry = file?.actions.find((candidate) => candidate.ref === ref);
  if (!entry) return liveSchema;
  return provesOverlay(liveSchema, entry) ? entry.inputSchema : liveSchema;
};

// Whole-surface overlay for measurement and export: tightened schemas where
// the base still matches, quarantined refs hidden where the base still
// matches. Stale entries fall back to the live surface, never mis-enforce.
export const applyCompiledSurface = (
  live: EntropySurfaceSnapshot,
  file?: CompiledSurfaceFile,
): EntropySurfaceSnapshot => {
  if (!file || (file.actions.length === 0 && file.quarantined.length === 0)) return live;
  const byRef = new Map<string, unknown>(
    live.actions.map((action) => [action.ref, action.inputSchema]),
  );
  const overlayByRef = new Map(file.actions.map((entry) => [entry.ref, entry]));
  const quarantineByRef = new Map(file.quarantined.map((entry) => [entry.ref, entry]));
  const actions: EntropySurfaceSnapshot["actions"] = [];
  for (const action of live.actions) {
    const overlay = overlayByRef.get(action.ref);
    if (overlay && provesOverlay(byRef.get(action.ref), overlay)) {
      actions.push({ ref: action.ref, inputSchema: overlay.inputSchema });
      continue;
    }
    const quarantine = quarantineByRef.get(action.ref);
    if (quarantine && schemaDigest(byRef.get(action.ref)) === quarantine.baseSchemaDigest) {
      continue;
    }
    actions.push(action);
  }
  return { version: 1, actions };
};

// Name-only quarantine view for catalog filtering: hiding there is
// advisory, so no digest proof is required. Resolution denial is the
// digested isQuarantinedRef below.
export const quarantinedRefNames = (file?: CompiledSurfaceFile): ReadonlySet<string> =>
  new Set(file?.quarantined.map((entry) => entry.ref));

// Resolution denial with digest proof: a quarantined ref stays callable
// only when the live schema changed underneath the compile.
export const isQuarantinedRef = (
  ref: string,
  liveSchema: unknown,
  file?: CompiledSurfaceFile,
): boolean => {
  const entry = file?.quarantined.find((candidate) => candidate.ref === ref);
  if (!entry) return false;
  return schemaDigest(liveSchema) === entry.baseSchemaDigest;
};

export interface MergedCompiledSurface {
  file: CompiledSurfaceFile;
  droppedOverlays: number;
  droppedQuarantines: number;
}

const byRefOrder = (left: { ref: string }, right: { ref: string }): number =>
  left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0;

// Federation merge: incoming entries earn a slot only where their recorded
// base digest proves against the live declared surface and the local
// artifact has nothing to say about that ref (conflicts skip, local wins).
// Every consult re-proves merged entries against the live schema, so an
// imported artifact can never enforce a schema the local surface does not
// still declare. The applied ledger unions by identity, local first,
// capped at the store's maximum.
export const mergeCompiledSurfaces = (
  local: CompiledSurfaceFile | undefined,
  incoming: CompiledSurfaceFile,
  live: EntropySurfaceSnapshot,
): MergedCompiledSurface => {
  const liveByRef = new Map(live.actions.map((action) => [action.ref, action.inputSchema]));
  const liveDigestOf = (ref: string): string | undefined => {
    const schema = liveByRef.get(ref);
    return schema === undefined ? undefined : schemaDigest(schema);
  };
  const overlayRefs = new Set((local?.actions ?? []).map((entry) => entry.ref));
  const quarantineRefs = new Set((local?.quarantined ?? []).map((entry) => entry.ref));
  const actions = [...(local?.actions ?? [])];
  const quarantined = [...(local?.quarantined ?? [])];
  let droppedOverlays = 0;
  let droppedQuarantines = 0;
  for (const entry of incoming.actions) {
    if (overlayRefs.has(entry.ref) || quarantineRefs.has(entry.ref)) continue;
    if (!provesOverlay(liveByRef.get(entry.ref), entry)) {
      droppedOverlays++;
      continue;
    }
    actions.push(entry);
    overlayRefs.add(entry.ref);
  }
  for (const entry of incoming.quarantined) {
    if (overlayRefs.has(entry.ref) || quarantineRefs.has(entry.ref)) continue;
    if (liveDigestOf(entry.ref) !== entry.baseSchemaDigest) {
      droppedQuarantines++;
      continue;
    }
    quarantined.push(entry);
    quarantineRefs.add(entry.ref);
  }
  actions.sort(byRefOrder);
  quarantined.sort(byRefOrder);
  const applied: CompiledSurfaceAppliedProposal[] = [];
  const seenApplied = new Set<string>();
  for (const source of [local?.applied ?? [], incoming.applied]) {
    for (const entry of source) {
      const identity = `${entry.kind}:${entry.ref}:${entry.detail}`;
      if (seenApplied.has(identity)) continue;
      seenApplied.add(identity);
      if (applied.length >= MAX_COMPILED_SURFACE_PROPOSALS) break;
      applied.push(entry);
    }
  }
  const file: CompiledSurfaceFile = {
    version: COMPILED_SURFACE_VERSION,
    metricVersion: local?.metricVersion ?? incoming.metricVersion,
    actions,
    quarantined,
    applied,
    gate: local?.gate ?? incoming.gate,
    evidenceDigest: stableJsonHash({
      actions,
      quarantined,
      applied,
      sources: [...(local ? [local.evidenceDigest] : []), incoming.evidenceDigest],
    }),
  };
  return { file, droppedOverlays, droppedQuarantines };
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
