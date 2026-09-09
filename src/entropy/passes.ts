import type {
  EntropyGateResult,
  EntropyProposal,
  EntropyRefReport,
  EntropyReport,
  EntropyRepairRowInput,
  EntropySurfaceSnapshot,
  EntropyTraceInput,
  EntropyValueObservation,
} from "./types.js";
import { compareCodeUnits, roundMetric } from "./fingerprint.js";
import { deriveNormalFormPlan, MAX_NORMAL_FORM_PLANS } from "./normal-form.js";

// Normal forms are statically proved against declarations. Observations can
// suggest authored abstractions, but cannot remove enum values or actions.
// The schema surface itself is an invariant, not an optimization variable.

export interface EntropyProposalInput {
  report: EntropyReport;
  traces: readonly EntropyTraceInput[];
  surface?: EntropySurfaceSnapshot;
  repairs?: readonly EntropyRepairRowInput[];
  valueObservations?: readonly EntropyValueObservation[];
}

const ENUM_MIN_OBSERVATIONS = 8;
const ENUM_MAX_DISTINCT = 8;
const ENUM_MIN_TOP_SHARE = 0.5;
const SPLIT_MIN_SHAPE_ENTROPY_BITS = 1;
const SPLIT_MIN_CLUSTER_CALLS = 2;
const FUSE_MIN_SEQUENCE_LENGTH = 3;
const FUSE_MAX_SEQUENCE_LENGTH = 6;
const FUSE_MIN_OCCURRENCES = 3;
const FUSE_MIN_EXECUTIONS = 3;
const MAX_PROPOSALS_PER_KIND = 8;

export const ENTROPY_ENUM_CANDIDATE_ANNOTATION = "x-fabric-enum-candidate";

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const valueKey = (value: string | number | boolean): string => `${typeof value}:${String(value)}`;

const schemaProperties = (schema: unknown): Record<string, unknown> | undefined => {
  if (!isPlainRecord(schema)) return undefined;
  const properties = schema.properties;
  return isPlainRecord(properties) ? properties : undefined;
};

