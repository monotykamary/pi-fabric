// Corpus shaping for the entropy meter: turn persisted Fabric execution
// traces and session JSONL into meter traces, and normalize catalog repair
// rows. Only guarded, typed records are consumed — never rendered prose.

import {
  FABRIC_EXECUTION_TRACE_KIND,
  readFabricExecutionTraceV1,
  type FabricExecutionTraceV1,
} from "../audit/trace.js";
import { stableJsonHash } from "../core/stable-hash.js";
import type { CatalogRepair } from "../repairs/types.js";
import type {
  EntropyAuditCall,
  EntropyReport,
  EntropyRepairRowInput,
  EntropyTraceInput,
  EntropyValueObservation,
} from "./types.js";

const DEFAULT_TASK_KEY = "(none)";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// One Fabric execution trace becomes one meter trace. The first persisted
// workflow phase is the deterministic task key for flow entropy.
export const entropyTraceFromFabricTrace = (
  trace: FabricExecutionTraceV1,
  model?: string,
): EntropyTraceInput => ({
  operations: trace.operations.map((operation) => ({
    ref: operation.ref,
    args: operation.args,
    outcome: operation.outcome,
    ...(operation.failureStage !== undefined ? { failureStage: operation.failureStage } : {}),
  })),
  taskKey: trace.phases[0] ?? DEFAULT_TASK_KEY,
  ...(model ? { model } : {}),
});

const MODEL_CHANGE_FILTER = /"type"\s*:\s*"model_change"/;
const ASSISTANT_FILTER = /"role"\s*:\s*"assistant"/;

// Model identity for one parsed session record: `model_change` entries name
// the provider/model from that point on, and assistant messages carry the
// provider/model that produced the turn. A toolResult's producing model is
// the one active at its line, so the scan tracks it in order.
const modelFromRecord = (parsed: Record<string, unknown>): string | undefined => {
  if (parsed.type === "model_change") {
    const provider = typeof parsed.provider === "string" ? parsed.provider : "";
    const modelId = typeof parsed.modelId === "string" ? parsed.modelId : "";
    return provider && modelId ? `${provider}/${modelId}` : undefined;
  }
  const message = isRecord(parsed.message) ? parsed.message : undefined;
  if (!message || message.role !== "assistant") return undefined;
  const provider = typeof message.provider === "string" ? message.provider : "";
  const modelId = typeof message.model === "string" ? message.model : "";
  return provider && modelId ? `${provider}/${modelId}` : undefined;
};

interface ScannedSessionRecord {
  details: Record<string, unknown>;
  model?: string;
}

interface SessionScanState {
  currentModel?: string;
}

// Cheap pre-filters keep multi-session scans fast on large logs. Filtering
// happens before trim so a large prose-only JSONL record is never copied.
const scanSessionLine = (
  line: string,
  state: SessionScanState,
): ScannedSessionRecord | undefined => {
  if (line === "") return undefined;
  const traceLine = line.includes(FABRIC_EXECUTION_TRACE_KIND);
  const modelLine =
    !traceLine && (MODEL_CHANGE_FILTER.test(line) || ASSISTANT_FILTER.test(line));
  if (!traceLine && !modelLine) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.trim());
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const model = modelFromRecord(parsed);
  if (model) state.currentModel = model;
  if (!traceLine) return undefined;
  const details = isRecord(parsed.details)
    ? parsed.details
    : isRecord(parsed.message) && isRecord(parsed.message.details)
      ? parsed.message.details
      : undefined;
  return isRecord(details)
    ? { details, ...(state.currentModel ? { model: state.currentModel } : {}) }
    : undefined;
};

// One scan yields all three evidence corpora. The async form consumes a
// readline stream record-by-record, so large session files never monopolize
// Pi's TUI event loop or require a whole-file string allocation.
export interface EntropySessionEvidence {
  traces: EntropyTraceInput[];
  valueObservations: EntropyValueObservation[];
  auditCalls: EntropyAuditCall[];
}

