import type { FabricKernel } from "../runtime/kernel.js";
import {
  isFabricExecutionTraceV1,
  type FabricExecutionTraceOperationV1,
  type FabricExecutionTraceV1,
} from "./trace.js";

export const FABRIC_EXECUTION_DETAILS_MAX_BYTES = 512 * 1024;

export interface FabricPersistedExecutionDetailsV1 {
  success: boolean;
  kernel?: FabricKernel;
  trace: FabricExecutionTraceV1;
  /** Rich render audits persisted verbatim (minus in-memory media) so a resumed transcript re-renders — and expands — exactly like the live one. */
  audits: FabricLegacyRenderAudit[];
  phases: string[];
  error?: string;
  outputFormat?: "yaml" | "json";
  outputFormatStartLine?: number;
  outputFormatLines?: number;
}

/**
 * The audit fields that cross into the session record; read back by
 * {@link legacyAudit}. In-memory-only payloads (image blocks, media notes,
 * correlation ids) never persist.
 */
export interface FabricPersistableAuditInput {
  ref: string;
  tool?: string;
  provider?: string;
  success?: boolean;
  error?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  resultTruncated?: boolean;
  preview?: unknown;
  startedAt?: number;
  endedAt?: number;
}

export interface FabricLegacyRenderAudit {
  ref: string;
  tool?: string;
  provider?: string;
  success?: boolean;
  error?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  resultTruncated?: boolean;
  preview?: unknown;
  /** Set only when reconstructed from the durable trace: args are privacy-projected and results/previews are not retained. */
  fromTrace?: boolean;
  startedAt?: number;
  endedAt?: number;
}

export interface FabricExecutionRenderDetails {
  success?: boolean;
  kernel?: FabricKernel;
  error?: string;
  progress?: string;
  outputFormat?: "yaml" | "json";
  outputFormatStartLine?: number;
  outputFormatLines?: number;
  phases: string[];
  audits: FabricLegacyRenderAudit[];
}

const serializedBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

const cloneTrace = (trace: FabricExecutionTraceV1): FabricExecutionTraceV1 =>
  structuredClone(trace);

const persistableAudit = (audit: FabricPersistableAuditInput): FabricLegacyRenderAudit =>
  structuredClone({
    ref: audit.ref,
    ...(audit.tool !== undefined ? { tool: audit.tool } : {}),
    ...(audit.provider !== undefined ? { provider: audit.provider } : {}),
    ...(audit.success !== undefined ? { success: audit.success } : {}),
    ...(audit.error !== undefined ? { error: audit.error } : {}),
    ...(audit.args !== undefined ? { args: audit.args } : {}),
    ...(audit.result !== undefined ? { result: audit.result } : {}),
    ...(audit.resultTruncated !== undefined ? { resultTruncated: audit.resultTruncated } : {}),
    ...(audit.preview !== undefined ? { preview: audit.preview } : {}),
    ...(audit.startedAt !== undefined ? { startedAt: audit.startedAt } : {}),
    ...(audit.endedAt !== undefined ? { endedAt: audit.endedAt } : {}),
  });

/**
 * Creates the only object stored in final fabric_exec details. The
 * privacy-projected trace stays the functional record for compaction and tool
 * ownership; rich call audits persist verbatim (minus in-memory media) so a
 * resumed transcript re-renders and expands exactly like the live one — the
 * collapsed display, not the session record, is the visual boundary. The
 * aggregate object, not each member independently, is bound; display-only
 * audits trim before the functional trace.
 */
