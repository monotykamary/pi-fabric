import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_SUBAGENT_TIMEOUT_MS,
  MIN_SUBAGENT_TIMEOUT_MS,
  type FabricAgentRunner,
  type FabricSubagentConfig,
  type FabricSubagentTransport,
} from "../config.js";
import {
  discoverClaudeModels,
  mapClaudeTools,
  normalizeClaudeModel,
  type ClaudeModelInfo,
} from "./claude-cli.js";
import { Semaphore } from "./semaphore.js";
import { removeTree } from "./rm.js";
import { HerdrTransport } from "./transports/herdr-transport.js";
import { LocaltermTransport } from "./transports/localterm-transport.js";
import { ProcessTransport } from "./transports/process-transport.js";
import { ScreenTransport } from "./transports/screen-transport.js";
import { TmuxTransport } from "./transports/tmux-transport.js";
import type {
  FabricBudgetSummary,
  FabricSteeringMode,
  FabricSubagentLog,
  SubagentHandleInfo,
  SubagentRunRecord,
  SubagentRunRequest,
  SubagentRunResult,
  SubagentSteerEntry,
  SubagentSteerResult,
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
import { readJsonlPage } from "../log-tail.js";

const STATUS_POLL_MS = 100;
const NESTED_SNAPSHOT_POLL_MS = 500;
const TRANSPORT_EXIT_GRACE_MS = 1_000;
const MAX_NAME_LENGTH = 60;
const MAX_UI_TEXT_CHARS = 16_000;
const MAX_UI_ERROR_CHARS = 8_000;
const MAX_UI_VALUE_CHARS = 64_000;
const MAX_RETAINED_UI_RUNS = 240;

interface ManagedSubagent {
  id: string;
  name: string;
  task: string;
  runner: FabricAgentRunner;
  recursive: boolean;
  cwd: string;
  statusFile: string;
  runDirectory: string;
  transport: SubagentTransportHandle;
  result: Promise<SubagentRunResult> | undefined;
  resolve: ((result: SubagentRunResult) => void) | undefined;
  release(): void;
  abortSignal: AbortSignal | undefined;
  abortHandler: (() => void) | undefined;
  model?: string;
  thinking?: SubagentRunRequest["thinking"];
  actorId?: string;
  actorName?: string;
  runnerSessionId?: string;
  branch?: string;
  worktree?: string;
  nestedSnapshot?: SubagentRunRecord[];
  nestedSnapshotAt?: number;
  latestRecord?: SubagentRunRecord;
  latestUiRecord?: SubagentRunRecord;
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
    const record = parsed as SubagentRunRecord;
    return { ...record, runner: record.runner === "claude" ? "claude" : "pi" };
  } catch {
    return undefined;
  }
};

const boundedUiValue = (value: unknown): unknown => {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= MAX_UI_VALUE_CHARS) return JSON.parse(serialized) as unknown;
    return {
      fabricTruncated: true,
      originalChars: serialized.length,
      preview: serialized.slice(0, MAX_UI_VALUE_CHARS - 100),
    };
  } catch {
    return String(value).slice(0, MAX_UI_VALUE_CHARS);
  }
};

const compactUiRecord = (record: SubagentRunRecord): SubagentRunRecord => {
  const { task, text, error, value, nestedAgents, ...rest } = record;
  return {
    ...rest,
    task:
      task.length <= MAX_UI_TEXT_CHARS
        ? task
        : `${task.slice(0, MAX_UI_TEXT_CHARS)}…`,
    text: text.length <= MAX_UI_TEXT_CHARS ? text : `${text.slice(0, MAX_UI_TEXT_CHARS)}…`,
    ...(error
      ? {
          error:
            error.length <= MAX_UI_ERROR_CHARS
              ? error
              : `${error.slice(0, MAX_UI_ERROR_CHARS)}…`,
        }
      : {}),
    ...(value !== undefined ? { value: boundedUiValue(value) } : {}),
    ...(nestedAgents && nestedAgents.length > 0
      ? { nestedAgents: nestedAgents.map((nested) => compactUiRecord(nested)) }
      : {}),
  };
};

