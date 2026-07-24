import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_AGENT_TIMEOUT_MS,
  MIN_AGENT_TIMEOUT_MS,
  type FabricAgentRunner,
  type FabricAgentConfig,
  type FabricAgentTransport,
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
  FabricAgentLog,
  AgentHandleInfo,
  AgentRunRecord,
  AgentRunRequest,
  AgentRunResult,
  AgentSteerEntry,
  AgentSteerResult,
  AgentTransportAdapter,
  AgentTransportHandle,
  AgentTransportLaunch,
} from "./types.js";
import { WorktreeManager } from "./worktree-manager.js";
import { writeHandoffSession } from "./handoff.js";
import {
  activeBudgetState,
  appendBudgetLedger,
  clearOwnedBudgetEnv,
  initBudgetLedger,
  readBudgetLedger,
} from "./budget-ledger.js";
import type { BudgetLedgerState } from "./budget-ledger.js";
import { readJsonlPage } from "../log-tail.js";
import {
  isFabricLifecycleEventType,
  type FabricLifecycleEventType,
  type FabricLifecyclePublishRequest,
} from "../lifecycle/types.js";
import {
  AGENT_STARTUP_MAX_ATTEMPTS,
  AGENT_STARTUP_RETRY_BASE_DELAY_MS,
  AGENT_STATUS_POLL_INTERVAL_MS,
} from "./constants.js";
const NESTED_SNAPSHOT_POLL_MS = 500;
const TRANSPORT_EXIT_GRACE_MS = 1_000;
const MAX_NAME_LENGTH = 60;
const MAX_UI_TEXT_CHARS = 16_000;
const MAX_UI_ERROR_CHARS = 8_000;
const MAX_UI_VALUE_CHARS = 64_000;
const MAX_RETAINED_UI_RUNS = 240;
const MAX_RETAINED_RUN_HANDLES = 1_000;
const MAX_LOG_SUMMARY_CHARS = 7_000;
const MAX_LOG_DETAIL_CHARS = 900;

export const effectiveAgentTimeoutMs = (
  configuredTimeoutMs: number,
  requestedTimeoutMs?: number,
): number => {
  const configured = Math.max(
    MIN_AGENT_TIMEOUT_MS,
    Math.min(Math.floor(configuredTimeoutMs), MAX_AGENT_TIMEOUT_MS),
  );
  if (requestedTimeoutMs === undefined || !Number.isFinite(requestedTimeoutMs)) {
    return configured;
  }
  return Math.max(
    configured,
    Math.min(Math.floor(requestedTimeoutMs), MAX_AGENT_TIMEOUT_MS),
  );
};

interface ManagedAgent {
  id: string;
  name: string;
  task: string;
  runner: FabricAgentRunner;
  recursive: boolean;
  cwd: string;
  statusFile: string;
  lifecycleFile: string;
  lifecycleOffset: number;
  lifecycleRemainder: Buffer;
  runDirectory: string;
  transport: AgentTransportHandle;
  adapter: AgentTransportAdapter;
  launch: AgentTransportLaunch;
  startupAttempts: number;
  result: Promise<AgentRunResult> | undefined;
  resolve: ((result: AgentRunResult) => void) | undefined;
  release(): void;
  abortSignal: AbortSignal | undefined;
  abortHandler: (() => void) | undefined;
  model?: string;
  thinking?: AgentRunRequest["thinking"];
  actorId?: string;
  actorName?: string;
  runnerSessionId?: string;
  branch?: string;
  worktree?: string;
  nestedSnapshot?: AgentRunRecord[];
  nestedSnapshotAt?: number;
  latestRecord?: AgentRunRecord;
  latestUiRecord?: AgentRunRecord;
  settled: boolean;
  background: boolean;
  lastLivenessCheckAt: number;
}

const terminalStatuses = new Set(["completed", "failed", "stopped", "timed_out"]);

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const retryablePiStartupError = (error: string | undefined): boolean =>
  typeof error === "string" &&
  /\b(?:no|missing)\s+(?:api key|credentials?)\b|\b(?:api key|credentials?)\s+(?:was\s+)?not found\b/i.test(
    error,
  );

