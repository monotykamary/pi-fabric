import { projectFabricAuditArgs, projectFabricAuditResult } from "./projection.js";

export const FABRIC_EXECUTION_TRACE_KIND = "pi-fabric.execution" as const;
export const FABRIC_EXECUTION_TRACE_VERSION = 1 as const;
export const FABRIC_EXECUTION_TRACE_MAX_BYTES = 512 * 1024;

const MAX_IDENTIFIER_BYTES = 1_024;
const MAX_PHASE_BYTES = 1_024;
const MAX_STRING_BYTES = 16 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;
const MAX_ARGS_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_DEPTH = 12;
const MAX_KEYS = 128;
const MAX_ARRAY_ITEMS = 128;
const MAX_NODES = 8_192;
const MAX_RECORDED_OPERATIONS = 2_048;
const MAX_PHASES = 512;
export type FabricTraceJsonPrimitive = string | number | boolean | null;
export type FabricTraceJsonValue =
  | FabricTraceJsonPrimitive
  | FabricTraceJsonValue[]
  | { [key: string]: FabricTraceJsonValue };

export type FabricExecutionOutcomeV1 = "succeeded" | "failed" | "aborted" | "timed_out";
export type FabricExecutionFailureStageV1 =
  | "resolve"
  | "prepare"
  | "validate"
  | "approve"
  | "invoke"
  | "guard";

export interface FabricExecutionTraceOperationV1 {
  type: "call";
  sequence: number;
  ref: string;
  provider?: string;
  action?: string;
  args: { [key: string]: FabricTraceJsonValue };
  outcome: FabricExecutionOutcomeV1;
  failureStage?: FabricExecutionFailureStageV1;
  error?: string;
  result?: FabricTraceJsonValue;
}

export interface FabricExecutionTraceCountsV1 {
  droppedValues: number;
  truncatedValues: number;
  redactedValues: number;
  droppedOperations: number;
}

export interface FabricExecutionTraceV1 {
  kind: typeof FABRIC_EXECUTION_TRACE_KIND;
  version: typeof FABRIC_EXECUTION_TRACE_VERSION;
  outcome: FabricExecutionOutcomeV1;
  phases: string[];
  operations: FabricExecutionTraceOperationV1[];
  counts: FabricExecutionTraceCountsV1;
  error?: string;
}

interface MutableCounts {
  droppedValues: number;
  truncatedValues: number;
  redactedValues: number;
}

interface Sanitized<T extends FabricTraceJsonValue> {
  value: T;
  counts: MutableCounts;
}

interface MutableOperation {
  type: "call";
  sequence: number;
  ref: string;
  projectionRef: string;
  provider?: string;
  action?: string;
  args: Sanitized<{ [key: string]: FabricTraceJsonValue }>;
  outcome?: FabricExecutionOutcomeV1;
  failureStage?: FabricExecutionFailureStageV1;
  error?: Sanitized<string>;
  result?: Sanitized<FabricTraceJsonValue>;
  droppedResultValues: number;
}

const DROP = Symbol("drop");
type SanitizedNode = FabricTraceJsonValue | typeof DROP;

const emptyCounts = (): MutableCounts => ({
  droppedValues: 0,
  truncatedValues: 0,
  redactedValues: 0,
});

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");
const serializedBytes = (value: unknown): number => byteLength(JSON.stringify(value));

