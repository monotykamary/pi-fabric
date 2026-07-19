import {
  isFabricExecutionTraceV1,
  type FabricExecutionTraceOperationV1,
  type FabricExecutionTraceV1,
} from "./trace.js";

export const FABRIC_EXECUTION_DETAILS_MAX_BYTES = 512 * 1024;

export interface FabricPersistedExecutionDetailsV1 {
  success: boolean;
  trace: FabricExecutionTraceV1;
  outputFormat?: "yaml" | "json";
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
}

export interface FabricExecutionRenderDetails {
  success?: boolean;
  error?: string;
  progress?: string;
  outputFormat?: "yaml" | "json";
  phases: string[];
  audits: FabricLegacyRenderAudit[];
}

const serializedBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

const cloneTrace = (trace: FabricExecutionTraceV1): FabricExecutionTraceV1 =>
  structuredClone(trace);

/**
 * Creates the only object stored in final fabric_exec details. Rich call
 * audits remain available to live partial rendering but are deliberately not
 * copied here. The aggregate object, not each member independently, is bound.
 */
export const createFabricPersistedExecutionDetails = (input: {
  success: boolean;
  trace: FabricExecutionTraceV1;
  outputFormat?: "yaml" | "json";
}): FabricPersistedExecutionDetailsV1 => {
  const details: FabricPersistedExecutionDetailsV1 = {
    success: input.success,
    trace: cloneTrace(input.trace),
    ...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
  };
  while (
    serializedBytes(details) > FABRIC_EXECUTION_DETAILS_MAX_BYTES &&
    details.trace.operations.length > 0
  ) {
    details.trace.operations.pop();
    details.trace.counts.droppedOperations++;
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
  };
};

const auditFromOperation = (
  operation: FabricExecutionTraceOperationV1,
): FabricLegacyRenderAudit => ({
  ref: operation.ref,
  ...(operation.action ? { tool: operation.action } : {}),
  ...(operation.provider ? { provider: operation.provider } : {}),
  success: operation.outcome === "succeeded",
  ...(operation.error ? { error: operation.error } : {}),
  ...(Object.keys(operation.args).length > 0 ? { args: operation.args } : {}),
  ...(operation.result !== undefined ? { result: operation.result } : {}),
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
    phases: oldPhases ?? trace?.phases ?? [],
    audits: oldAudits ?? trace?.operations.map(auditFromOperation) ?? [],
  };
};