const safeName = (value: string): string =>
  value
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH) || "Fabric agent";

const readRecord = (filePath: string): AgentRunRecord | undefined => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as AgentRunRecord;
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

const compactUiRecord = (record: AgentRunRecord): AgentRunRecord => {
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

const readNestedAgents = (runDirectory: string, depth = 0): AgentRunRecord[] => {
  if (depth >= 8) return [];
  const nestedRoot = path.join(runDirectory, "nested");
  let entries: string[];
  try {
    entries = fs.readdirSync(nestedRoot);
  } catch {
    return [];
  }
  const agents: AgentRunRecord[] = [];
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
    const rawDetail =
      typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.message === "string"
          ? parsed.message
          : typeof parsed.toolName === "string"
            ? parsed.toolName
            : typeof parsed.text === "string"
              ? parsed.text
              : "";
    const type = parsed.type.replace(/\s+/g, " ").trim().slice(0, 80);
    const detail = rawDetail
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_LOG_DETAIL_CHARS);
    summary.push(detail ? `${type}: ${detail}` : type);
  }
  return summary.join(" | ").slice(-MAX_LOG_SUMMARY_CHARS);
};

const writeRecord = (filePath: string, record: AgentRunRecord): void => {
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
    ManagedAgent,
    "result" | "resolve" | "release" | "abortSignal" | "abortHandler" | "settled"
  >,
  status: "failed" | "stopped" | "timed_out",
  error: string,
): AgentRunResult => {
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

export class AgentManager {
  readonly #runs = new Map<string, ManagedAgent>();
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
  readonly #meshRoot: string | undefined;
  readonly #projectRoot: string;
  readonly #hostId: string | undefined;
  readonly #identityId: string | undefined;
  readonly #transports: Map<FabricAgentTransport, AgentTransportAdapter>;
  readonly #onBackgroundComplete: ((result: AgentRunResult) => void) | undefined;
  readonly #onLifecycle: ((event: FabricLifecyclePublishRequest) => void) | undefined;
  readonly #preparePiModel: ((model: string) => Promise<void>) | undefined;
  readonly #piModelPreparations = new Map<string, Promise<void>>();
  readonly #budget: BudgetLedgerState | undefined;
  readonly #budgetOwned: boolean;
  readonly #uiListeners = new Set<() => void>();
  #budgetSummaryCache: { at: number; value: FabricBudgetSummary } | undefined;
  #claudeModelsCache: { at: number; value: ClaudeModelInfo[] } | undefined;
  #uiListRevision = 0;
  #uiListCache:
    | { revision: number; value: Array<AgentRunRecord | AgentHandleInfo> }
    | undefined;
  #closing = false;

  constructor(
    readonly cwd: string,
    readonly config: FabricAgentConfig,
    options: {
      workerPath?: string;
      fabricExtensionPath?: string;
      piBinary?: string;
      claudeBinary?: string;
      runRoot?: string;
      fullCodeMode?: boolean;
      mainAgentId?: string;
      meshRoot?: string;
      projectRoot?: string;
      hostId?: string;
      identityId?: string;
      onBackgroundComplete?: (result: AgentRunResult) => void;
      onLifecycle?: (event: FabricLifecyclePublishRequest) => void;
      preparePiModel?: (model: string) => Promise<void>;
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
    this.#onLifecycle = options.onLifecycle;
    this.#preparePiModel = options.preparePiModel;
    this.#currentDepth = Math.max(0, Number(process.env.PI_FABRIC_DEPTH ?? "0") || 0);
    this.#fullCodeMode = options.fullCodeMode ?? true;
    this.#mainAgentId =
      options.mainAgentId ?? process.env.PI_FABRIC_MAIN_AGENT_ID;
    this.#meshRoot = options.meshRoot ?? process.env.PI_FABRIC_MESH_ROOT;
    this.#projectRoot =
      options.projectRoot ?? process.env.PI_FABRIC_PROJECT_ROOT ?? cwd;
    this.#hostId = options.hostId ?? process.env.PI_FABRIC_HOST_ID;
    this.#identityId = options.identityId ?? process.env.PI_FABRIC_IDENTITY_ID;
    const inheritedBudget = activeBudgetState();
    this.#budget =
      inheritedBudget ??
      (this.#currentDepth === 0 && config.budgetUsd > 0
        ? initBudgetLedger(config.budgetUsd)
        : undefined);
    this.#budgetOwned =
      !inheritedBudget && this.#currentDepth === 0 && config.budgetUsd > 0;
    const adapters: AgentTransportAdapter[] = [
      new ProcessTransport(),
      new TmuxTransport(),
      new ScreenTransport(),
      new LocaltermTransport(),
      new HerdrTransport(),
    ];
    this.#transports = new Map(adapters.map((adapter) => [adapter.kind, adapter]));
  }

  async #prepareModel(model: string): Promise<void> {
    if (!this.#preparePiModel) return;
    const separator = model.indexOf("/");
    const provider = separator > 0 ? model.slice(0, separator) : model;
    const existing = this.#piModelPreparations.get(provider);
    if (existing) {
      await existing;
      return;
    }
    const preparation = this.#preparePiModel(model);
    this.#piModelPreparations.set(provider, preparation);
    try {
      await preparation;
    } finally {
      if (this.#piModelPreparations.get(provider) === preparation) {
        this.#piModelPreparations.delete(provider);
      }
    }
  }

  subscribeUi(listener: () => void): () => void {
    this.#uiListeners.add(listener);
    return () => this.#uiListeners.delete(listener);
  }

  async spawn(request: AgentRunRequest, signal?: AbortSignal): Promise<AgentHandleInfo> {
    if (!this.config.enabled) throw new Error("Agents are disabled in Fabric configuration");
    if (this.#currentDepth >= this.config.maxDepth) {
      throw new Error(`Fabric agent depth limit reached (${this.config.maxDepth})`);
    }
    if (!request.task.trim()) throw new Error("Agent task must not be empty");
    const runner = request.runner ?? this.config.runner;
    if (runner !== "pi" && runner !== "claude") {
      throw new Error(`Unsupported Fabric agent runner: ${String(runner)}`);
    }
    if (runner === "claude" && request.recursive) {
      throw new Error(
        "Claude runner does not support recursive Fabric. Use a Pi runner for recursive: true, or omit recursive for Claude Code tools.",
      );
    }
    if (request.sessionSeed && runner !== "pi") {
      throw new Error("Trajectory handoff sessions are only supported by the Pi runner");
    }
    if (request.sessionSeed && request.sessionFile) {
      throw new Error("A agent request cannot combine sessionSeed with sessionFile");
    }
    const tools = this.#childTools(request, runner);
    if (runner === "claude") mapClaudeTools(tools);
    const model =
      request.model ?? (runner === "claude" ? this.config.claude.model : this.config.model);
    if (runner === "claude" && model) normalizeClaudeModel(model);
    if (runner === "pi" && model) await this.#prepareModel(model);
    if (this.#budget) {
      const spent = readBudgetLedger(this.#budget.file).cost;
      if (spent >= this.#budget.budget) {
        throw new Error(
          `Fabric recursion budget exceeded: spent $${spent.toFixed(6)} of $${this.#budget.budget.toFixed(6)}. Increase agents.budgetUsd or simplify the task.`,
        );
      }
    }
    const release = await this.#semaphore.acquire(signal);
    const id = randomUUID().replaceAll("-", "");
    const name = safeName(request.name ?? request.task.split("\n", 1)[0] ?? "Fabric agent");
    const runDirectory = path.join(this.#runRoot, id);
    fs.mkdirSync(runDirectory, { recursive: true });
    const taskFile = path.join(runDirectory, "task.txt");
    const statusFile = path.join(runDirectory, "status.json");
    const lifecycleFile = path.join(runDirectory, "lifecycle.jsonl");
    const logFile = path.join(runDirectory, "events.jsonl");
    const steerFile = path.join(runDirectory, "steer.jsonl");
    const schemaFile = request.schema ? path.join(runDirectory, "schema.json") : undefined;
    const imagesFile = request.images && request.images.length > 0
      ? path.join(runDirectory, "images.json")
      : undefined;
    fs.writeFileSync(taskFile, request.task, { encoding: "utf8", mode: 0o600 });
    if (imagesFile) {
      fs.writeFileSync(imagesFile, JSON.stringify(request.images), {
        encoding: "utf8",
        mode: 0o600,
      });
    }
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
      const sessionFile = request.sessionSeed
        ? writeHandoffSession(
            request.sessionSeed,
            agentCwd,
            path.join(runDirectory, "handoff-session"),
          )
        : request.sessionFile;
      const adapter = await this.#resolveTransport(request.transport ?? this.config.transport);
      const timeoutMs = effectiveAgentTimeoutMs(
        this.config.timeoutMs,
        request.timeoutMs,
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
        ...(imagesFile ? ["--images-file", imagesFile] : []),
        "--status-file",
        statusFile,
        "--lifecycle-file",
        lifecycleFile,
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
        ...(sessionFile ? ["--session-file", sessionFile] : []),
        ...(request.actorId ? ["--actor-id", request.actorId] : []),
        ...(request.actorName ? ["--actor-name", request.actorName] : []),
        ...(request.meshRoot ?? this.#meshRoot
          ? ["--mesh-root", request.meshRoot ?? this.#meshRoot!]
          : []),
        "--project-root",
        this.#projectRoot,
        ...(this.#hostId ? ["--owner-host-id", this.#hostId] : []),
        ...(this.#identityId ? ["--owner-identity-id", this.#identityId] : []),
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
      const launch: AgentTransportLaunch = {
        id,
        name,
        cwd: agentCwd,
        workerPath: this.#workerPath,
        workerArguments,
      };
      const transport = await adapter.launch(launch);
      let resolveResult: ((result: AgentRunResult) => void) | undefined;
      const result = new Promise<AgentRunResult>((resolve) => {
        resolveResult = resolve;
      });
      if (!resolveResult) throw new Error("Failed to create agent result promise");
      if (signal?.aborted) {
        await transport.stop();
        throw new Error("Agent launch aborted");
      }
      const managed: ManagedAgent = {
        id,
        name,
        task: request.task,
        runner,
        recursive,
        cwd: agentCwd,
        statusFile,
        lifecycleFile,
        lifecycleOffset: 0,
        lifecycleRemainder: Buffer.alloc(0),
        runDirectory,
        transport,
        adapter,
        launch,
        startupAttempts: 1,
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
        lastLivenessCheckAt: 0,
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

  async run(request: AgentRunRequest, signal?: AbortSignal): Promise<AgentRunResult> {
    const handle = await this.spawn(request, signal);
    return this.wait(handle.id);
  }

  async wait(id: string): Promise<AgentRunResult> {
    const managed = this.#requireRun(id);
    managed.background = false;
    if (!managed.settled) {
      if (!managed.result) throw new Error(`Agent ${id} has no pending result`);
      return managed.result;
    }
    const record = readRecord(managed.statusFile) ?? managed.latestRecord;
    if (!record || !terminalStatuses.has(record.status)) {
      throw new Error(`Agent ${id} settled without a result`);
    }
    return this.#withTransportMetadata(record, managed) as AgentRunResult;
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

  status(id: string): AgentRunRecord | AgentHandleInfo {
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

  list(): Array<AgentRunRecord | AgentHandleInfo> {
    return [...this.#runs.keys()].map((id) => this.status(id));
  }

  listForUi(): Array<AgentRunRecord | AgentHandleInfo> {
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

  async stop(id: string): Promise<AgentRunResult> {
    const managed = this.#requireRun(id);
    if (managed.settled) return this.wait(id);
    managed.background = false;
    const existing = readRecord(managed.statusFile);
    if (existing && terminalStatuses.has(existing.status)) {
      const result = this.#withTransportMetadata(existing, managed) as AgentRunResult;
      this.#settle(managed, result);
      return result;
    }
    await managed.transport.stop();
    await this.#waitForTransportExit(managed);
    const terminal = readRecord(managed.statusFile);
    const record =
      terminal && terminalStatuses.has(terminal.status)
        ? (this.#withTransportMetadata(terminal, managed) as AgentRunResult)
        : failedRecord(managed, "stopped", "Agent stopped");
    if (!terminal || !terminalStatuses.has(terminal.status)) writeRecord(managed.statusFile, record);
    this.#settle(managed, record);
    return record;
  }

  async cleanup(id: string, deleteBranch = false): Promise<{ cleaned: boolean }> {
    const managed = this.#requireRun(id);
    if (!managed.settled) throw new Error("Cannot clean up a running agent");
    const cleaned = await this.#worktrees.cleanup(id, deleteBranch);
    if (!this.config.retainRuns) {
      await removeTree(managed.runDirectory);
    }
    this.#runs.delete(id);
    this.#pruneRetainedUiRecords();
    this.#invalidateUiList();
    return { cleaned: cleaned || !fs.existsSync(managed.runDirectory) };
  }

  readLog(id: string, opts: { lines?: number; before?: number } = {}): FabricAgentLog {
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

  steer(id: string, message: string, data?: unknown): AgentSteerResult {
    return this.#appendSteer(id, { type: "steer", message, data });
  }

  followUp(id: string, message: string, data?: unknown): AgentSteerResult {
    return this.#appendSteer(id, { type: "follow_up", message, data });
  }

  setSteeringMode(id: string, mode: FabricSteeringMode): AgentSteerResult {
    return this.#appendSteer(id, { type: "set_steering_mode", mode });
  }

  setFollowUpMode(id: string, mode: FabricSteeringMode): AgentSteerResult {
    return this.#appendSteer(id, { type: "set_follow_up_mode", mode });
  }

  // Request an advisory compaction of a running Pi-runner child's context.
  // Appended to the same steer.jsonl channel as steer(); the worker queues it
  // until child agent_settled, then correlates Pi's compact response and
  // compaction_end before closing the one-shot RPC channel. Rejected for
  // Claude-runner children — the official Claude Code CLI exposes no compact
  // RPC; a fresh run is the only way to reset a Claude child's context.
  compact(id: string, instructions?: string): AgentSteerResult {
    const managed = this.#requireRun(id);
    if (managed.runner === "claude") {
      throw new Error(
        "Fabric agent compaction is only supported for Pi-runner children; Claude Code sessions cannot be compacted through Fabric.",
      );
    }
    return this.#appendSteer(id, {
      type: "compact",
      ...(typeof instructions === "string" && instructions ? { instructions } : {}),
    });
  }

  #appendSteer(id: string, entry: Omit<AgentSteerEntry, "id" | "ts">): AgentSteerResult {
    const managed = this.#requireRun(id);
    const record = readRecord(managed.statusFile);
    if (record && terminalStatuses.has(record.status)) {
      throw new Error(
        `Fabric agent ${id} already finished (${record.status}); steering has no target`,
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

  async #waitForTransportExit(managed: ManagedAgent): Promise<void> {
    const deadline = Date.now() + TRANSPORT_EXIT_GRACE_MS * 7;
    const pollIntervalMs =
      managed.transport.livenessPollIntervalMs ?? AGENT_STATUS_POLL_INTERVAL_MS;
    while (Date.now() < deadline && (await managed.transport.isAlive())) {
      await delay(pollIntervalMs);
    }
  }

  async #retryStartup(
    managed: ManagedAgent,
    record: AgentRunRecord,
    deadline: number,
  ): Promise<boolean> {
    if (
      managed.runner !== "pi" ||
      managed.startupAttempts >= AGENT_STARTUP_MAX_ATTEMPTS ||
      managed.settled ||
      this.#closing ||
      managed.abortSignal?.aborted ||
      record.status !== "failed" ||
      !retryablePiStartupError(record.error) ||
      record.turns !== 0 ||
      record.toolCalls !== 0 ||
      record.usage.input !== 0 ||
      record.usage.output !== 0 ||
      record.usage.cacheRead !== 0 ||
      record.usage.cacheWrite !== 0
    ) {
      return false;
    }
    const retryDelayMs =
      AGENT_STARTUP_RETRY_BASE_DELAY_MS * 2 ** (managed.startupAttempts - 1);
    if (Date.now() + retryDelayMs >= deadline) return false;
    await this.#waitForTransportExit(managed);
    await delay(retryDelayMs);
    if (managed.settled || this.#closing || managed.abortSignal?.aborted) return false;
    managed.startupAttempts++;
    try {
      fs.rmSync(managed.statusFile, { force: true });
      managed.transport = await managed.adapter.launch(managed.launch);
      delete managed.latestRecord;
      delete managed.latestUiRecord;
      managed.lastLivenessCheckAt = 0;
      managed.lifecycleOffset = 0;
      managed.lifecycleRemainder = Buffer.alloc(0);
      fs.rmSync(managed.lifecycleFile, { force: true });
      this.#invalidateUiList();
      return true;
    } catch (error) {
      const retryError = error instanceof Error ? error.message : String(error);
      const failed = {
        ...record,
        error: `${record.error ?? "Agent startup failed"} · retry launch failed: ${retryError}`,
      };
      writeRecord(managed.statusFile, failed);
      managed.latestRecord = failed;
      return false;
    }
  }

  async #monitor(managed: ManagedAgent, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs + TRANSPORT_EXIT_GRACE_MS;
    let firstObservedDeadAt: number | undefined;
    while (!managed.settled) {
      this.#drainLifecycle(managed);
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
        if (await this.#retryStartup(managed, record, deadline)) continue;
        this.#settle(managed, this.#withTransportMetadata(record, managed) as AgentRunResult);
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
            this.#withTransportMetadata(completed, managed) as AgentRunResult,
          );
          return;
        }
        const timedOut = failedRecord(
          managed,
          "timed_out",
          `Agent timed out after ${timeoutMs}ms`,
        );
        writeRecord(managed.statusFile, timedOut);
        this.#settle(managed, timedOut);
        return;
      }
      const livenessPollIntervalMs =
        managed.transport.livenessPollIntervalMs ?? AGENT_STATUS_POLL_INTERVAL_MS;
      const livenessCheckedAt = Date.now();
      if (livenessCheckedAt - managed.lastLivenessCheckAt >= livenessPollIntervalMs) {
        managed.lastLivenessCheckAt = livenessCheckedAt;
        const alive = await managed.transport.isAlive();
        if (!alive) {
          firstObservedDeadAt ??= livenessCheckedAt;
          if (livenessCheckedAt - firstObservedDeadAt >= TRANSPORT_EXIT_GRACE_MS) {
            const logSummary = summarizeRunLog(managed.runDirectory, 8);
            const failed = failedRecord(
              managed,
              "failed",
              logSummary
                ? `Agent transport exited without a result; last run log: ${logSummary}`
                : "Agent transport exited without a result",
            );
            writeRecord(managed.statusFile, failed);
            this.#settle(managed, failed);
            return;
          }
        } else {
          firstObservedDeadAt = undefined;
        }
      }
      await delay(AGENT_STATUS_POLL_INTERVAL_MS);
    }
  }

  #settle(managed: ManagedAgent, result: AgentRunResult): void {
    if (managed.settled) return;
    this.#drainLifecycle(managed);
    managed.settled = true;
    // Images are transport inputs, not retained run artifacts. Startup retries
    // have finished by settlement, so remove the owner-only handoff file for
    // every terminal outcome even when retainRuns keeps the rest of the run.
    fs.rmSync(path.join(managed.runDirectory, "images.json"), { force: true });
    this.#emitLifecycle(managed, `run.${result.status}`, result.finishedAt ?? Date.now(), {
      status: result.status,
    });
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
    this.#pruneRetainedUiRecords();
    this.#invalidateUiList();
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

  #drainLifecycle(managed: ManagedAgent): void {
    let content: Buffer;
    try {
      content = fs.readFileSync(managed.lifecycleFile);
    } catch {
      return;
    }
    if (content.length < managed.lifecycleOffset) {
      managed.lifecycleOffset = 0;
      managed.lifecycleRemainder = Buffer.alloc(0);
    }
    if (content.length === managed.lifecycleOffset) return;
    const appended = content.subarray(managed.lifecycleOffset);
    managed.lifecycleOffset = content.length;
    const combined = Buffer.concat([managed.lifecycleRemainder, appended]);
    const finalNewline = combined.lastIndexOf(0x0a);
    if (finalNewline < 0) {
      managed.lifecycleRemainder = combined.length <= 64 * 1024 ? combined : Buffer.alloc(0);
      return;
    }
    managed.lifecycleRemainder = combined.subarray(finalNewline + 1);
    const complete = combined.subarray(0, finalNewline).toString("utf8");
    for (const line of complete.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (
          parsed.version !== 1 ||
          !isFabricLifecycleEventType(parsed.event) ||
          !parsed.event.startsWith("pi.") ||
          typeof parsed.occurredAt !== "number"
        ) continue;
        this.#emitLifecycle(
          managed,
          parsed.event,
          parsed.occurredAt,
          Object.prototype.hasOwnProperty.call(parsed, "data") ? { data: parsed.data } : {},
        );
      } catch {
        // Ignore malformed worker lifecycle records; status monitoring remains authoritative.
      }
    }
  }

  #emitLifecycle(
    managed: ManagedAgent,
    event: FabricLifecycleEventType,
    occurredAt: number,
    options: { status?: string; data?: unknown } = {},
  ): void {
    if (!this.#onLifecycle) return;
    try {
      this.#onLifecycle({
        source: {
          id: managed.actorId ?? managed.id,
          name: managed.actorName ?? managed.name,
          kind: managed.actorId ? "actor" : "agent",
          rootId: this.#mainAgentId ?? managed.id,
          runner: managed.runner,
          ...(this.#hostId ? { ownerHostId: this.#hostId } : {}),
          ...(this.#identityId ? { ownerIdentityId: this.#identityId } : {}),
        },
        event,
        occurredAt,
        runId: managed.id,
        ...(options.status ? { status: options.status } : {}),
        ...(options.data === undefined ? {} : { data: options.data }),
      });
    } catch {
      // Lifecycle observers must not interrupt child execution or settlement.
    }
  }

  #childTools(request: AgentRunRequest, runner: FabricAgentRunner): string[] {
    const tools = [...(request.tools ?? this.config.defaultTools)].filter(
      (tool) => tool !== "fabric_exec",
    );
    if (runner === "pi" && request.recursive) tools.push("fabric_exec");
    return [...new Set(tools)];
  }

  #budgetSummary(): FabricBudgetSummary | undefined {
    if (!this.#budget) return undefined;
    const now = Date.now();
    if (this.#budgetSummaryCache && now - this.#budgetSummaryCache.at < AGENT_STATUS_POLL_INTERVAL_MS) {
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

  async #resolveTransport(requested: FabricAgentTransport): Promise<AgentTransportAdapter> {
    if (requested !== "auto") {
      const adapter = this.#transports.get(requested);
      if (!adapter || !(await adapter.available())) {
        throw new Error(`Fabric agent transport is unavailable: ${requested}`);
      }
      return adapter;
    }
    for (const kind of ["herdr", "localterm", "tmux", "screen", "process"] as const) {
      const adapter = this.#transports.get(kind);
      if (adapter && (await adapter.available())) return adapter;
    }
    throw new Error("No Fabric agent transport is available");
  }

  #pruneRetainedUiRecords(): void {
    const settled = [...this.#runs.values()].filter((managed) => managed.settled);
    const evicted = settled.slice(0, -MAX_RETAINED_RUN_HANDLES);
    for (const managed of evicted) this.#runs.delete(managed.id);
    const retained = evicted.length > 0 ? settled.slice(evicted.length) : settled;
    if (retained.length <= MAX_RETAINED_UI_RUNS) return;
    for (const managed of retained.slice(0, -MAX_RETAINED_UI_RUNS)) {
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
        // UI observers must not interrupt agent state transitions.
      }
    }
  }

  #requireRun(id: string): ManagedAgent {
    const managed = this.#runs.get(id);
    if (!managed) throw new Error(`Unknown Fabric agent: ${id}`);
    return managed;
  }

  #handleInfo(managed: ManagedAgent, status: AgentHandleInfo["status"]): AgentHandleInfo {
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
      ...(managed.recursive ? { recursive: true } : {}),
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
  #nestedAgents(managed: ManagedAgent, force = false): AgentRunRecord[] {
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

  #withTransportMetadata(record: AgentRunRecord, managed: ManagedAgent): AgentRunRecord {
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
      ...(managed.recursive ? { recursive: true } : {}),
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
