import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FabricSubagentConfig, FabricSubagentTransport } from "../config.js";
import { Semaphore } from "./semaphore.js";
import { removeTree } from "./rm.js";
import { LocaltermTransport } from "./transports/localterm-transport.js";
import { ProcessTransport } from "./transports/process-transport.js";
import { ScreenTransport } from "./transports/screen-transport.js";
import { TmuxTransport } from "./transports/tmux-transport.js";
import type {
  FabricBudgetSummary,
  FabricLogLine,
  FabricSubagentLog,
  SubagentHandleInfo,
  SubagentRunRecord,
  SubagentRunRequest,
  SubagentRunResult,
  SubagentTransportAdapter,
  SubagentTransportHandle,
} from "./types.js";
import { WorktreeManager } from "./worktree-manager.js";
import {
  activeBudgetState,
  appendBudgetLedger,
  clearOwnedBudgetEnv,
  initBudgetLedger,
  readBudgetLedger,
} from "./budget-ledger.js";
import type { BudgetLedgerState } from "./budget-ledger.js";

const STATUS_POLL_MS = 100;
const TRANSPORT_EXIT_GRACE_MS = 1_000;
const MAX_NAME_LENGTH = 60;

interface ManagedSubagent {
  id: string;
  name: string;
  task: string;
  cwd: string;
  statusFile: string;
  runDirectory: string;
  transport: SubagentTransportHandle;
  result: Promise<SubagentRunResult>;
  resolve(result: SubagentRunResult): void;
  release(): void;
  abortSignal: AbortSignal | undefined;
  abortHandler: (() => void) | undefined;
  model?: string;
  thinking?: SubagentRunRequest["thinking"];
  actorId?: string;
  actorName?: string;
  branch?: string;
  worktree?: string;
  settled: boolean;
  background: boolean;
}

const terminalStatuses = new Set(["completed", "failed", "stopped", "timed_out"]);

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const safeName = (value: string): string =>
  value
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH) || "Fabric subagent";

const readRecord = (filePath: string): SubagentRunRecord | undefined => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as SubagentRunRecord;
  } catch {
    return undefined;
  }
};

const readNestedAgents = (runDirectory: string): SubagentRunRecord[] => {
  const nestedRoot = path.join(runDirectory, "nested");
  let entries: string[];
  try {
    entries = fs.readdirSync(nestedRoot);
  } catch {
    return [];
  }
  const agents: SubagentRunRecord[] = [];
  for (const entry of entries) {
    const record = readRecord(path.join(nestedRoot, entry, "status.json"));
    if (record) agents.push(record);
  }
  return agents;
};

const readJsonlTail = (filePath: string, lines: number): FabricLogLine[] => {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const all = content.split("\n").filter((line) => line.length > 0);
  const tail = all.slice(-lines);
  const offset = all.length - tail.length;
  return tail.map((raw, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* keep raw only */
    }
    return { index: offset + index, raw, ...(parsed !== undefined ? { parsed } : {}) };
  });
};

const summarizeRunLog = (runDirectory: string, lines: number): string => {
  const tail = readJsonlTail(path.join(runDirectory, "events.jsonl"), lines);
  const summary: string[] = [];
  for (const entry of tail) {
    const parsed = entry.parsed as Record<string, unknown> | undefined;
    if (!parsed || typeof parsed.type !== "string") continue;
    const detail =
      typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.message === "string"
          ? parsed.message
          : typeof parsed.toolName === "string"
            ? parsed.toolName
            : "";
    summary.push(detail ? `${parsed.type}: ${detail}` : parsed.type);
  }
  return summary.join(" | ");
};

const writeRecord = (filePath: string, record: SubagentRunRecord): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(record, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, filePath);
};

const failedRecord = (
  managed: Omit<
    ManagedSubagent,
    "result" | "resolve" | "release" | "abortSignal" | "abortHandler" | "settled"
  >,
  status: "failed" | "stopped" | "timed_out",
  error: string,
): SubagentRunResult => {
  const now = Date.now();
  return {
    id: managed.id,
    name: managed.name,
    task: managed.task,
    status,
    transport: managed.transport.kind,
    cwd: managed.cwd,
    startedAt: now,
    updatedAt: now,
    finishedAt: now,
    turns: 0,
    toolCalls: 0,
    text: "",
    error,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    ...(managed.model ? { model: managed.model } : {}),
    ...(managed.thinking ? { thinking: managed.thinking } : {}),
    ...(managed.actorId ? { actorId: managed.actorId } : {}),
    ...(managed.actorName ? { actorName: managed.actorName } : {}),
    ...(managed.transport.sessionId ? { sessionId: managed.transport.sessionId } : {}),
    ...(managed.transport.attachCommand ? { attachCommand: managed.transport.attachCommand } : {}),
    ...(managed.branch ? { branch: managed.branch } : {}),
    ...(managed.worktree ? { worktree: managed.worktree } : {}),
  };
};

