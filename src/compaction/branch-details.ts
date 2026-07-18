import type {
  FabricExecutionOutcomeV1,
  FabricTraceJsonValue,
} from "../audit/trace.js";

export const FABRIC_BRANCH_SUMMARY_KIND = "pi-fabric.branch-summary" as const;
export const FABRIC_BRANCH_SUMMARY_VERSION = 1 as const;
export const FABRIC_BRANCH_SUMMARY_MAX_BYTES = 128 * 1024;
export const FABRIC_BRANCH_SUMMARY_MAX_FACTS = 256;

interface BranchFactBase {
  entryId: string;
  subordinal: string;
  address: string;
}

interface FabricBranchUserFactV1 extends BranchFactBase {
  kind: "user";
  text: string;
}

interface FabricBranchCustomMessageFactV1 extends BranchFactBase {
  kind: "customMessage";
  customType: string;
  text: string;
  display: boolean;
  details?: FabricTraceJsonValue;
}

interface FabricBranchPhaseFactV1 extends BranchFactBase {
  kind: "phase";
  phase: string;
}

export interface FabricBranchOperationFactV1 extends BranchFactBase {
  kind: "operation";
  ref: string;
  provider?: string;
  action?: string;
  tool: string;
  args: Record<string, FabricTraceJsonValue>;
  outcome: FabricExecutionOutcomeV1;
  error?: string;
  result?: FabricTraceJsonValue;
}

export type FabricBranchFactV1 =
  | FabricBranchUserFactV1
  | FabricBranchCustomMessageFactV1
  | FabricBranchPhaseFactV1
  | FabricBranchOperationFactV1;

export interface FabricBranchSummaryDetailsV1 {
  kind: typeof FABRIC_BRANCH_SUMMARY_KIND;
  version: typeof FABRIC_BRANCH_SUMMARY_VERSION;
  source: {
    firstEntryId: string;
    lastEntryId: string;
    entryCount: number;
    /** Canonical abandoned-branch provenance. Absent only on older v1 envelopes. */
    oldLeafId?: string | null;
  };
  facts: FabricBranchFactV1[];
  omittedFacts: number;
  sections: string[];
  request: {
    text: string;
    sourceBytes: number;
    truncated: boolean;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

interface JsonValidationState {
  nodes: number;
  ancestors: Set<object>;
}

const MAX_DETAILS_JSON_NODES = 4096;
const MAX_DETAILS_JSON_COLLECTION = 256;

const isJsonValue = (
  value: unknown,
  state: JsonValidationState,
  depth = 0,
): value is FabricTraceJsonValue => {
  state.nodes += 1;
  if (state.nodes > MAX_DETAILS_JSON_NODES) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > 16 || state.ancestors.has(value)) return false;
  state.ancestors.add(value);
  let valid = false;
  try {
    if (Array.isArray(value)) {
      valid = value.length <= MAX_DETAILS_JSON_COLLECTION
        && value.every((item) => isJsonValue(item, state, depth + 1));
    } else {
      const keys = Object.keys(value);
      valid = keys.length <= MAX_DETAILS_JSON_COLLECTION
        && keys.every((key) => isJsonValue((value as Record<string, unknown>)[key], state, depth + 1));
    }
  } finally {
    state.ancestors.delete(value);
  }
  return valid;
};

const outcomes = new Set<FabricExecutionOutcomeV1>(["succeeded", "failed", "aborted", "timed_out"]);

const validBase = (fact: Record<string, unknown>): boolean =>
  typeof fact.entryId === "string"
  && typeof fact.subordinal === "string"
  && typeof fact.address === "string"
  && fact.address === `${fact.entryId}/${fact.subordinal}`;

const isFact = (value: unknown, jsonState: JsonValidationState): value is FabricBranchFactV1 => {
  if (!isRecord(value) || !validBase(value)) return false;
  if (value.kind === "user") {
    return hasOnlyKeys(value, ["kind", "entryId", "subordinal", "address", "text"])
      && typeof value.text === "string";
  }
  if (value.kind === "customMessage") {
    return hasOnlyKeys(value, [
      "kind", "entryId", "subordinal", "address", "customType", "text", "display", "details",
    ])
      && typeof value.customType === "string"
      && typeof value.text === "string"
      && typeof value.display === "boolean"
      && (value.details === undefined || isJsonValue(value.details, jsonState));
  }
  if (value.kind === "phase") {
    return hasOnlyKeys(value, ["kind", "entryId", "subordinal", "address", "phase"])
      && typeof value.phase === "string";
  }
  if (value.kind !== "operation") return false;
  if (!hasOnlyKeys(value, [
    "kind", "entryId", "subordinal", "address", "ref", "provider", "action", "tool", "args",
    "outcome", "error", "result",
  ])) return false;
  return typeof value.ref === "string"
    && (value.provider === undefined || typeof value.provider === "string")
    && (value.action === undefined || typeof value.action === "string")
    && typeof value.tool === "string"
    && isRecord(value.args)
    && isJsonValue(value.args, jsonState)
    && outcomes.has(value.outcome as FabricExecutionOutcomeV1)
    && (value.error === undefined || typeof value.error === "string")
    && (value.result === undefined || isJsonValue(value.result, jsonState));
};

const serializedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

export const readFabricBranchSummaryDetailsV1 = (
  value: unknown,
): FabricBranchSummaryDetailsV1 | undefined => {
  try {
    if (!isRecord(value) || !hasOnlyKeys(value, [
      "kind", "version", "source", "facts", "omittedFacts", "sections", "request",
    ])) return undefined;
    if (value.kind !== FABRIC_BRANCH_SUMMARY_KIND || value.version !== FABRIC_BRANCH_SUMMARY_VERSION) return undefined;
    if (!isRecord(value.source) || !hasOnlyKeys(value.source, ["firstEntryId", "lastEntryId", "entryCount", "oldLeafId"])) return undefined;
    if (typeof value.source.firstEntryId !== "string" || typeof value.source.lastEntryId !== "string") return undefined;
    if (!Number.isSafeInteger(value.source.entryCount) || (value.source.entryCount as number) < 0) return undefined;
    if (value.source.oldLeafId !== undefined && value.source.oldLeafId !== null && typeof value.source.oldLeafId !== "string") return undefined;
    const jsonState: JsonValidationState = { nodes: 0, ancestors: new Set<object>() };
    if (!Array.isArray(value.facts)
      || value.facts.length > FABRIC_BRANCH_SUMMARY_MAX_FACTS
      || !value.facts.every((fact) => isFact(fact, jsonState))) return undefined;
    if (!Number.isSafeInteger(value.omittedFacts) || (value.omittedFacts as number) < 0) return undefined;
    if (!Array.isArray(value.sections)
      || value.sections.length > 64
      || !value.sections.every((section) => typeof section === "string")) return undefined;
    if (!isRecord(value.request) || !hasOnlyKeys(value.request, ["text", "sourceBytes", "truncated"])) return undefined;
    if (typeof value.request.text !== "string" || typeof value.request.truncated !== "boolean") return undefined;
    if (!Number.isSafeInteger(value.request.sourceBytes) || (value.request.sourceBytes as number) < 0) return undefined;
    if (serializedBytes(value) > FABRIC_BRANCH_SUMMARY_MAX_BYTES) return undefined;
    return value as unknown as FabricBranchSummaryDetailsV1;
  } catch {
    return undefined;
  }
};
