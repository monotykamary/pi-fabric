import fs from "node:fs";
import path from "node:path";
import type {
  SubagentRunRecord,
  SubagentUsage,
  SubagentWorkerOptions,
} from "../subagents/types.js";

const MAX_RUN_ERROR_CHARS = 20_000;
const MAX_RUN_TEXT_CHARS = 100_000;

export const emptyUsage = (): SubagentUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
});

export const createRunningRecord = (
  options: SubagentWorkerOptions,
  task: string,
  thinking: SubagentRunRecord["thinking"],
  startedAt: number,
): SubagentRunRecord => ({
  id: options.id,
  name: options.name,
  task,
  status: "running",
  runner: options.runner,
  transport: options.transport,
  cwd: options.cwd,
  ...(options.model ? { model: options.model } : {}),
  ...(thinking ? { thinking } : {}),
  ...(options.actorId ? { actorId: options.actorId } : {}),
  ...(options.actorName ? { actorName: options.actorName } : {}),
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

export const writeRunRecord = (filePath: string, record: SubagentRunRecord): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(record, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, filePath);
};

export const updateRunRecord = (filePath: string, record: SubagentRunRecord): void => {
  record.updatedAt = Date.now();
  writeRunRecord(filePath, record);
};

export const writeCrashRunRecord = (
  filePath: string,
  record: SubagentRunRecord,
  error: unknown,
): void => {
  const reason = error instanceof Error ? error.message : String(error);
  const crashed: SubagentRunRecord = {
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
  record: SubagentRunRecord,
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

export const latestRunText = (text: string): string =>
  Array.from(text).slice(-MAX_RUN_TEXT_CHARS).join("");