export const createFabricPersistedExecutionDetails = (input: {
  success: boolean;
  kernel?: FabricKernel;
  trace: FabricExecutionTraceV1;
  audits?: readonly FabricPersistableAuditInput[];
  phases?: readonly string[];
  error?: string;
  outputFormat?: "yaml" | "json";
  outputFormatStartLine?: number;
  outputFormatLines?: number;
}): FabricPersistedExecutionDetailsV1 => {
  const details: FabricPersistedExecutionDetailsV1 = {
    success: input.success,
    ...(input.kernel ? { kernel: input.kernel } : {}),
    trace: cloneTrace(input.trace),
    audits: (input.audits ?? []).map(persistableAudit),
    phases: (input.phases ?? []).filter((phase): phase is string => typeof phase === "string"),
    ...(typeof input.error === "string" && input.error ? { error: input.error } : {}),
    ...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
    ...(input.outputFormatStartLine !== undefined
      ? { outputFormatStartLine: Math.max(0, Math.floor(input.outputFormatStartLine)) }
      : {}),
    ...(input.outputFormatLines !== undefined
      ? { outputFormatLines: Math.max(0, Math.floor(input.outputFormatLines)) }
      : {}),
  };
  while (
    serializedBytes(details) > FABRIC_EXECUTION_DETAILS_MAX_BYTES &&
    details.audits.length > 0
  ) {
    details.audits.pop();
  }
  while (
    serializedBytes(details) > FABRIC_EXECUTION_DETAILS_MAX_BYTES &&
    details.trace.operations.length > 0
  ) {
    details.trace.operations.pop();
    details.trace.counts.droppedOperations++;
  }
  while (
    serializedBytes(details) > FABRIC_EXECUTION_DETAILS_MAX_BYTES &&
    details.phases.length > 0
  ) {
    details.phases.pop();
  }
  while (
    serializedBytes(details) > FABRIC_EXECUTION_DETAILS_MAX_BYTES &&
    details.trace.phases.length > 0
  ) {
    details.trace.phases.pop();
    details.trace.counts.droppedValues++;
  }
  if (serializedBytes(details) > FABRIC_EXECUTION_DETAILS_MAX_BYTES) {
    delete details.trace.error;
    details.trace.counts.droppedValues++;
  }
  return details;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const legacyAudit = (value: unknown): FabricLegacyRenderAudit | undefined => {
  if (!isRecord(value) || typeof value.ref !== "string") return undefined;
  return {
    ref: value.ref,
    ...(typeof value.tool === "string" ? { tool: value.tool } : {}),
    ...(typeof value.provider === "string" ? { provider: value.provider } : {}),
    ...(typeof value.success === "boolean" ? { success: value.success } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(isRecord(value.args) ? { args: value.args } : {}),
    ...(value.result !== undefined ? { result: value.result } : {}),
    ...(typeof value.resultTruncated === "boolean"
      ? { resultTruncated: value.resultTruncated }
      : {}),
    ...(value.preview !== undefined ? { preview: value.preview } : {}),
    ...(typeof value.startedAt === "number" ? { startedAt: value.startedAt } : {}),
    ...(typeof value.endedAt === "number" ? { endedAt: value.endedAt } : {}),
  };
};

const auditFromOperation = (
  operation: FabricExecutionTraceOperationV1,
): FabricLegacyRenderAudit => ({
  ref: operation.ref,
  fromTrace: true,
  ...(operation.action ? { tool: operation.action } : {}),
  ...(operation.provider ? { provider: operation.provider } : {}),
  success: operation.outcome === "succeeded",
  ...(operation.error ? { error: operation.error } : {}),
  ...(Object.keys(operation.args).length > 0 ? { args: operation.args } : {}),
  ...(operation.result !== undefined ? { result: operation.result } : {}),
  ...(operation.resultTruncated === true ? { resultTruncated: true } : {}),
});

/**
 * Adapts both old audit-bearing session details and current trace-only details
 * for rendering. Legacy audits win when present so old transcripts retain
 * their historical rich previews.
 */
export const readFabricExecutionRenderDetails = (
  value: unknown,
): FabricExecutionRenderDetails => {
  if (!isRecord(value)) return { audits: [], phases: [] };
  const trace = isFabricExecutionTraceV1(value.trace) ? value.trace : undefined;
  const oldAudits = Array.isArray(value.audits)
    ? value.audits.map(legacyAudit).filter((audit): audit is FabricLegacyRenderAudit => audit !== undefined)
    : undefined;
  const oldPhases = Array.isArray(value.phases)
    ? value.phases.filter((phase): phase is string => typeof phase === "string")
    : undefined;
  return {
    ...(value.kernel === "typescript" || value.kernel === "python" ? { kernel: value.kernel } : {}),
    ...(typeof value.success === "boolean"
      ? { success: value.success }
      : trace
        ? { success: trace.outcome === "succeeded" }
        : {}),
    ...(typeof value.error === "string"
      ? { error: value.error }
      : trace?.error
        ? { error: trace.error }
        : {}),
    ...(typeof value.progress === "string" ? { progress: value.progress } : {}),
    ...(value.outputFormat === "yaml" || value.outputFormat === "json"
      ? { outputFormat: value.outputFormat }
      : {}),
    ...(typeof value.outputFormatStartLine === "number" &&
      Number.isFinite(value.outputFormatStartLine) &&
      value.outputFormatStartLine >= 0
      ? { outputFormatStartLine: Math.floor(value.outputFormatStartLine) }
      : {}),
    ...(typeof value.outputFormatLines === "number" &&
      Number.isFinite(value.outputFormatLines) &&
      value.outputFormatLines >= 0
      ? { outputFormatLines: Math.floor(value.outputFormatLines) }
      : {}),
    phases: oldPhases ?? trace?.phases ?? [],
    audits: oldAudits ?? trace?.operations.map(auditFromOperation) ?? [],
  };
};