export class SubagentManager {
  readonly #runs = new Map<string, ManagedSubagent>();
  readonly #semaphore: Semaphore;
  readonly #worktrees = new WorktreeManager();
  readonly #runRoot: string;
  readonly #workerPath: string;
  readonly #fabricExtensionPath: string;
  readonly #piBinary: string;
  readonly #currentDepth: number;
  readonly #fullCodeMode: boolean;
  readonly #transports: Map<FabricSubagentTransport, SubagentTransportAdapter>;
  readonly #onBackgroundComplete: ((result: SubagentRunResult) => void) | undefined;
  readonly #budget: BudgetLedgerState | undefined;
  readonly #budgetOwned: boolean;
  #closing = false;

  constructor(
    readonly cwd: string,
    readonly config: FabricSubagentConfig,
    options: {
      workerPath?: string;
      fabricExtensionPath?: string;
      piBinary?: string;
      runRoot?: string;
      fullCodeMode?: boolean;
      onBackgroundComplete?: (result: SubagentRunResult) => void;
    } = {},
  ) {
    this.#semaphore = new Semaphore(config.maxConcurrent);
    this.#runRoot =
      options.runRoot ?? process.env.PI_FABRIC_RUN_ROOT ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-runs-"));
    this.#workerPath =
      options.workerPath ?? fileURLToPath(new URL("../worker.js", import.meta.url));
    this.#fabricExtensionPath =
      options.fabricExtensionPath ?? fileURLToPath(new URL("../index.js", import.meta.url));
    this.#piBinary = options.piBinary ?? process.env.PI_FABRIC_PI_BINARY ?? "pi";
    this.#onBackgroundComplete = options.onBackgroundComplete;
    this.#currentDepth = Math.max(0, Number(process.env.PI_FABRIC_DEPTH ?? "0") || 0);
    this.#fullCodeMode = options.fullCodeMode ?? true;
    const inheritedBudget = activeBudgetState();
    this.#budget =
      inheritedBudget ??
      (this.#currentDepth === 0 && config.budgetUsd > 0
        ? initBudgetLedger(config.budgetUsd)
        : undefined);
    this.#budgetOwned =
      !inheritedBudget && this.#currentDepth === 0 && config.budgetUsd > 0;
    const adapters: SubagentTransportAdapter[] = [
      new ProcessTransport(),
      new TmuxTransport(),
      new ScreenTransport(),
      new LocaltermTransport(),
    ];
    this.#transports = new Map(adapters.map((adapter) => [adapter.kind, adapter]));
  }