const readNestedAgents = (runDirectory: string, depth = 0): SubagentRunRecord[] => {
  if (depth >= 8) return [];
  const nestedRoot = path.join(runDirectory, "nested");
  let entries: string[];
  try {
    entries = fs.readdirSync(nestedRoot);
  } catch {
    return [];
  }
  const agents: SubagentRunRecord[] = [];
  for (const entry of entries.slice(0, 200)) {
    const runDirectory = path.join(nestedRoot, entry);
    const record = readRecord(path.join(runDirectory, "status.json"));
    if (!record) continue;
    const nestedAgents = readNestedAgents(runDirectory, depth + 1);
    const { logFile: _logFile, nestedAgents: _nestedAgents, ...safeRecord } = record;
    agents.push(
      compactUiRecord({
        ...safeRecord,
        logFile: path.join(runDirectory, "events.jsonl"),
        ...(nestedAgents.length > 0 ? { nestedAgents } : {}),
      }),
    );
  }
  return agents;
};

const summarizeRunLog = (runDirectory: string, lines: number): string => {
  const page = readJsonlPage(path.join(runDirectory, "events.jsonl"), lines);
  const summary: string[] = [];
  for (const entry of page.lines) {
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
    runner: managed.runner,
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
    ...(managed.runnerSessionId ? { runnerSessionId: managed.runnerSessionId } : {}),
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
  readonly #claudeBinary: string;
  readonly #currentDepth: number;
  readonly #fullCodeMode: boolean;
  readonly #mainAgentId: string | undefined;
  readonly #transports: Map<FabricSubagentTransport, SubagentTransportAdapter>;
  readonly #onBackgroundComplete: ((result: SubagentRunResult) => void) | undefined;
  readonly #budget: BudgetLedgerState | undefined;
  readonly #budgetOwned: boolean;
  readonly #uiListeners = new Set<() => void>();
  #budgetSummaryCache: { at: number; value: FabricBudgetSummary } | undefined;
  #claudeModelsCache: { at: number; value: ClaudeModelInfo[] } | undefined;
  #uiListRevision = 0;
  #uiListCache:
    | { revision: number; value: Array<SubagentRunRecord | SubagentHandleInfo> }
    | undefined;
  #closing = false;

  constructor(
    readonly cwd: string,
    readonly config: FabricSubagentConfig,
    options: {
      workerPath?: string;
      fabricExtensionPath?: string;
      piBinary?: string;
      claudeBinary?: string;
      runRoot?: string;
      fullCodeMode?: boolean;
      mainAgentId?: string;
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
    this.#claudeBinary =
      options.claudeBinary ?? process.env.PI_FABRIC_CLAUDE_BINARY ?? config.claude.binary;
    this.#onBackgroundComplete = options.onBackgroundComplete;
    this.#currentDepth = Math.max(0, Number(process.env.PI_FABRIC_DEPTH ?? "0") || 0);
    this.#fullCodeMode = options.fullCodeMode ?? true;
    this.#mainAgentId =
      options.mainAgentId ?? process.env.PI_FABRIC_MAIN_AGENT_ID;
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
      new HerdrTransport(),
    ];
    this.#transports = new Map(adapters.map((adapter) => [adapter.kind, adapter]));
  }

  subscribeUi(listener: () => void): () => void {
    this.#uiListeners.add(listener);
    return () => this.#uiListeners.delete(listener);
  }

  async spawn(request: SubagentRunRequest, signal?: AbortSignal): Promise<SubagentHandleInfo> {
    if (!this.config.enabled) throw new Error("Subagents are disabled in Fabric configuration");
    if (this.#currentDepth >= this.config.maxDepth) {
      throw new Error(`Fabric subagent depth limit reached (${this.config.maxDepth})`);
    }
    if (!request.task.trim()) throw new Error("Subagent task must not be empty");
    const runner = request.runner ?? this.config.runner;
    if (runner !== "pi" && runner !== "claude") {
      throw new Error(`Unsupported Fabric agent runner: ${String(runner)}`);
    }
    if (runner === "claude" && request.recursive) {
      throw new Error(
        "Claude runner does not support recursive Fabric. Use a Pi runner for recursive: true, or omit recursive for Claude Code tools.",
      );
    }
    const tools = this.#childTools(request, runner);
    if (runner === "claude") mapClaudeTools(tools);
    const model =
      request.model ?? (runner === "claude" ? this.config.claude.model : this.config.model);
    if (runner === "claude" && model) normalizeClaudeModel(model);
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
    const steerFile = path.join(runDirectory, "steer.jsonl");
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
      const timeoutMs = Math.max(
        MIN_SUBAGENT_TIMEOUT_MS,
        Math.min(request.timeoutMs ?? this.config.timeoutMs, MAX_SUBAGENT_TIMEOUT_MS),
      );
      const thinking = request.thinking ?? this.config.thinking;
      const recursive = runner === "pi" && request.recursive === true;
      const extensions = recursive ? true : (request.extensions ?? this.config.extensions);
      const workerArguments = [
        "--id",
        id,
        "--name",
        name,
        "--runner",
        runner,
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
        "--claude-binary",
        this.#claudeBinary,
        "--timeout-ms",
        String(timeoutMs),
        "--depth",
        String(this.#currentDepth + 1),
        "--full-code-mode",
        String(recursive && this.#fullCodeMode),
        ...(this.#mainAgentId ? ["--main-agent-id", this.#mainAgentId] : []),
        "--extensions",
        String(extensions),
        "--tools",
        JSON.stringify(tools),
        "--granted-risks",
        JSON.stringify(recursive ? ["agent"] : []),
        ...(this.config.maxTokensPerChild > 0
          ? ["--max-tokens", String(this.config.maxTokensPerChild)]
          : []),
        "--transport",
        adapter.kind,
        ...(recursive ? ["--fabric-extension", this.#fabricExtensionPath] : []),
        ...(model ? ["--model", model] : []),
        ...(thinking ? ["--thinking", thinking] : []),
        ...(request.systemPrompt ? ["--system-prompt", request.systemPrompt] : []),
        ...(request.sessionFile ? ["--session-file", request.sessionFile] : []),
        ...(request.actorId ? ["--actor-id", request.actorId] : []),
        ...(request.actorName ? ["--actor-name", request.actorName] : []),
        ...(request.meshRoot ? ["--mesh-root", request.meshRoot] : []),
        ...(request.runnerSessionId
          ? ["--runner-session-id", request.runnerSessionId]
          : []),
        "--run-root",
        path.join(runDirectory, "nested"),
        "--steer-file",
        steerFile,
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
        runner,
        recursive,
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
        ...(request.runnerSessionId ? { runnerSessionId: request.runnerSessionId } : {}),
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
      this.#invalidateUiList();
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
    if (!managed.settled) {
      if (!managed.result) throw new Error(`Subagent ${id} has no pending result`);
      return managed.result;
    }
    const record = readRecord(managed.statusFile) ?? managed.latestRecord;
    if (!record || !terminalStatuses.has(record.status)) {
      throw new Error(`Subagent ${id} settled without a result`);
    }
    return this.#withTransportMetadata(record, managed) as SubagentRunResult;
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
    const record = managed.settled
      ? readRecord(managed.statusFile) ?? managed.latestRecord
      : managed.latestRecord ?? readRecord(managed.statusFile);
    if (!record) return this.#handleInfo(managed, "running");
    managed.latestRecord = record;
    if (!managed.latestUiRecord) {
      managed.latestUiRecord = compactUiRecord(record);
      this.#invalidateUiList();
    }
    const result = structuredClone(this.#withTransportMetadata(record, managed));
    this.#pruneRetainedUiRecords();
    return result;
  }

  list(): Array<SubagentRunRecord | SubagentHandleInfo> {
    return [...this.#runs.keys()].map((id) => this.status(id));
  }

  listForUi(): Array<SubagentRunRecord | SubagentHandleInfo> {
    if (this.#uiListCache?.revision === this.#uiListRevision) {
      return this.#uiListCache.value;
    }
    const runs = [...this.#runs.values()];
    const active = runs.filter((managed) => !managed.settled);
    const settled = runs.filter((managed) => managed.settled);
    const retainedSettledCount = Math.max(0, MAX_RETAINED_UI_RUNS - active.length);
    const retainedSettled =
      retainedSettledCount > 0 ? settled.slice(-retainedSettledCount) : [];
    const visible = new Set([...active, ...retainedSettled]);
    const value = runs
      .filter((managed) => visible.has(managed))
      .map((managed) => {
        let record = managed.latestUiRecord;
        if (!record) {
          const latest = managed.latestRecord ?? readRecord(managed.statusFile);
          if (!latest) return this.#handleInfo(managed, "running");
          managed.latestRecord = latest;
          record = compactUiRecord(latest);
          managed.latestUiRecord = record;
        }
        return structuredClone(
          compactUiRecord(this.#withTransportMetadata(record, managed)),
        );
      });
    this.#uiListCache = { revision: this.#uiListRevision, value };
    return value;
  }

  runDirectory(id: string): string | undefined {
    return this.#runs.get(id)?.runDirectory;
  }

  async claudeModels(refresh = false): Promise<ClaudeModelInfo[]> {
    const now = Date.now();
    if (!refresh && this.#claudeModelsCache && now - this.#claudeModelsCache.at < 60_000) {
      return structuredClone(this.#claudeModelsCache.value);
    }
    const value = await discoverClaudeModels(this.#claudeBinary, this.cwd);
    this.#claudeModelsCache = { at: now, value };
    return structuredClone(value);
  }

  async stop(id: string): Promise<SubagentRunResult> {
    const managed = this.#requireRun(id);
    if (managed.settled) return this.wait(id);
    managed.background = false;
    const existing = readRecord(managed.statusFile);
    if (existing && terminalStatuses.has(existing.status)) {
      const result = this.#withTransportMetadata(existing, managed) as SubagentRunResult;
      this.#settle(managed, result);
      return result;
    }
    await managed.transport.stop();
    await this.#waitForTransportExit(managed);
    const terminal = readRecord(managed.statusFile);
    const record =
      terminal && terminalStatuses.has(terminal.status)
        ? (this.#withTransportMetadata(terminal, managed) as SubagentRunResult)
        : failedRecord(managed, "stopped", "Subagent stopped");
    if (!terminal || !terminalStatuses.has(terminal.status)) writeRecord(managed.statusFile, record);
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
    this.#invalidateUiList();
    this.#pruneRetainedUiRecords();
    return { cleaned: cleaned || !fs.existsSync(managed.runDirectory) };
  }

  readLog(id: string, opts: { lines?: number; before?: number } = {}): FabricSubagentLog {
    const managed = this.#requireRun(id);
    const runDirectory = managed.runDirectory;
    const logFile = path.join(runDirectory, "events.jsonl");
    const lines = Math.max(1, Math.min(opts.lines ?? 200, 5000));
    const page = readJsonlPage(logFile, lines, opts.before);
    const statusRecord = readRecord(path.join(runDirectory, "status.json"));
    return {
      id,
      runDirectory,
      logFile,
      events: page.lines,
      hasMore: page.hasMore,
      ...(page.before !== undefined ? { before: page.before } : {}),
      ...(statusRecord ? { status: statusRecord } : {}),
    };
  }

  steer(id: string, message: string, data?: unknown): SubagentSteerResult {
    return this.#appendSteer(id, { type: "steer", message, data });
  }

  followUp(id: string, message: string, data?: unknown): SubagentSteerResult {
    return this.#appendSteer(id, { type: "follow_up", message, data });
  }

  setSteeringMode(id: string, mode: FabricSteeringMode): SubagentSteerResult {
    return this.#appendSteer(id, { type: "set_steering_mode", mode });
  }

  setFollowUpMode(id: string, mode: FabricSteeringMode): SubagentSteerResult {
    return this.#appendSteer(id, { type: "set_follow_up_mode", mode });
  }

  // Request an advisory compaction of a running Pi-runner child's context.
  // Appended to the same steer.jsonl channel as steer(); the worker queues it
  // until child agent_settled, then correlates Pi's compact response and
  // compaction_end before closing the one-shot RPC channel. Rejected for
  // Claude-runner children — the official Claude Code CLI exposes no compact
  // RPC; a fresh run is the only way to reset a Claude child's context.
  compact(id: string, instructions?: string): SubagentSteerResult {
    const managed = this.#requireRun(id);
    if (managed.runner === "claude") {
      throw new Error(
        "Fabric subagent compaction is only supported for Pi-runner children; Claude Code sessions cannot be compacted through Fabric.",
      );
    }
    return this.#appendSteer(id, {
      type: "compact",
      ...(typeof instructions === "string" && instructions ? { instructions } : {}),
    });
  }

  #appendSteer(id: string, entry: Omit<SubagentSteerEntry, "id" | "ts">): SubagentSteerResult {
    const managed = this.#requireRun(id);
    const record = readRecord(managed.statusFile);
    if (record && terminalStatuses.has(record.status)) {
      throw new Error(
        `Fabric subagent ${id} already finished (${record.status}); steering has no target`,
      );
    }
    const steerFile = path.join(managed.runDirectory, "steer.jsonl");
    const messageId = randomUUID();
    const line = JSON.stringify({ ...entry, id: messageId, ts: Date.now() }) + "\n";
    fs.appendFileSync(steerFile, line, { encoding: "utf8", mode: 0o600 });
    return { queued: true, messageId };
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#uiListeners.clear();
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
    const deadline = Date.now() + TRANSPORT_EXIT_GRACE_MS * 7;
    while (Date.now() < deadline && (await managed.transport.isAlive())) {
      await delay(STATUS_POLL_MS);
    }
  }

  async #monitor(managed: ManagedSubagent, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs + TRANSPORT_EXIT_GRACE_MS;
    let firstObservedDeadAt: number | undefined;
    while (!managed.settled) {
      const record = readRecord(managed.statusFile);
      if (record) {
        const previous = managed.latestRecord;
        managed.latestRecord = record;
        if (
          !previous ||
          previous.updatedAt !== record.updatedAt ||
          previous.status !== record.status ||
          previous.currentTool !== record.currentTool
        ) {
          managed.latestUiRecord = compactUiRecord(record);
          this.#invalidateUiList();
        }
      }
      if (managed.recursive) this.#nestedAgents(managed);
      if (record?.runnerSessionId && !managed.runnerSessionId) {
        managed.runnerSessionId = record.runnerSessionId;
      }
      if (record && terminalStatuses.has(record.status)) {
        this.#settle(managed, this.#withTransportMetadata(record, managed) as SubagentRunResult);
        return;
      }
      if (Date.now() >= deadline) {
        await managed.transport.stop();
        await this.#waitForTransportExit(managed);
        const completed = readRecord(managed.statusFile);
        if (
          completed &&
          terminalStatuses.has(completed.status) &&
          completed.status !== "stopped"
        ) {
          this.#settle(
            managed,
            this.#withTransportMetadata(completed, managed) as SubagentRunResult,
          );
          return;
        }
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
    managed.abortSignal = undefined;
    managed.abortHandler = undefined;
    managed.release();
    managed.release = () => {};
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
      this.#budgetSummaryCache = undefined;
      const summary = this.#budgetSummary();
      if (summary) result.budget = summary;
    }
    const compactResult = compactUiRecord(result);
    managed.latestRecord = compactResult;
    managed.latestUiRecord = compactResult;
    if (managed.nestedSnapshot) {
      managed.nestedSnapshot = managed.nestedSnapshot.map((record) =>
        compactUiRecord(record),
      );
    }
    this.#invalidateUiList();
    this.#pruneRetainedUiRecords();
    managed.resolve?.(result);
    managed.result = undefined;
    managed.resolve = undefined;
    managed.task = "";
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

  #childTools(request: SubagentRunRequest, runner: FabricAgentRunner): string[] {
    const tools = [...(request.tools ?? this.config.defaultTools)].filter(
      (tool) => tool !== "fabric_exec",
    );
    if (runner === "pi" && request.recursive) tools.push("fabric_exec");
    return [...new Set(tools)];
  }

  #budgetSummary(): FabricBudgetSummary | undefined {
    if (!this.#budget) return undefined;
    const now = Date.now();
    if (this.#budgetSummaryCache && now - this.#budgetSummaryCache.at < STATUS_POLL_MS) {
      return this.#budgetSummaryCache.value;
    }
    const { cost, tokens } = readBudgetLedger(this.#budget.file);
    const value = {
      limit: this.#budget.budget,
      spent: cost,
      remaining: Math.max(0, this.#budget.budget - cost),
      tokens,
    };
    this.#budgetSummaryCache = { at: now, value };
    return value;
  }

  async #resolveTransport(requested: FabricSubagentTransport): Promise<SubagentTransportAdapter> {
    if (requested !== "auto") {
      const adapter = this.#transports.get(requested);
      if (!adapter || !(await adapter.available())) {
        throw new Error(`Fabric subagent transport is unavailable: ${requested}`);
      }
      return adapter;
    }
    for (const kind of ["herdr", "localterm", "tmux", "screen", "process"] as const) {
      const adapter = this.#transports.get(kind);
      if (adapter && (await adapter.available())) return adapter;
    }
    throw new Error("No Fabric subagent transport is available");
  }

  #pruneRetainedUiRecords(): void {
    const settled = [...this.#runs.values()].filter((managed) => managed.settled);
    if (settled.length <= MAX_RETAINED_UI_RUNS) return;
    for (const managed of settled.slice(0, -MAX_RETAINED_UI_RUNS)) {
      delete managed.latestRecord;
      delete managed.latestUiRecord;
      delete managed.nestedSnapshot;
      delete managed.nestedSnapshotAt;
    }
  }

  #invalidateUiList(): void {
    this.#uiListRevision++;
    this.#uiListCache = undefined;
    for (const listener of this.#uiListeners) {
      try {
        listener();
      } catch {
        // UI observers must not interrupt subagent state transitions.
      }
    }
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
      runner: managed.runner,
      transport: managed.transport.kind,
      cwd: managed.cwd,
      ...(managed.model ? { model: managed.model } : {}),
      ...(managed.thinking ? { thinking: managed.thinking } : {}),
      ...(managed.actorId ? { actorId: managed.actorId } : {}),
      ...(managed.actorName ? { actorName: managed.actorName } : {}),
      ...(managed.runnerSessionId ? { runnerSessionId: managed.runnerSessionId } : {}),
      ...(managed.transport.sessionId ? { sessionId: managed.transport.sessionId } : {}),
      ...(managed.transport.attachCommand
        ? { attachCommand: managed.transport.attachCommand }
        : {}),
      ...(managed.branch ? { branch: managed.branch } : {}),
      ...(managed.worktree ? { worktree: managed.worktree } : {}),
    };
  }

  // Recursive child processes remove their nested run directories on shutdown.
  // Preserve the last bounded status tree so completed leaves remain visible
  // in the parent run until that parent is explicitly cleaned up.
  #nestedAgents(managed: ManagedSubagent, force = false): SubagentRunRecord[] {
    const now = Date.now();
    const needsInitialDiscovery =
      managed.nestedSnapshot === undefined &&
      fs.existsSync(path.join(managed.runDirectory, "nested"));
    if (
      !force &&
      !needsInitialDiscovery &&
      managed.nestedSnapshotAt !== undefined &&
      now - managed.nestedSnapshotAt < NESTED_SNAPSHOT_POLL_MS
    ) {
      return managed.nestedSnapshot ? structuredClone(managed.nestedSnapshot) : [];
    }
    managed.nestedSnapshotAt = now;
    const discovered = readNestedAgents(managed.runDirectory);
    if (discovered.length > 0) {
      managed.nestedSnapshot = discovered;
      this.#invalidateUiList();
    }
    return managed.nestedSnapshot ? structuredClone(managed.nestedSnapshot) : [];
  }

  #withTransportMetadata(record: SubagentRunRecord, managed: ManagedSubagent): SubagentRunRecord {
    const nestedAgents = this.#nestedAgents(
      managed,
      terminalStatuses.has(record.status) && !managed.settled,
    );
    const budget = this.#budgetSummary();
    const { logFile: _logFile, nestedAgents: _nestedAgents, ...safeRecord } = record;
    return {
      ...safeRecord,
      runner: managed.runner,
      logFile: path.join(managed.runDirectory, "events.jsonl"),
      ...(nestedAgents.length > 0 ? { nestedAgents } : {}),
      ...(budget ? { budget } : {}),
      ...(managed.model ? { model: managed.model } : {}),
      ...(managed.thinking ? { thinking: managed.thinking } : {}),
      ...(managed.actorId ? { actorId: managed.actorId } : {}),
      ...(managed.actorName ? { actorName: managed.actorName } : {}),
      ...(managed.runnerSessionId ? { runnerSessionId: managed.runnerSessionId } : {}),
      ...(managed.transport.sessionId ? { sessionId: managed.transport.sessionId } : {}),
      ...(managed.transport.attachCommand
        ? { attachCommand: managed.transport.attachCommand }
        : {}),
      ...(managed.branch ? { branch: managed.branch } : {}),
      ...(managed.worktree ? { worktree: managed.worktree } : {}),
    };
  }
}