const emptySessionEvidence = (): EntropySessionEvidence => ({
  traces: [],
  valueObservations: [],
  auditCalls: [],
});

const appendSessionRecord = (
  evidence: EntropySessionEvidence,
  record: ScannedSessionRecord,
): void => {
  const trace = readFabricExecutionTraceV1(record.details.trace);
  if (!trace) return;
  evidence.traces.push(entropyTraceFromFabricTrace(trace, record.model));
  const audits = record.details.audits;
  if (!Array.isArray(audits)) return;
  for (const audit of audits) {
    if (!isRecord(audit)) continue;
    const ref = typeof audit.ref === "string" ? audit.ref : undefined;
    const args = isRecord(audit.args) ? audit.args : undefined;
    if (!ref || !args) continue;
    evidence.auditCalls.push({ ref, args });
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        evidence.valueObservations.push({ ref, key, value });
      }
    }
  }
};

export const entropySessionEvidenceFromJsonl = (
  lines: readonly string[],
): EntropySessionEvidence => {
  const evidence = emptySessionEvidence();
  const state: SessionScanState = {};
  for (const line of lines) {
    const record = scanSessionLine(line, state);
    if (record) appendSessionRecord(evidence, record);
  }
  return evidence;
};

export interface EntropySessionEvidenceScan {
  evidence: EntropySessionEvidence;
  currentModel?: string;
}

export const scanEntropySessionJsonlAsync = async (
  lines: AsyncIterable<string>,
  initialModel?: string,
): Promise<EntropySessionEvidenceScan> => {
  const evidence = emptySessionEvidence();
  const state: SessionScanState = {
    ...(initialModel ? { currentModel: initialModel } : {}),
  };
  for await (const line of lines) {
    const record = scanSessionLine(line, state);
    if (record) appendSessionRecord(evidence, record);
  }
  return {
    evidence,
    ...(state.currentModel ? { currentModel: state.currentModel } : {}),
  };
};

export const entropySessionEvidenceFromJsonlAsync = async (
  lines: AsyncIterable<string>,
): Promise<EntropySessionEvidence> => (await scanEntropySessionJsonlAsync(lines)).evidence;

// Extract meter traces from Pi session JSONL lines. Malformed lines, non-trace
// entries, and envelopes that fail the trace guard are skipped without
// throwing; only typed, guarded trace V1 envelopes count.
export const entropyTracesFromSessionJsonl = (lines: readonly string[]): EntropyTraceInput[] =>
  entropySessionEvidenceFromJsonl(lines).traces;

// Verbatim audit arguments are the authoritative value corpus for
// enum-tighten. The observations stay local to the session record, exactly
// like the audits.
export const entropyValueObservationsFromSessionJsonl = (
  lines: readonly string[],
): EntropyValueObservation[] => entropySessionEvidenceFromJsonl(lines).valueObservations;

// One verbatim call per persisted audit: the authoritative replay corpus.
// Trace V1 projects values away per ref (external and MCP calls keep none),
// so replay validation consults these whenever a touched ref has them.
export const entropyAuditCallsFromSessionJsonl = (
  lines: readonly string[],
): EntropyAuditCall[] => entropySessionEvidenceFromJsonl(lines).auditCalls;

// Normalize catalog repair rows for the meter. `ref` is the target the row
// repairs toward: the declared key's action for key aliases, or
// provider.declared-action for action aliases.
export const entropyRepairRows = (repairs: readonly CatalogRepair[]): EntropyRepairRowInput[] =>
  repairs.map((repair) =>
    repair.kind === "keyAlias"
      ? { kind: "keyAlias", ref: repair.ref, from: repair.from, to: repair.to }
      : {
          kind: "actionAlias",
          ref: `${repair.provider}.${repair.to}`,
          from: repair.from,
          to: repair.to,
        },
  );

// Stable hash of a report — the determinism check compares these.
export const entropyReportHash = (report: EntropyReport): string => stableJsonHash(report);