const truncateUtf8 = (value: string, maxBytes: number): string => {
  if (byteLength(value) <= maxBytes) return value;
  const suffix = "…[truncated]";
  const available = Math.max(0, maxBytes - byteLength(suffix));
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(value.slice(0, middle)) <= available) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}${suffix}`;
};

const boundedIdentifier = (value: string, maxBytes = MAX_IDENTIFIER_BYTES): string =>
  truncateUtf8(value, maxBytes);

const normalizedKey = (key: string): string => key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");

const isSensitiveKey = (key: string): boolean => {
  const normalized = normalizedKey(key);
  return [
    "password",
    "passwd",
    "secret",
    "token",
    "accesstoken",
    "refreshtoken",
    "authorization",
    "cookie",
    "credential",
    "credentials",
    "apikey",
    "privatekey",
    "clientsecret",
  ].some((sensitive) => normalized === sensitive || normalized.endsWith(sensitive));
};

const isMediaKey = (key: string): boolean =>
  ["media", "image", "images", "audio", "video", "base64"].includes(normalizedKey(key));

const isMediaObject = (value: Record<string, unknown>): boolean => {
  if (value.type === "image" || value.type === "audio" || value.type === "video") return true;
  const mimeType = value.mimeType ?? value.mime_type;
  return (
    typeof mimeType === "string" &&
    (mimeType.startsWith("image/") || mimeType.startsWith("audio/") || mimeType.startsWith("video/"))
  );
};

const looksLikeBase64 = (value: string): boolean => {
  if (value.startsWith("data:") && value.includes(";base64,")) return true;
  if (value.length < 1_024 || value.length % 4 !== 0) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47 ||
      code === 61 ||
      code === 10 ||
      code === 13;
    if (!valid) return false;
  }
  return true;
};

const sanitize = (input: unknown, maxBytes: number): Sanitized<FabricTraceJsonValue> => {
  const counts = emptyCounts();
  const ancestors = new Set<object>();
  let nodes = 0;

  const visit = (value: unknown, depth: number, key?: string): SanitizedNode => {
    nodes++;
    if (nodes > MAX_NODES) {
      counts.droppedValues++;
      return DROP;
    }
    if (key !== undefined && isSensitiveKey(key)) {
      counts.redactedValues++;
      return "[REDACTED]";
    }
    if (key !== undefined && isMediaKey(key)) {
      counts.droppedValues++;
      return DROP;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (Number.isFinite(value)) return value;
      counts.truncatedValues++;
      return `[non-finite:${String(value)}]`;
    }
    if (typeof value === "string") {
      if (looksLikeBase64(value)) {
        counts.droppedValues++;
        return "[OMITTED_BASE64]";
      }
      const bounded = truncateUtf8(value, MAX_STRING_BYTES);
      if (bounded !== value) counts.truncatedValues++;
      return bounded;
    }
    if (typeof value === "bigint") {
      counts.truncatedValues++;
      return `${String(value)}n`;
    }
    if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
      counts.droppedValues++;
      return DROP;
    }
    if (typeof value !== "object") {
      counts.droppedValues++;
      return DROP;
    }
    if (depth >= MAX_DEPTH) {
      counts.truncatedValues++;
      return "[MAX_DEPTH]";
    }
    if (ancestors.has(value)) {
      counts.droppedValues++;
      return "[CIRCULAR]";
    }
    const record = value as Record<string, unknown>;
    if (!Array.isArray(value) && isMediaObject(record)) {
      counts.droppedValues++;
      return "[OMITTED_MEDIA]";
    }
    ancestors.add(value);
    if (Array.isArray(value)) {
      const output: FabricTraceJsonValue[] = [];
      const limit = Math.min(value.length, MAX_ARRAY_ITEMS);
      for (let index = 0; index < limit; index++) {
        const item = visit(value[index], depth + 1);
        output.push(item === DROP ? "[DROPPED]" : item);
      }
      if (value.length > limit) {
        counts.droppedValues += value.length - limit;
        counts.truncatedValues++;
      }
      ancestors.delete(value);
      return output;
    }
    const output: { [key: string]: FabricTraceJsonValue } = {};
    const keys = Object.keys(record).sort();
    const limit = Math.min(keys.length, MAX_KEYS);
    for (let index = 0; index < limit; index++) {
      const childKey = keys[index]!;
      const child = visit(record[childKey], depth + 1, childKey);
      if (child !== DROP) output[childKey] = child;
    }
    if (keys.length > limit) {
      counts.droppedValues += keys.length - limit;
      counts.truncatedValues++;
    }
    ancestors.delete(value);
    return output;
  };

  let value = visit(input, 0);
  if (value === DROP) value = "[DROPPED]";
  const originalBytes = serializedBytes(value);
  if (originalBytes > maxBytes) {
    counts.truncatedValues++;
    if (Array.isArray(value)) {
      const output: FabricTraceJsonValue[] = [];
      for (const item of value) {
        const next = [...output, item];
        if (serializedBytes(next) > maxBytes - 128) break;
        output.push(item);
      }
      counts.droppedValues += value.length - output.length;
      value = output;
    } else if (typeof value === "object" && value !== null) {
      const output: { [key: string]: FabricTraceJsonValue } = {};
      const entries = Object.entries(value);
      let included = 0;
      for (const [childKey, child] of entries) {
        const next = { ...output, [childKey]: child };
        if (serializedBytes(next) > maxBytes - 128) break;
        output[childKey] = child;
        included++;
      }
      counts.droppedValues += entries.length - included;
      value = output;
    }
  }
  return { value, counts };
};

const sanitizeObject = (
  value: Record<string, unknown>,
  droppedValues = 0,
): Sanitized<{ [key: string]: FabricTraceJsonValue }> => {
  const sanitized = sanitize(value, MAX_ARGS_BYTES);
  sanitized.counts.droppedValues += droppedValues;
  if (typeof sanitized.value === "object" && sanitized.value !== null && !Array.isArray(sanitized.value)) {
    return sanitized as Sanitized<{ [key: string]: FabricTraceJsonValue }>;
  }
  sanitized.counts.droppedValues++;
  return { value: {}, counts: sanitized.counts };
};

const projectedArgs = (
  ref: string,
  args: Record<string, unknown>,
): Sanitized<{ [key: string]: FabricTraceJsonValue }> => {
  const projection = projectFabricAuditArgs(ref, args);
  return sanitizeObject(projection.value, projection.droppedValues);
};

const sanitizeString = (value: string, maxBytes: number): Sanitized<string> => {
  const bounded = truncateUtf8(value, maxBytes);
  return {
    value: bounded,
    counts: {
      ...emptyCounts(),
      truncatedValues: bounded === value ? 0 : 1,
    },
  };
};

const addCounts = (target: FabricExecutionTraceCountsV1, source: MutableCounts): void => {
  target.droppedValues += source.droppedValues;
  target.truncatedValues += source.truncatedValues;
  target.redactedValues += source.redactedValues;
};

const lexicalIdentity = (ref: string): { provider?: string; action?: string } => {
  const separator = ref.indexOf(".");
  if (separator <= 0 || separator === ref.length - 1) return {};
  return {
    provider: ref.slice(0, separator),
    action: ref.slice(separator + 1),
  };
};

const failureMessage = (
  stage: FabricExecutionFailureStageV1,
  outcome: FabricExecutionOutcomeV1,
): string => {
  if (outcome === "timed_out") return "Call timed out";
  if (outcome === "aborted") return "Call aborted";
  return `Call failed during ${stage}`;
};

const executionErrorMessage = (outcome: FabricExecutionOutcomeV1): string | undefined => {
  if (outcome === "succeeded") return undefined;
  if (outcome === "timed_out") return "Execution timed out";
  if (outcome === "aborted") return "Execution aborted";
  return "Execution failed";
};

export class FabricExecutionTraceOperationHandle {
  constructor(
    private readonly recorder: FabricExecutionTraceRecorder,
    private readonly operation: MutableOperation | undefined,
  ) {}

  resolved(provider: string, action: string): void {
    if (!this.operation || this.recorder.sealed) return;
    const boundedProvider = boundedIdentifier(provider);
    const boundedAction = boundedIdentifier(action);
    if (this.operation.provider !== boundedProvider) {
      this.operation.provider = this.recorder.snapshotIdentifier(provider);
    }
    if (this.operation.action !== boundedAction) {
      this.operation.action = this.recorder.snapshotIdentifier(action);
    }
  }

  prepared(args: Record<string, unknown>): void {
    if (!this.operation || this.recorder.sealed) return;
    this.operation.args = projectedArgs(this.operation.projectionRef, args);
  }

  succeed(result: unknown): void {
    if (!this.operation || this.recorder.sealed) return;
    const projected = projectFabricAuditResult(this.operation.projectionRef, result);
    if (projected !== undefined) {
      this.operation.result = sanitize(projected.value, MAX_RESULT_BYTES);
      this.operation.result.counts.droppedValues += projected.droppedValues;
    } else if (result !== undefined) {
      this.operation.droppedResultValues++;
    }
    this.operation.outcome = "succeeded";
  }

  fail(
    stage: FabricExecutionFailureStageV1,
    _error: unknown,
    outcome: FabricExecutionOutcomeV1 = "failed",
    result?: unknown,
  ): void {
    if (!this.operation || this.recorder.sealed) return;
    this.operation.failureStage = stage;
    this.operation.error = sanitizeString(failureMessage(stage, outcome), MAX_ERROR_BYTES);
    this.operation.outcome = outcome;
    const projected = projectFabricAuditResult(this.operation.projectionRef, result);
    if (projected !== undefined) {
      this.operation.result = sanitize(projected.value, MAX_RESULT_BYTES);
      this.operation.result.counts.droppedValues += projected.droppedValues;
    } else if (result !== undefined) {
      this.operation.droppedResultValues++;
    }
  }
}

export class FabricExecutionTraceRecorder {
  readonly #operations: MutableOperation[] = [];
  #nextSequence = 0;
  #droppedOperations = 0;
  #truncatedIdentifiers = 0;
  sealed = false;

  snapshotIdentifier(value: string, maxBytes = MAX_IDENTIFIER_BYTES): string {
    const bounded = boundedIdentifier(value, maxBytes);
    if (bounded !== value) this.#truncatedIdentifiers++;
    return bounded;
  }

  issueCall(ref: string, args: Record<string, unknown>): FabricExecutionTraceOperationHandle {
    const sequence = this.#nextSequence++;
    if (this.sealed || this.#operations.length >= MAX_RECORDED_OPERATIONS) {
      this.#droppedOperations++;
      return new FabricExecutionTraceOperationHandle(this, undefined);
    }
    const identity = lexicalIdentity(ref);
    const operation: MutableOperation = {
      type: "call",
      sequence,
      ref: this.snapshotIdentifier(ref),
      projectionRef: ref,
      ...(identity.provider ? { provider: this.snapshotIdentifier(identity.provider) } : {}),
      ...(identity.action ? { action: this.snapshotIdentifier(identity.action) } : {}),
      args: projectedArgs(ref, args),
      droppedResultValues: 0,
    };
    this.#operations.push(operation);
    return new FabricExecutionTraceOperationHandle(this, operation);
  }

  seal(
    outcome: FabricExecutionOutcomeV1,
    phases: readonly string[],
    _error?: string,
  ): FabricExecutionTraceV1 {
    this.sealed = true;
    for (const operation of this.#operations) {
      if (!operation.outcome) {
        operation.outcome = outcome === "timed_out" ? "timed_out" : outcome === "aborted" ? "aborted" : "failed";
        operation.failureStage ??= "invoke";
      } else if (operation.outcome === "aborted" && outcome === "timed_out") {
        // Host calls observe an aborted bridge signal for both cancellation and
        // deadline expiry. The runtime's typed final termination is
        // authoritative when sealing the durable operation.
        operation.outcome = "timed_out";
      }
      if (operation.outcome !== "succeeded") {
        operation.error = sanitizeString(
          failureMessage(operation.failureStage ?? "invoke", operation.outcome),
          MAX_ERROR_BYTES,
        );
      }
    }

    const counts: FabricExecutionTraceCountsV1 = {
      droppedValues: 0,
      truncatedValues: this.#truncatedIdentifiers,
      redactedValues: 0,
      droppedOperations: this.#droppedOperations,
    };
    const operations = this.#operations.map((operation): FabricExecutionTraceOperationV1 => {
      addCounts(counts, operation.args.counts);
      counts.droppedValues += operation.droppedResultValues;
      if (operation.error) addCounts(counts, operation.error.counts);
      if (operation.result) addCounts(counts, operation.result.counts);
      return {
        type: "call",
        sequence: operation.sequence,
        ref: operation.ref,
        ...(operation.provider ? { provider: operation.provider } : {}),
        ...(operation.action ? { action: operation.action } : {}),
        args: operation.args.value,
        outcome: operation.outcome!,
        ...(operation.failureStage ? { failureStage: operation.failureStage } : {}),
        ...(operation.error ? { error: operation.error.value } : {}),
        ...(operation.result ? { result: operation.result.value } : {}),
      };
    });
    const boundedPhases = phases.slice(0, MAX_PHASES).map((phase) => {
      const bounded = boundedIdentifier(phase, MAX_PHASE_BYTES);
      if (bounded !== phase) counts.truncatedValues++;
      return bounded;
    });
    if (phases.length > boundedPhases.length) {
      counts.droppedValues += phases.length - boundedPhases.length;
      counts.truncatedValues++;
    }
    const safeRunError = executionErrorMessage(outcome);
    const runError = safeRunError ? sanitizeString(safeRunError, MAX_ERROR_BYTES) : undefined;
    if (runError) addCounts(counts, runError.counts);
    const trace: FabricExecutionTraceV1 = {
      kind: FABRIC_EXECUTION_TRACE_KIND,
      version: FABRIC_EXECUTION_TRACE_VERSION,
      outcome,
      phases: boundedPhases,
      operations,
      counts,
      ...(runError ? { error: runError.value } : {}),
    };

    let traceBytes = serializedBytes(trace);
    for (let index = trace.operations.length - 1; traceBytes > FABRIC_EXECUTION_TRACE_MAX_BYTES && index >= 0; index--) {
      const operation = trace.operations[index]!;
      if (operation.result !== undefined) {
        delete operation.result;
        trace.counts.droppedValues++;
        traceBytes = serializedBytes(trace);
      }
    }
    for (let index = trace.operations.length - 1; traceBytes > FABRIC_EXECUTION_TRACE_MAX_BYTES && index >= 0; index--) {
      const operation = trace.operations[index]!;
      if (Object.keys(operation.args).length > 0) {
        operation.args = {};
        trace.counts.droppedValues++;
        trace.counts.truncatedValues++;
        traceBytes = serializedBytes(trace);
      }
    }
    while (traceBytes > FABRIC_EXECUTION_TRACE_MAX_BYTES && trace.operations.length > 0) {
      trace.operations.pop();
      trace.counts.droppedOperations++;
      traceBytes = serializedBytes(trace);
    }
    while (traceBytes > FABRIC_EXECUTION_TRACE_MAX_BYTES && trace.phases.length > 0) {
      trace.phases.pop();
      trace.counts.droppedValues++;
      traceBytes = serializedBytes(trace);
    }
    return trace;
  }
}

export const executionOutcomeFromError = (
  error: unknown,
  signal?: AbortSignal,
): FabricExecutionOutcomeV1 => {
  if (signal?.aborted) return "aborted";
  return error === undefined ? "succeeded" : "failed";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

const outcomes = new Set<FabricExecutionOutcomeV1>(["succeeded", "failed", "aborted", "timed_out"]);
const stages = new Set<FabricExecutionFailureStageV1>(["resolve", "prepare", "validate", "approve", "invoke", "guard"]);

const isJsonValue = (value: unknown, ancestors = new Set<object>(), depth = 0): value is FabricTraceJsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > MAX_DEPTH + 2 || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors, depth + 1))
    : Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, ancestors, depth + 1));
  ancestors.delete(value);
  return valid;
};

const isFabricExecutionTraceOperationV1Unchecked = (
  value: unknown,
): value is FabricExecutionTraceOperationV1 => {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ["type", "sequence", "ref", "provider", "action", "args", "outcome", "failureStage", "error", "result"])) return false;
  if (value.type !== "call" || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0) return false;
  if (typeof value.ref !== "string" || !isRecord(value.args) || !isJsonValue(value.args)) return false;
  if (!outcomes.has(value.outcome as FabricExecutionOutcomeV1)) return false;
  if (value.provider !== undefined && typeof value.provider !== "string") return false;
  if (value.action !== undefined && typeof value.action !== "string") return false;
  if (value.failureStage !== undefined && !stages.has(value.failureStage as FabricExecutionFailureStageV1)) return false;
  if (value.error !== undefined && typeof value.error !== "string") return false;
  return value.result === undefined || isJsonValue(value.result);
};

export const isFabricExecutionTraceOperationV1 = (
  value: unknown,
): value is FabricExecutionTraceOperationV1 => {
  try {
    return isFabricExecutionTraceOperationV1Unchecked(value);
  } catch {
    return false;
  }
};

const isFabricExecutionTraceV1Unchecked = (value: unknown): value is FabricExecutionTraceV1 => {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ["kind", "version", "outcome", "phases", "operations", "counts", "error"])) return false;
  if (value.kind !== FABRIC_EXECUTION_TRACE_KIND || value.version !== FABRIC_EXECUTION_TRACE_VERSION) return false;
  if (!outcomes.has(value.outcome as FabricExecutionOutcomeV1)) return false;
  if (!Array.isArray(value.phases) || !value.phases.every((phase) => typeof phase === "string")) return false;
  if (!Array.isArray(value.operations) || !value.operations.every(isFabricExecutionTraceOperationV1)) return false;
  if (!isRecord(value.counts) || !hasOnlyKeys(value.counts, ["droppedValues", "truncatedValues", "redactedValues", "droppedOperations"])) return false;
  const counts = value.counts;
  if (!["droppedValues", "truncatedValues", "redactedValues", "droppedOperations"].every((key) => Number.isSafeInteger(counts[key]) && (counts[key] as number) >= 0)) return false;
  if (value.error !== undefined && typeof value.error !== "string") return false;
  for (let index = 1; index < value.operations.length; index++) {
    if (value.operations[index]!.sequence <= value.operations[index - 1]!.sequence) return false;
  }
  return serializedBytes(value) <= FABRIC_EXECUTION_TRACE_MAX_BYTES;
};

export const isFabricExecutionTraceV1 = (value: unknown): value is FabricExecutionTraceV1 => {
  try {
    return isFabricExecutionTraceV1Unchecked(value);
  } catch {
    return false;
  }
};

export const readFabricExecutionTraceV1 = (value: unknown): FabricExecutionTraceV1 | undefined =>
  isFabricExecutionTraceV1(value) ? value : undefined;