  async spawn(request: SubagentRunRequest, signal?: AbortSignal): Promise<SubagentHandleInfo> {
    if (!this.config.enabled) throw new Error("Subagents are disabled in Fabric configuration");
    if (this.#currentDepth >= this.config.maxDepth) {
      throw new Error(`Fabric subagent depth limit reached (${this.config.maxDepth})`);
    }
    if (!request.task.trim()) throw new Error("Subagent task must not be empty");
    if (this.#budget) {
      const spent = readBudgetLedger(this.#budget.file).cost;
      if (spent >= this.#budget.budget) {
        throw new Error(
          `Fabric recursion budget exceeded: spent $${spent.toFixed(6)} of $${this.#budget.budget.toFixed(6)}. Increase subagents.budgetUsd or simplify the task.`,
        );
      }
    }
    const release = await this.#semaphore.acquire(signal);
    const id = randomUUID().replaceAll("-", "");
    const name = safeName(request.name ?? request.task.split("\n", 1)[0] ?? "Fabric subagent");
    const runDirectory = path.join(this.#runRoot, id);
    fs.mkdirSync(runDirectory, { recursive: true });
    const taskFile = path.join(runDirectory, "task.txt");
    const statusFile = path.join(runDirectory, "status.json");
    const logFile = path.join(runDirectory, "events.jsonl");
    const schemaFile = request.schema ? path.join(runDirectory, "schema.json") : undefined;
    fs.writeFileSync(taskFile, request.task, { encoding: "utf8", mode: 0o600 });
    if (schemaFile) {
      fs.writeFileSync(schemaFile, JSON.stringify(request.schema, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
    }

    let agentCwd = this.cwd;
    let branch: string | undefined;
    let worktree: string | undefined;
    if (request.worktree) {
      try {
        const lease = await this.#worktrees.create(id, this.cwd, name);
        agentCwd = lease.path;
        branch = lease.branch;
        worktree = lease.path;
      } catch (error) {
        release();
        throw error;
      }
    }

    try {
      const adapter = await this.#resolveTransport(request.transport ?? this.config.transport);
      const tools = this.#childTools(request);
      const timeoutMs = Math.max(
        1_000,
        Math.min(request.timeoutMs ?? this.config.timeoutMs, 3_600_000),
      );
      const model = request.model ?? this.config.model;
      const thinking = request.thinking ?? this.config.thinking;
      const workerArguments = [
        "--id",
        id,
        "--name",
        name,
        "--task-file",
        taskFile,
        "--status-file",
        statusFile,
        "--log-file",
        logFile,
        "--cwd",
        agentCwd,
        "--pi-binary",
        this.#piBinary,
        "--timeout-ms",
        String(timeoutMs),
        "--depth",
        String(this.#currentDepth + 1),
        "--full-code-mode",
        String(request.recursive === true && this.#fullCodeMode),
        "--extensions",
        String(request.recursive ? true : (request.extensions ?? this.config.extensions)),
        "--tools",
        JSON.stringify(tools),
        "--granted-risks",
        JSON.stringify(request.recursive ? ["agent"] : []),
        "--transport",
        adapter.kind,
        ...(request.recursive ? ["--fabric-extension", this.#fabricExtensionPath] : []),
        ...(model ? ["--model", model] : []),
        ...(thinking ? ["--thinking", thinking] : []),
        ...(request.systemPrompt ? ["--system-prompt", request.systemPrompt] : []),
        ...(request.sessionFile ? ["--session-file", request.sessionFile] : []),
        ...(request.actorId ? ["--actor-id", request.actorId] : []),
        ...(request.actorName ? ["--actor-name", request.actorName] : []),
        ...(request.meshRoot ? ["--mesh-root", request.meshRoot] : []),
        "--run-root",
        path.join(runDirectory, "nested"),
        ...(schemaFile ? ["--schema-file", schemaFile] : []),
        ...(branch ? ["--branch", branch] : []),
        ...(worktree ? ["--worktree", worktree] : []),
      ];
      const transport = await adapter.launch({
        id,
        name,
        cwd: agentCwd,
        workerPath: this.#workerPath,
        workerArguments,
      });
      let resolveResult: ((result: SubagentRunResult) => void) | undefined;
      const result = new Promise<SubagentRunResult>((resolve) => {
        resolveResult = resolve;
      });
      if (!resolveResult) throw new Error("Failed to create subagent result promise");
      if (signal?.aborted) {
        await transport.stop();
        throw new Error("Subagent launch aborted");
      }
      const managed: ManagedSubagent = {
        id,
        name,
        task: request.task,
        cwd: agentCwd,
        statusFile,
        runDirectory,
        transport,
        result,
        resolve: resolveResult,
        release,
        abortSignal: signal,
        abortHandler: undefined,
        ...(model ? { model } : {}),
        ...(thinking ? { thinking } : {}),
        ...(request.actorId ? { actorId: request.actorId } : {}),
        ...(request.actorName ? { actorName: request.actorName } : {}),
        ...(branch ? { branch } : {}),
        ...(worktree ? { worktree } : {}),
        settled: false,
        background: false,
      };
      if (signal) {
        managed.abortHandler = () => void this.stop(id);
        signal.addEventListener("abort", managed.abortHandler, { once: true });
      }
      this.#runs.set(id, managed);
      void this.#monitor(managed, timeoutMs);
      return this.#handleInfo(managed, "running");
    } catch (error) {
      release();
      if (worktree) await this.#worktrees.cleanup(id, true).catch(() => false);
      throw error;
    }
  }

  async run(request: SubagentRunRequest, signal?: AbortSignal): Promise<SubagentRunResult> {
    const handle = await this.spawn(request, signal);
    return this.wait(handle.id);
  }

  async wait(id: string): Promise<SubagentRunResult> {
    const managed = this.#requireRun(id);
    managed.background = false;
    return managed.result;
  }

  detachSignal(id: string): void {
    const managed = this.#requireRun(id);
    if (managed.abortSignal && managed.abortHandler) {
      managed.abortSignal.removeEventListener("abort", managed.abortHandler);
    }
    managed.abortSignal = undefined;
    managed.abortHandler = undefined;
    managed.background = true;
  }

  status(id: string): SubagentRunRecord | SubagentHandleInfo {
    const managed = this.#requireRun(id);
    const record = readRecord(managed.statusFile);
    if (!record) return this.#handleInfo(managed, "running");
    return this.#withTransportMetadata(record, managed);
  }

  list(): Array<SubagentRunRecord | SubagentHandleInfo> {
    return [...this.#runs.keys()].map((id) => this.status(id));
  }

  runDirectory(id: string): string | undefined {
    return this.#runs.get(id)?.runDirectory;
  }

  async stop(id: string): Promise<SubagentRunResult> {
    const managed = this.#requireRun(id);
    if (managed.settled) return managed.result;
    managed.background = false;
    const existing = readRecord(managed.statusFile);
    if (existing && terminalStatuses.has(existing.status)) {
      const result = this.#withTransportMetadata(existing, managed) as SubagentRunResult;
      this.#settle(managed, result);
      return result;
    }
    await managed.transport.stop();
    const record = failedRecord(managed, "stopped", "Subagent stopped");
    writeRecord(managed.statusFile, record);
    this.#settle(managed, record);
    return record;
  }

  async cleanup(id: string, deleteBranch = false): Promise<{ cleaned: boolean }> {
    const managed = this.#requireRun(id);
    if (!managed.settled) throw new Error("Cannot clean up a running subagent");
    const cleaned = await this.#worktrees.cleanup(id, deleteBranch);
    if (!this.config.retainRuns) {
      await removeTree(managed.runDirectory);
    }
    this.#runs.delete(id);
    return { cleaned: cleaned || !fs.existsSync(managed.runDirectory) };
  }

  readLog(id: string, opts: { lines?: number } = {}): FabricSubagentLog {
    const managed = this.#requireRun(id);
    const runDirectory = managed.runDirectory;
    const logFile = path.join(runDirectory, "events.jsonl");
    const lines = Math.max(1, Math.min(opts.lines ?? 200, 5000));
    const events = readJsonlTail(logFile, lines);
    const statusRecord = readRecord(path.join(runDirectory, "status.json"));
    return { id, runDirectory, logFile, events, ...(statusRecord ? { status: statusRecord } : {}) };
  }

  async close(): Promise<void> {
    this.#closing = true;
    const running = [...this.#runs.values()].filter((managed) => !managed.settled);
    await Promise.allSettled(running.map((managed) => this.stop(managed.id)));
    await Promise.allSettled(running.map((managed) => this.#waitForTransportExit(managed)));
    if (!this.config.retainRuns) {
      await removeTree(this.#runRoot);
    }
    if (this.#budgetOwned && this.#budget) {
      await removeTree(path.dirname(this.#budget.file));
      clearOwnedBudgetEnv();
    }
  }

  async #waitForTransportExit(managed: ManagedSubagent): Promise<void> {
    const deadline = Date.now() + TRANSPORT_EXIT_GRACE_MS * 5;
    while (Date.now() < deadline && (await managed.transport.isAlive())) {
      await delay(STATUS_POLL_MS);
    }
  }

  async #monitor(managed: ManagedSubagent, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs + TRANSPORT_EXIT_GRACE_MS;
    let firstObservedDeadAt: number | undefined;
    while (!managed.settled) {
      const record = readRecord(managed.statusFile);
      if (record && terminalStatuses.has(record.status)) {
        this.#settle(managed, this.#withTransportMetadata(record, managed) as SubagentRunResult);
        return;
      }
      if (Date.now() >= deadline) {
        await managed.transport.stop();
        const timedOut = failedRecord(
          managed,
          "timed_out",
          `Subagent timed out after ${timeoutMs}ms`,
        );
        writeRecord(managed.statusFile, timedOut);
        this.#settle(managed, timedOut);
        return;
      }
      const alive = await managed.transport.isAlive();
      if (!alive) {
        firstObservedDeadAt ??= Date.now();
        if (Date.now() - firstObservedDeadAt >= TRANSPORT_EXIT_GRACE_MS) {
          const logSummary = summarizeRunLog(managed.runDirectory, 8);
          const failed = failedRecord(
            managed,
            "failed",
            logSummary
              ? `Subagent transport exited without a result; last run log: ${logSummary}`
              : "Subagent transport exited without a result",
          );
          writeRecord(managed.statusFile, failed);
          this.#settle(managed, failed);
          return;
        }
      } else {
        firstObservedDeadAt = undefined;
      }
      await delay(STATUS_POLL_MS);
    }
  }

  #settle(managed: ManagedSubagent, result: SubagentRunResult): void {
    if (managed.settled) return;
    managed.settled = true;
    if (managed.abortSignal && managed.abortHandler) {
      managed.abortSignal.removeEventListener("abort", managed.abortHandler);
    }
    managed.release();
    if (this.#budget) {
      appendBudgetLedger(this.#budget.file, {
        id: result.id,
        depth: this.#currentDepth + 1,
        cost: result.usage.cost,
        tokens:
          result.usage.input +
          result.usage.output +
          result.usage.cacheRead +
          result.usage.cacheWrite,
        ts: Date.now(),
      });
      const summary = this.#budgetSummary();
      if (summary) result.budget = summary;
    }
    managed.resolve(result);
    if (
      managed.background &&
      !this.#closing &&
      this.config.notifyOnComplete &&
      this.#onBackgroundComplete
    ) {
      try {
        this.#onBackgroundComplete(result);
      } catch { /* completion callback must not break the manager */ }
    }
  }

  #childTools(request: SubagentRunRequest): string[] {
    const tools = [...(request.tools ?? this.config.defaultTools)].filter(
      (tool) => tool !== "fabric_exec",
    );
    if (request.recursive) tools.push("fabric_exec");
    return [...new Set(tools)];
  }

  #budgetSummary(): FabricBudgetSummary | undefined {
    if (!this.#budget) return undefined;
    const { cost, tokens } = readBudgetLedger(this.#budget.file);
    return {
      limit: this.#budget.budget,
      spent: cost,
      remaining: Math.max(0, this.#budget.budget - cost),
      tokens,
    };
  }

  async #resolveTransport(requested: FabricSubagentTransport): Promise<SubagentTransportAdapter> {
    if (requested !== "auto") {
      const adapter = this.#transports.get(requested);
      if (!adapter || !(await adapter.available())) {
        throw new Error(`Fabric subagent transport is unavailable: ${requested}`);
      }
      return adapter;
    }
    for (const kind of ["localterm", "tmux", "screen", "process"] as const) {
      const adapter = this.#transports.get(kind);
      if (adapter && (await adapter.available())) return adapter;
    }
    throw new Error("No Fabric subagent transport is available");
  }

  #requireRun(id: string): ManagedSubagent {
    const managed = this.#runs.get(id);
    if (!managed) throw new Error(`Unknown Fabric subagent: ${id}`);
    return managed;
  }

  #handleInfo(managed: ManagedSubagent, status: SubagentHandleInfo["status"]): SubagentHandleInfo {
    return {
      id: managed.id,
      name: managed.name,
      status,
      transport: managed.transport.kind,
      cwd: managed.cwd,
      ...(managed.model ? { model: managed.model } : {}),
      ...(managed.thinking ? { thinking: managed.thinking } : {}),
      ...(managed.actorId ? { actorId: managed.actorId } : {}),
      ...(managed.actorName ? { actorName: managed.actorName } : {}),
      ...(managed.transport.sessionId ? { sessionId: managed.transport.sessionId } : {}),
      ...(managed.transport.attachCommand
        ? { attachCommand: managed.transport.attachCommand }
        : {}),
      ...(managed.branch ? { branch: managed.branch } : {}),
      ...(managed.worktree ? { worktree: managed.worktree } : {}),
    };
  }

  #withTransportMetadata(record: SubagentRunRecord, managed: ManagedSubagent): SubagentRunRecord {
    const nestedAgents = readNestedAgents(managed.runDirectory);
    const budget = this.#budgetSummary();
    return {
      ...record,
      ...(nestedAgents.length > 0 ? { nestedAgents } : {}),
      ...(budget ? { budget } : {}),
      ...(managed.model ? { model: managed.model } : {}),
      ...(managed.thinking ? { thinking: managed.thinking } : {}),
      ...(managed.actorId ? { actorId: managed.actorId } : {}),
      ...(managed.actorName ? { actorName: managed.actorName } : {}),
      ...(managed.transport.sessionId ? { sessionId: managed.transport.sessionId } : {}),
      ...(managed.transport.attachCommand
        ? { attachCommand: managed.transport.attachCommand }
        : {}),
      ...(managed.branch ? { branch: managed.branch } : {}),
      ...(managed.worktree ? { worktree: managed.worktree } : {}),
    };
  }
}