const contains = (outer: readonly string[], inner: readonly string[]): boolean => {
  if (outer.length < inner.length) return false;
  for (let start = 0; start + inner.length <= outer.length; start++) {
    let matches = true;
    for (let index = 0; index < inner.length; index++) {
      if (outer[start + index] !== inner[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
};

interface EnumCandidate {
  entry: {
    ref: string;
    key: string;
    counts: Map<string, { value: string | number | boolean; count: number }>;
    total: number;
  };
  ranked: { value: string | number | boolean; count: number }[];
  topShare: number;
}

export const proposeEntropyReductions = (input: EntropyProposalInput): EntropyProposal[] => {
  const calledRefs = new Map<string, EntropyRefReport>();
  for (const ref of input.report.refs) calledRefs.set(ref.ref, ref);
  const surfaceByRef = new Map<string, unknown>();
  if (input.surface) {
    for (const action of input.surface.actions) {
      surfaceByRef.set(action.ref, action.inputSchema);
    }
  }

  const proposals: EntropyProposal[] = [];
  for (const action of [...(input.surface?.actions ?? [])].sort((a, b) => compareCodeUnits(a.ref, b.ref)).slice(0, MAX_NORMAL_FORM_PLANS)) {
    const plan = deriveNormalFormPlan(action.ref, action.inputSchema);
    if (plan) proposals.push({ kind: "normal-form", ref: plan.ref, baseSchemaDigest: plan.baseSchemaDigest, rules: plan.rules });
  }

  // Open vocabulary observations are advisory only, and require an author's
  // explicit annotation. Finite declared domains are never pruned by usage.
  const observations = new Map<
    string,
    {
      ref: string;
      key: string;
      counts: Map<string, { value: string | number | boolean; count: number }>;
      total: number;
    }
  >();
  const observeValue = (
    ref: string,
    key: string,
    value: string | number | boolean,
    weight = 1,
  ): void => {
    const id = `${ref}\u0000${key}`;
    const entry =
      observations.get(id) ??
      {
        ref,
        key,
        counts: new Map<string, { value: string | number | boolean; count: number }>(),
        total: 0,
      };
    const valueId = valueKey(value);
    const existing = entry.counts.get(valueId);
    entry.counts.set(valueId, { value, count: (existing?.count ?? 0) + weight });
    entry.total += weight;
    observations.set(id, entry);
  };
  // Verbatim audit observations are the authoritative value corpus when
  // supplied: audits carry every argument, including the parameters the
  // trace projection drops. Without them the scan uses the projected trace
  // args.
  if (input.valueObservations) {
    for (const observation of input.valueObservations) {
      observeValue(observation.ref, observation.key, observation.value, observation.count ?? 1);
    }
  } else {
    for (const sourceTrace of input.traces) {
      for (const operation of sourceTrace.operations) {
        if (operation.ref.startsWith("fabric.")) continue;
        for (const [key, value] of Object.entries(operation.args)) {
          if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
            continue;
          }
          observeValue(operation.ref, key, value);
        }
      }
    }
  }
  const eligibleCandidates = [...observations.values()]
    .filter((entry) => entry.total >= ENUM_MIN_OBSERVATIONS)
    .filter((entry) => entry.counts.size >= 2 && entry.counts.size <= ENUM_MAX_DISTINCT)
    .map((entry): EnumCandidate => {
      const ranked = [...entry.counts.values()].sort(
        (left, right) =>
          right.count - left.count || compareCodeUnits(valueKey(left.value), valueKey(right.value)),
      );
      return { entry, ranked, topShare: roundMetric(ranked[0]!.count / entry.total) };
    })
    .filter((candidate) => candidate.topShare >= ENUM_MIN_TOP_SHARE);
  const openCandidates = eligibleCandidates.filter((candidate) => {
    const target = schemaProperties(surfaceByRef.get(candidate.entry.ref))?.[candidate.entry.key];
    return isPlainRecord(target) && target.type !== "boolean" && !Array.isArray(target.enum) &&
      target[ENTROPY_ENUM_CANDIDATE_ANNOTATION] === true;
  });
  const byRefKey = (left: EnumCandidate, right: EnumCandidate): number =>
    compareCodeUnits(`${left.entry.ref}\u0000${left.entry.key}`, `${right.entry.ref}\u0000${right.entry.key}`);
  for (const candidate of openCandidates.sort(byRefKey).slice(0, MAX_PROPOSALS_PER_KIND)) {
    proposals.push({
      kind: "declare-enum",
      ref: candidate.entry.ref,
      key: candidate.entry.key,
      values: candidate.ranked.map((item) => item.value),
      calls: candidate.entry.total,
      distinct: candidate.entry.counts.size,
      topShare: candidate.topShare,
    });
  }

  // Repair rows are already guarded aliases from a spilled spelling to the
  // canonical schema. Their existence proves compatibility is useful, not
  // that the alias should replace the canonical name. They contribute to the
  // lexicon metric but never become surface rewrite proposals.

  // overload-split: one ref carrying two disjoint parameter key-sets is an
  // overloaded action; splitting removes the per-call either/or freedom.
  const overloadRefs = new Set(
    input.report.refs
      .filter((ref) => ref.shapeEntropyBits >= SPLIT_MIN_SHAPE_ENTROPY_BITS)
      .map((ref) => ref.ref),
  );
  if (overloadRefs.size > 0) {
    const keySets = new Map<string, Map<string, { keys: string[]; calls: number }>>();
    for (const sourceTrace of input.traces) {
      for (const operation of sourceTrace.operations) {
        if (!overloadRefs.has(operation.ref)) continue;
        const keys = Object.keys(operation.args).sort();
        const id = keys.join("\u0000");
        const perRef = keySets.get(operation.ref) ?? new Map<string, { keys: string[]; calls: number }>();
        const cluster = perRef.get(id) ?? { keys, calls: 0 };
        cluster.calls += 1;
        perRef.set(id, cluster);
        keySets.set(operation.ref, perRef);
      }
    }
    let overloadCount = 0;
    for (const [ref, perRef] of [...keySets.entries()].sort(([left], [right]) =>
      compareCodeUnits(left, right),
    )) {
      if (overloadCount >= MAX_PROPOSALS_PER_KIND) break;
      const clusters = [...perRef.values()]
        .filter((cluster) => cluster.calls >= SPLIT_MIN_CLUSTER_CALLS)
        .sort(
          (left, right) =>
            right.calls - left.calls || compareCodeUnits(left.keys.join(","), right.keys.join(",")),
        );
      const disjoint: { keys: string[]; calls: number }[] = [];
      for (const cluster of clusters) {
        const keys = new Set(cluster.keys);
        if (disjoint.every((candidate) => candidate.keys.every((key) => !keys.has(key)))) {
          disjoint.push(cluster);
        }
      }
      if (disjoint.length >= 2) {
        overloadCount += 1;
        const report = calledRefs.get(ref);
        proposals.push({
          kind: "overload-split",
          ref,
          shapeEntropyBits: report?.shapeEntropyBits ?? 0,
          clusters: disjoint.slice(0, MAX_PROPOSALS_PER_KIND).map((cluster) => ({
            keys: cluster.keys,
            calls: cluster.calls,
          })),
        });
      }
    }
  }

  // sequence-fuse: only successful high-level action sequences repeated in
  // independent fabric_exec executions can imply a reusable composite. Pi
  // primitives are implementation steps (and should be batched instead),
  // while failed or ignored operations break contiguity rather than being
  // silently bridged. Every ref must be distinct and three executions must
  // agree before action names alone are strong enough to warrant review.
  const sequenceCounts = new Map<
    string,
    { sequence: string[]; occurrences: number; executions: Set<number> }
  >();
  const recordSequenceSegment = (refs: readonly string[], execution: number): void => {
    for (
      let length = FUSE_MIN_SEQUENCE_LENGTH;
      length <= Math.min(FUSE_MAX_SEQUENCE_LENGTH, refs.length);
      length++
    ) {
      for (let start = 0; start + length <= refs.length; start++) {
        const sequence = refs.slice(start, start + length);
        if (new Set(sequence).size !== sequence.length) continue;
        const id = sequence.join("→");
        const entry = sequenceCounts.get(id) ?? {
          sequence,
          occurrences: 0,
          executions: new Set<number>(),
        };
        entry.occurrences += 1;
        entry.executions.add(execution);
        sequenceCounts.set(id, entry);
      }
    }
  };
  input.traces.forEach((sourceTrace, execution) => {
    let segment: string[] = [];
    const flush = (): void => {
      recordSequenceSegment(segment, execution);
      segment = [];
    };
    for (const operation of sourceTrace.operations) {
      if (
        operation.outcome !== "succeeded" ||
        operation.ref.startsWith("fabric.") ||
        operation.ref.startsWith("pi.")
      ) {
        flush();
      } else {
        segment.push(operation.ref);
      }
    }
    flush();
  });
  const fuseCandidates = [...sequenceCounts.values()]
    .filter(
      (entry) =>
        entry.occurrences >= FUSE_MIN_OCCURRENCES &&
        entry.executions.size >= FUSE_MIN_EXECUTIONS,
    )
    .sort(
      (left, right) =>
        right.sequence.length - left.sequence.length ||
        right.occurrences - left.occurrences ||
        compareCodeUnits(left.sequence.join("→"), right.sequence.join("→")),
    );
  const selected: { sequence: string[]; occurrences: number }[] = [];
  for (const candidate of fuseCandidates) {
    if (selected.length >= MAX_PROPOSALS_PER_KIND) break;
    const redundant = selected.some(
      (chosen) =>
        contains(candidate.sequence, chosen.sequence) || contains(chosen.sequence, candidate.sequence),
    );
    if (redundant) continue;
    selected.push(candidate);
  }
  for (const candidate of selected) {
    proposals.push({
      kind: "sequence-fuse",
      sequence: candidate.sequence,
      occurrences: candidate.occurrences,
    });
  }

  return proposals;
};

// Compatibility normal forms live behind the registry. This API no longer
// interprets legacy restriction proposals, even when explicitly supplied.
export const applyProposalsToSurface = (
  surface: EntropySurfaceSnapshot,
  _proposals: readonly EntropyProposal[],
): EntropySurfaceSnapshot => surface;

// The ratchet: a compiled surface must not increase the measured score and
// must preserve every successful call. Monotonicity is measured, never
// argued.
export const evaluateGate = (before: EntropyReport, after: EntropyReport): EntropyGateResult => {
  const reasons: string[] = [];
  if (after.score > before.score) {
    reasons.push(`score increased ${before.score} → ${after.score}`);
  }
  if (after.totals.succeeded < before.totals.succeeded) {
    reasons.push(
      `successful calls dropped ${before.totals.succeeded} → ${after.totals.succeeded}`,
    );
  }
  return {
    passed: reasons.length === 0,
    beforeScore: before.score,
    afterScore: after.score,
    delta: roundMetric(after.score - before.score),
    reasons,
  };
};
