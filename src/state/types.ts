import type { MeshIdentity } from "../mesh/store.js";

export type StateTransitionKind = "state" | "representation";
export type StateCertificationStatus = "pending" | "certified";
export type StateTransitionPhase = "proposed" | "committed" | "rejected";

export interface StateTransitionInput {
  label: string;
  from?: string;
  to: string;
  summary: string;
  evidence?: string[];
  tags?: string[];
  kind?: StateTransitionKind;
  complexity?: { files: string[] };
  force?: boolean;
}

export interface StateComplexityDelta {
  file: string;
  supported: boolean;
  language?: string;
  previous?: number;
  current?: number;
  delta?: number;
  baseline?: boolean;
}

export interface StateTransitionComplexity {
  files: StateComplexityDelta[];
  netDelta: number;
}

export interface StateComplexityFile {
  file: string;
  supported: boolean;
  language?: string;
  current?: number;
  recorded?: number;
  delta?: number;
  recordedDelta?: number;
}

export interface StateComplexityResult {
  files: StateComplexityFile[];
  netDelta: number;
}

export interface StateComplexitySummary {
  files: number;
  decisionPoints: number;
  lastNetDelta: number;
}

export interface StateTransitionRecord {
  transitionId: string;
  sequence: number;
  label: string;
  from?: string;
  to: string;
  summary: string;
  evidence?: string[];
  tags?: string[];
  kind: StateTransitionKind;
  complexity?: StateTransitionComplexity;
  certificationStatus?: StateCertificationStatus;
  certificate?: StateCertificate;
  ts: number;
}

export interface StateHeadCommitProof {
  version: 1;
  status: "pending" | "committed";
}

export interface StateHeadValue {
  protocolVersion?: number;
  commitProof?: StateHeadCommitProof;
  transitionSequence?: number;
  label: string;
  from?: string;
  to: string;
  summary: string;
  evidence?: string[];
  tags?: string[];
  kind: StateTransitionKind;
  complexity?: StateTransitionComplexity;
  transitionId: string;
  certificationStatus?: StateCertificationStatus;
  certificate?: StateCertificate;
  ts: number;
}

export interface StateHead extends StateHeadValue {
  version: number;
}

export interface StateGoal {
  check: string;
  description?: string;
}

export type VerifyStatus = "confirmed" | "violated" | "error";

export interface VerifyResult {
  claim: string;
  claimDigest: string;
  claimOmittedBytes?: number;
  command: string;
  commandDigest: string;
  commandOmittedBytes?: number;
  status: VerifyStatus;
  exitCode: number | null;
  output: string;
  outputBytes: number;
  outputOmittedBytes: number;
  outputDigest: string;
  error?: string;
  errorDigest?: string;
  errorOmittedBytes?: number;
}

export interface StateCertificationTarget {
  transitionId: string;
  label: string;
  to: string;
}

export interface StateCertificationHead {
  transitionId: string;
  label: string;
  labelDigest?: string;
  labelOmittedBytes?: number;
  to: string;
  toDigest?: string;
  toOmittedBytes?: number;
  version: number;
}

export interface StateCertificate {
  certificateId: string;
  sequence: number;
  certificationStatus: "certified";
  targets: StateCertificationTarget[];
  head: StateCertificationHead | null;
  evidenceDigest: string;
  resultDigest: string;
  ts: number;
  current: boolean;
}

export interface VerificationFailure {
  reason:
    | "missing-target"
    | "missing-evidence"
    | "nonzero-exit"
    | "execution-error"
    | "reporting-error";
  message: string;
  transitionId?: string;
  label?: string;
  command?: string;
  status?: VerifyStatus;
  exitCode?: number | null;
  error?: string;
}

export interface VerificationReport {
  results: VerifyResult[];
  certified: boolean;
  violated: boolean;
  certificationStatus: "certified" | "failed";
  evidenceDigest: string;
  resultDigest: string;
  failures: VerificationFailure[];
  certificate?: StateCertificate;
  reportingError?: string;
}

export interface AdvanceHeadInput {
  payload: StateHeadValue;
  from: string | undefined;
  force: boolean;
  expectedVersion: number;
  identity: MeshIdentity;
}
