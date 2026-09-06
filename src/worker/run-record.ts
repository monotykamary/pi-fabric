import fs from "node:fs";
import path from "node:path";
import type {
  AgentRunRecord,
  AgentUsage,
  AgentWorkerOptions,
} from "../agents/types.js";

const MAX_RUN_ERROR_CHARS = 20_000;
const MAX_RUN_TEXT_CHARS = 100_000;

export const emptyUsage = (): AgentUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
});

export const createRunningRecord = (
  options: AgentWorkerOptions,
  task: string,
  thinking: AgentRunRecord["thinking"],
  startedAt: number,
): AgentRunRecord => ({
  id: options.id,
  name: options.name,
  task,
  status: "running",
  runner: options.runner,
  ...(options.kernel ? { kernel: options.kernel } : {}),
  transport: options.transport,
  cwd: options.cwd,
  ...(options.model ? { model: options.model } : {}),
  ...(thinking ? { thinking } : {}),
  ...(options.actorId ? { actorId: options.actorId } : {}),
  ...(options.actorName ? { actorName: options.actorName } : {}),
  ...(options.capabilityRequirements
    ? { capabilityRequirements: [...options.capabilityRequirements] }
    : {}),
  ...(options.capabilityDigest ? { capabilityDigest: options.capabilityDigest } : {}),
  startedAt,
  updatedAt: startedAt,
  turns: 0,
  toolCalls: 0,
  text: "",
  usage: emptyUsage(),
  logFile: options.logFile,
  ...(options.branch ? { branch: options.branch } : {}),
  ...(options.worktree ? { worktree: options.worktree } : {}),
});

export const writeRunRecord = (filePath: string, record: AgentRunRecord): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(record, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  renameWithRetry(temporaryPath, filePath);
};

// Windows transiently rejects rename() with EPERM/EACCES/EEXIST/EBUSY while
// an antivirus scan or sibling reader probes the destination file —
// milliseconds of contention, not policy. Retry a bounded linear backoff
// before surfacing.
//
// Self-contained on purpose: this module is dynamically imported by the
// spawned worker through plain Node with worker.ts switching the import
// extension, so it must not depend on ../core/atomic-write.js. Keep the shared
// implementation for the host side and this copy for the worker boundary.
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EEXIST", "EBUSY"]);

const syncSleep = (ms: number): void => {
  try {
    const buffer = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buffer, 0, 0, ms);
  } catch {
    // Atomics.wait unavailable: retry immediately — correct, just busier.
  }
};

const renameWithRetry = (source: string, target: string): void => {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(source, target);
      return;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : undefined;
      if (attempt >= 8 || code === undefined || !RETRYABLE_RENAME_CODES.has(code)) {
        throw error;
      }
      syncSleep(25 * attempt);
    }
  }
};

export const updateRunRecord = (filePath: string, record: AgentRunRecord): void => {
  record.updatedAt = Date.now();
  writeRunRecord(filePath, record);
};

export const writeCrashRunRecord = (
  filePath: string,
  record: AgentRunRecord,
  error: unknown,
): void => {
  const reason = error instanceof Error ? error.message : String(error);
  const crashed: AgentRunRecord = {
    ...record,
    status: "failed",
    error: `Worker crashed before reporting a result: ${reason}`.slice(0, MAX_RUN_ERROR_CHARS),
    finishedAt: Date.now(),
    updatedAt: Date.now(),
  };
  delete crashed.currentTool;
  writeRunRecord(filePath, crashed);
};

const numberField = (value: unknown): number => (typeof value === "number" ? value : 0);

export const applyUsage = (
  record: AgentRunRecord,
  message: Record<string, unknown>,
): void => {
  const usage = message.usage;
  if (typeof usage !== "object" || usage === null) return;
  const values = usage as Record<string, unknown>;
  record.usage.input += numberField(values.input);
  record.usage.output += numberField(values.output);
  record.usage.cacheRead += numberField(values.cacheRead);
  record.usage.cacheWrite += numberField(values.cacheWrite);
  const cost = values.cost;
  if (typeof cost === "number") record.usage.cost += cost;
  if (typeof cost === "object" && cost !== null) {
    record.usage.cost += numberField((cost as Record<string, unknown>).total);
  }
};

/**
 * Extract the per-message token delta a Pi assistant `message_end` contributed.
 * Unlike `applyUsage`, which mutates the run record, this returns the delta so
 * the worker can attribute a single event without re-deriving it from a
 * post-hoc cumulative diff. Cost is reported in the runner's own total units.
 */
export const extractUsageDelta = (
  message: Record<string, unknown>,
): { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } | undefined => {
  const usage = message.usage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return undefined;
  const values = usage as Record<string, unknown>;
  const cost = values.cost;
  return {
    input: numberField(values.input),
    output: numberField(values.output),
    cacheRead: numberField(values.cacheRead),
    cacheWrite: numberField(values.cacheWrite),
    cost:
      typeof cost === "number"
        ? cost
        : typeof cost === "object" && cost !== null
          ? numberField((cost as Record<string, unknown>).total)
          : 0,
  };
};

export const latestRunText = (text: string): string =>
  Array.from(text).slice(-MAX_RUN_TEXT_CHARS).join("");
