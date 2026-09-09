// Deterministic tool-entropy measurement for the Fabric tool surface.
//
// The operational score is an invocation rejection fraction, not bits.
// Shape, failure-stage, flow, churn, navigation, lexicon, and schema freedom
// remain separate diagnostics from typed traces, repairs, and live schemas.
// No model judges anything; identical inputs and metric version give the
// same report. Derived metrics are rounded to six decimal places.

export const ENTROPY_METRIC_VERSION = 3 as const;

// Legacy diagnostic weights retained for export compatibility. In v3 only
// staticFreedom scales staticScore; none contribute to the operational score.
// Changes to metric formulas require an ENTROPY_METRIC_VERSION bump.
export const ENTROPY_WEIGHTS = {
  shape: 1,
  failureStage: 1,
  churn: 4,
  navigation: 4,
  flow: 1,
  lexicon: 2,
  staticFreedom: 0.25,
} as const;

// Failure stages that mean "the surface rejected the call before it could
// take effect" — the offline residue class behind repair fingerprints.
export const ENTROPY_INVOCATION_STAGES: readonly string[] = ["resolve", "prepare", "validate"];

export type EntropyOutcome = "succeeded" | "failed" | "aborted" | "timed_out";

export interface EntropySurfaceAction {
  ref: string;
  inputSchema: unknown;
}

export interface EntropySurfaceSnapshot {
  version: 1;
  actions: EntropySurfaceAction[];
}

export interface EntropyOperationInput {
  ref: string;
  args: Record<string, unknown>;
  outcome: EntropyOutcome;
  failureStage?: string;
  normalization?: import("./normal-form.js").NormalFormWitness;
}

export interface EntropyTraceInput {
  operations: EntropyOperationInput[];
  taskKey?: string;
  /** Producing model, stamped from the session scan as `provider/modelId`. */
  model?: string;
}

// Normalized compatibility alias: `ref` is the canonical target the row
// repairs toward.
export interface EntropyRepairRowInput {
  kind: "keyAlias" | "actionAlias";
  ref: string;
  from: string;
  to: string;
}

// One verbatim argument value observed in persisted audits: the value-level
// corpus for enum-tighten. Trace V1 projects values away per ref; audits
// carry every argument the call actually used. Pooled observations carry
// `count` multiplicity instead of one entry per call.
export interface EntropyValueObservation {
  ref: string;
  key: string;
  value: string | number | boolean;
  /** Observation multiplicity; window scans emit one entry per call, pools emit one per distinct value. */
  count?: number;
}

// One verbatim call per persisted audit: the authoritative record of the
// arguments a call actually used. Trace V1 projects values away per ref, so
// replay validation consults these, never the projected trace args.
export interface EntropyAuditCall {
  ref: string;
  args: Record<string, unknown>;
}

export interface EntropyShapeSignature {
  signature: string;
  count: number;
}

export interface EntropyRefReport {
  ref: string;
  calls: number;
  succeeded: number;
  failed: number;
  shapeSignatures: EntropyShapeSignature[];
  /** Shannon entropy of argument shapes, in bits. */
  shapeEntropyBits: number;
  /** Shannon entropy of failed-call stages, in bits. */
  failureStageEntropyBits: number;
  /** Mean normalized shape distance between a failure and the next same-ref call. */
  churnRate: number;
  /** Count of repair rows targeting this ref. */
  lexiconRows: number;
  /** Heuristic schema-freedom units; zero for an unknown schema. */
  staticFreedom: number;
  /** Invocation rejections / calls, a fraction in [0, 1]. */
  score: number;
}

export interface EntropyTotals {
  traces: number;
  operations: number;
  actionOperations: number;
  discoveryOperations: number;
  workflowOperations: number;
  succeeded: number;
  failed: number;
  aborted: number;
  timedOut: number;
  invocationRejections: number;
  invocationRejectionsPer1k: number;
}

// Per-model behavioral attribution over stamped traces only.
export interface EntropyModelReport {
  model: string;
  operations: number;
  actionOperations: number;
  succeeded: number;
  invocationRejections: number;
  invocationRejectionsPer1k: number;
  /** Invocation rejections / action operations for this model, in [0, 1]; zero if none. */
  behavioralScore: number;
}

export interface EntropyReport {
  metricVersion: typeof ENTROPY_METRIC_VERSION;
  catalogDigest: string;
  totals: EntropyTotals;
  /** Call-weighted mean per-ref shape entropy, in bits. */
  shapeEntropyBits: number;
  /** Failed-call-weighted mean per-ref failure-stage entropy, in bits. */
  failureStageEntropyBits: number;
  /** Mean normalized failure-to-next-same-ref shape distance within traces. */
  churnRate: number;
  /** Discovery operations / action operations; zero without action operations. */
  navigationRatio: number;
  /** Trace-weighted mean per-task action-sequence entropy, in bits. */
  flowEntropyBits: number;
  /** Total count of supplied repair rows. */
  lexiconRows: number;
  /** Sum of heuristic schema-freedom units over distinct called refs. */
  staticFreedom: number;
  /** 0.25 × call-weighted mean schema freedom; unknown schemas contribute zero.
   * Diagnostic only, zero without action calls; never added to score. */
  staticScore: number;
  /** Identical to score: invocation rejection fraction, not entropy bits. */
  behavioralScore: number;
  /** Failed resolve/prepare/validate calls / all action operations, in [0, 1].
   * Zero without action operations. Discovery/workflow operations are excluded. */
  score: number;
  refs: EntropyRefReport[];
  /** Behavioral attribution per producing model; empty when no trace carries one. */
  byModel: EntropyModelReport[];
}

export type EntropyProposal =
  | {
      kind: "normal-form";
      ref: string;
      baseSchemaDigest: string;
      rules: import("./normal-form.js").NormalFormRule[];
    }
  | {
      kind: "enum-tighten";
      ref: string;
      key: string;
      values: (string | number | boolean)[];
      calls: number;
      distinct: number;
      topShare: number;
    }
  | {
      kind: "declare-enum";
      ref: string;
      key: string;
      values: (string | number | boolean)[];
      calls: number;
      distinct: number;
      topShare: number;
    }
  | {
      kind: "overload-split";
      ref: string;
      shapeEntropyBits: number;
      clusters: { keys: string[]; calls: number }[];
    }
  | {
      kind: "sequence-fuse";
      sequence: string[];
      occurrences: number;
    }
  | {
      kind: "noise-quarantine";
      ref: string;
      calls: number;
      succeeded: number;
      failed: number;
      failureStageEntropyBits: number;
    };

export interface EntropyGateResult {
  passed: boolean;
  beforeScore: number;
  afterScore: number;
  delta: number;
  reasons: string[];
}

// Trend of a score sequence, oldest to newest: the ratchet's line. A
// negative slopePerStep means the surface is compiling down.
export interface EntropyTrend {
  count: number;
  first?: number;
  last?: number;
  slopePerStep: number;
}
