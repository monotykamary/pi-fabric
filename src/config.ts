import fs from "node:fs";
import path from "node:path";
import { PI_CORE_TOOL_NAME_SET } from "./core/pi-tools.js";
import type { FabricRisk } from "./protocol.js";
import { DEFAULT_FABRIC_THINKING, isFabricThinking, type FabricThinking } from "./thinking.js";

type FabricApprovalMode = "allow" | "ask" | "deny";
export type FabricSubagentTransport = "auto" | "process" | "tmux" | "screen" | "localterm";
export type FabricAgentRunner = "pi" | "claude";
export type FabricUiWidgetMode = "auto" | "always" | "hidden";
type FabricCompactionEngine = "pi" | "fabric";
type FabricActorScope = "project" | "session";

interface FabricExecutorConfig {
  timeoutMs: number;
  memoryLimitBytes: number;
  maxOutputChars: number;
  maxNestedResultChars: number;
}

export interface FabricApprovalConfig {
  read: FabricApprovalMode;
  write: FabricApprovalMode;
  execute: FabricApprovalMode;
  network: FabricApprovalMode;
  agent: FabricApprovalMode;
}

export interface FabricMcpConfig {
  enabled: boolean;
  configPath?: string;
  disableOAuth: boolean;
  allowDynamicServers: boolean;
  callTimeoutMs: number;
}

interface FabricClaudeRunnerConfig {
  binary: string;
  model?: string;
}

export interface FabricSubagentConfig {
  enabled: boolean;
  runner: FabricAgentRunner;
  transport: FabricSubagentTransport;
  model?: string;
  claude: FabricClaudeRunnerConfig;
  thinking: FabricThinking;
  maxConcurrent: number;
  maxPerExecution: number;
  maxDepth: number;
  timeoutMs: number;
  extensions: boolean;
  defaultTools: string[];
  retainRuns: boolean;
  notifyOnComplete: boolean;
  budgetUsd: number;
  maxTokensPerChild: number;
}

export interface FabricToolCaptureConfig {
  enabled: boolean;
  hideFromModel: boolean;
  keepVisible: string[];
  defaultRisk: FabricRisk;
  risks: Record<string, FabricRisk>;
}

interface FabricUiConfig {
  enabled: boolean;
  widget: FabricUiWidgetMode;
  maxRows: number;
  refreshMs: number;
  eventHistory: number;
  haltOnEscape: boolean;
}

interface FabricCompactionConfig {
  engine: FabricCompactionEngine;
}

export interface FabricMeshConfig {
  enabled: boolean;
  root?: string;
  actorScope: FabricActorScope;
  maxEventBytes: number;
  maxReadEvents: number;
  actorPollMs: number;
  actorQueueLimit: number;
  eventContextChars: number;
  actorContextEntries: number;
}

export interface FabricMemoryConfig {
  enabled: boolean;
  indexDir?: string;
  maxSessions: number;
  maxEntryChars: number;
  hotSessions?: number;
  digestTerms?: number;
}

export interface FabricConfig {
  fullCodeMode: boolean;
  executor: FabricExecutorConfig;
  approvals: FabricApprovalConfig;
  mcp: FabricMcpConfig;
  subagents: FabricSubagentConfig;
  capture: FabricToolCaptureConfig;
  ui: FabricUiConfig;
  compaction: FabricCompactionConfig;
  mesh: FabricMeshConfig;
  memory: FabricMemoryConfig;
}

export const MIN_SUBAGENT_TIMEOUT_MS = 1_000;
export const MAX_SUBAGENT_TIMEOUT_MS = 3_600_000;

export const DEFAULT_FABRIC_CONFIG: FabricConfig = {
  fullCodeMode: true,
  executor: {
    timeoutMs: 120_000,
    memoryLimitBytes: 64 * 1024 * 1024,
    maxOutputChars: 100_000,
    maxNestedResultChars: 2_000_000,
  },
  approvals: {
    read: "allow",
    write: "allow",
    execute: "allow",
    network: "allow",
    agent: "allow",
  },
  mcp: {
    enabled: true,
    disableOAuth: true,
    allowDynamicServers: true,
    callTimeoutMs: 120_000,
  },
  subagents: {
    enabled: true,
    runner: "pi",
    transport: "process",
    claude: { binary: "claude" },
    thinking: DEFAULT_FABRIC_THINKING,
    maxConcurrent: 4,
    maxPerExecution: 100,
    maxDepth: 2,
    timeoutMs: MAX_SUBAGENT_TIMEOUT_MS,
    extensions: true,
    defaultTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    retainRuns: false,
    notifyOnComplete: true,
    budgetUsd: 0,
    maxTokensPerChild: 0,
  },
  capture: {
    enabled: true,
    hideFromModel: true,
    keepVisible: ["fabric_exec"],
    defaultRisk: "execute",
    risks: {
      read: "read",
      grep: "read",
      find: "read",
      ls: "read",
      edit: "write",
      write: "write",
      bash: "execute",
    },
  },
  ui: {
    enabled: true,
    widget: "auto",
    maxRows: 6,
    refreshMs: 500,
    eventHistory: 80,
    haltOnEscape: true,
  },
  compaction: {
    engine: "pi",
  },
  mesh: {
    enabled: true,
    actorScope: "project",
    maxEventBytes: 256 * 1024,
    maxReadEvents: 500,
    actorPollMs: 250,
    actorQueueLimit: 32,
    eventContextChars: 40_000,
    actorContextEntries: 14,
  },
  memory: {
    enabled: true,
    maxSessions: 500,
    maxEntryChars: 2_000,
    hotSessions: 50,
    digestTerms: 200,
  },
};

const readJsonObject = (filePath: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("configuration root must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${filePath}: ${message}`);
  }
};

const mergeObjects = (
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> => {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseValue = merged[key];
    if (
      typeof baseValue === "object" &&
      baseValue !== null &&
      !Array.isArray(baseValue) &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      merged[key] = mergeObjects(
        baseValue as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      merged[key] = value;
    }
  }
  return merged;
};

const approvalMode = (value: unknown, fallback: FabricApprovalMode): FabricApprovalMode =>
  value === "allow" || value === "ask" || value === "deny" ? value : fallback;

const booleanValue = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const boundedInteger = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isInteger(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;

const boundedFloat = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const runnerValue = (value: unknown, fallback: FabricAgentRunner): FabricAgentRunner =>
  value === "pi" || value === "claude" ? value : fallback;

const transportValue = (
  value: unknown,
  fallback: FabricSubagentTransport,
): FabricSubagentTransport =>
  value === "auto" ||
  value === "process" ||
  value === "tmux" ||
  value === "screen" ||
  value === "localterm"
    ? value
    : fallback;

const thinkingValue = (value: unknown, fallback: FabricThinking): FabricThinking =>
  isFabricThinking(value) ? value : fallback;

const objectValue = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const widgetModeValue = (value: unknown, fallback: FabricUiWidgetMode): FabricUiWidgetMode =>
  value === "auto" || value === "always" || value === "hidden" ? value : fallback;

const compactionEngineValue = (
  value: unknown,
  fallback: FabricCompactionEngine,
): FabricCompactionEngine =>
  value === "pi" || value === "fabric" ? value : fallback;

const actorScopeValue = (value: unknown, fallback: FabricActorScope): FabricActorScope =>
  value === "project" || value === "session" ? value : fallback;

const riskValue = (value: unknown, fallback: FabricRisk): FabricRisk =>
  value === "read" ||
  value === "write" ||
  value === "execute" ||
  value === "network" ||
  value === "agent"
    ? value
    : fallback;

export const normalizeFabricConfig = (input: Record<string, unknown>): FabricConfig => {
  const executor = objectValue(input.executor);
  const approvals = objectValue(input.approvals);
  const mcp = objectValue(input.mcp);
  const subagents = objectValue(input.subagents);
  const claude = objectValue(subagents.claude);
  const capture = objectValue(input.capture);
  const ui = objectValue(input.ui);
  const compaction = objectValue(input.compaction);
  const mesh = objectValue(input.mesh);
  const memory = objectValue(input.memory);
  const configuredTools = Array.isArray(subagents.defaultTools)
    ? subagents.defaultTools.filter(
        (tool): tool is string => typeof tool === "string" && Boolean(tool),
      )
    : DEFAULT_FABRIC_CONFIG.subagents.defaultTools;
  const configPath = stringValue(mcp.configPath);
  const meshRoot = stringValue(mesh.root);
  const memoryIndexDir = stringValue(memory.indexDir);
  const subagentModel = stringValue(subagents.model);
  const claudeBinary = stringValue(claude.binary);
  const claudeModel = stringValue(claude.model);
  const subagentThinking = thinkingValue(subagents.thinking, DEFAULT_FABRIC_CONFIG.subagents.thinking);
  const configuredVisible = Array.isArray(capture.keepVisible)
    ? capture.keepVisible.filter(
        (name): name is string => typeof name === "string" && Boolean(name.trim()),
      )
    : DEFAULT_FABRIC_CONFIG.capture.keepVisible;
  const configuredRisks = {
    ...DEFAULT_FABRIC_CONFIG.capture.risks,
    ...objectValue(capture.risks),
  };
  const risks = Object.fromEntries(
    Object.entries(configuredRisks)
      .filter(([name]) => Boolean(name.trim()))
      .map(([name, risk]) => [name, riskValue(risk, DEFAULT_FABRIC_CONFIG.capture.defaultRisk)]),
  );

  return {
    fullCodeMode: booleanValue(input.fullCodeMode, DEFAULT_FABRIC_CONFIG.fullCodeMode),
    executor: {
      timeoutMs: boundedInteger(
        executor.timeoutMs,
        DEFAULT_FABRIC_CONFIG.executor.timeoutMs,
        1_000,
        900_000,
      ),
      memoryLimitBytes: boundedInteger(
        executor.memoryLimitBytes,
        DEFAULT_FABRIC_CONFIG.executor.memoryLimitBytes,
        8 * 1024 * 1024,
        1024 * 1024 * 1024,
      ),
      maxOutputChars: boundedInteger(
        executor.maxOutputChars,
        DEFAULT_FABRIC_CONFIG.executor.maxOutputChars,
        1_000,
        1_000_000,
      ),
      maxNestedResultChars: boundedInteger(
        executor.maxNestedResultChars,
        DEFAULT_FABRIC_CONFIG.executor.maxNestedResultChars,
        10_000,
        20_000_000,
      ),
    },
    approvals: {
      read: approvalMode(approvals.read, DEFAULT_FABRIC_CONFIG.approvals.read),
      write: approvalMode(approvals.write, DEFAULT_FABRIC_CONFIG.approvals.write),
      execute: approvalMode(approvals.execute, DEFAULT_FABRIC_CONFIG.approvals.execute),
      network: approvalMode(approvals.network, DEFAULT_FABRIC_CONFIG.approvals.network),
      agent: approvalMode(approvals.agent, DEFAULT_FABRIC_CONFIG.approvals.agent),
    },
    mcp: {
      enabled: booleanValue(mcp.enabled, DEFAULT_FABRIC_CONFIG.mcp.enabled),
      ...(configPath ? { configPath } : {}),
      disableOAuth: booleanValue(mcp.disableOAuth, DEFAULT_FABRIC_CONFIG.mcp.disableOAuth),
      allowDynamicServers: booleanValue(
        mcp.allowDynamicServers,
        DEFAULT_FABRIC_CONFIG.mcp.allowDynamicServers,
      ),
      callTimeoutMs: boundedInteger(
        mcp.callTimeoutMs,
        DEFAULT_FABRIC_CONFIG.mcp.callTimeoutMs,
        1_000,
        900_000,
      ),
    },
    subagents: {
      enabled: booleanValue(subagents.enabled, DEFAULT_FABRIC_CONFIG.subagents.enabled),
      runner: runnerValue(subagents.runner, DEFAULT_FABRIC_CONFIG.subagents.runner),
      transport: transportValue(subagents.transport, DEFAULT_FABRIC_CONFIG.subagents.transport),
      ...(subagentModel ? { model: subagentModel } : {}),
      claude: {
        binary: claudeBinary ?? DEFAULT_FABRIC_CONFIG.subagents.claude.binary,
        ...(claudeModel ? { model: claudeModel } : {}),
      },
      thinking: subagentThinking,
      maxConcurrent: boundedInteger(
        subagents.maxConcurrent,
        DEFAULT_FABRIC_CONFIG.subagents.maxConcurrent,
        1,
        32,
      ),
      maxPerExecution: boundedInteger(
        subagents.maxPerExecution,
        DEFAULT_FABRIC_CONFIG.subagents.maxPerExecution,
        1,
        1_000,
      ),
      maxDepth: boundedInteger(subagents.maxDepth, DEFAULT_FABRIC_CONFIG.subagents.maxDepth, 0, 8),
      timeoutMs: boundedInteger(
        subagents.timeoutMs,
        DEFAULT_FABRIC_CONFIG.subagents.timeoutMs,
        MIN_SUBAGENT_TIMEOUT_MS,
        MAX_SUBAGENT_TIMEOUT_MS,
      ),
      extensions: booleanValue(subagents.extensions, DEFAULT_FABRIC_CONFIG.subagents.extensions),
      defaultTools: configuredTools,
      retainRuns: booleanValue(subagents.retainRuns, DEFAULT_FABRIC_CONFIG.subagents.retainRuns),
      notifyOnComplete: booleanValue(
        subagents.notifyOnComplete,
        DEFAULT_FABRIC_CONFIG.subagents.notifyOnComplete,
      ),
      budgetUsd: boundedFloat(
        subagents.budgetUsd,
        DEFAULT_FABRIC_CONFIG.subagents.budgetUsd,
        0,
        1_000_000,
      ),
      maxTokensPerChild: boundedInteger(
        subagents.maxTokensPerChild,
        DEFAULT_FABRIC_CONFIG.subagents.maxTokensPerChild,
        0,
        100_000_000,
      ),
    },
    capture: {
      enabled: booleanValue(capture.enabled, DEFAULT_FABRIC_CONFIG.capture.enabled),
      hideFromModel: booleanValue(
        capture.hideFromModel,
        DEFAULT_FABRIC_CONFIG.capture.hideFromModel,
      ),
      keepVisible: [...new Set(configuredVisible)],
      defaultRisk: riskValue(capture.defaultRisk, DEFAULT_FABRIC_CONFIG.capture.defaultRisk),
      risks,
    },
    ui: {
      enabled: booleanValue(ui.enabled, DEFAULT_FABRIC_CONFIG.ui.enabled),
      widget: widgetModeValue(ui.widget, DEFAULT_FABRIC_CONFIG.ui.widget),
      maxRows: boundedInteger(ui.maxRows, DEFAULT_FABRIC_CONFIG.ui.maxRows, 1, 20),
      refreshMs: boundedInteger(ui.refreshMs, DEFAULT_FABRIC_CONFIG.ui.refreshMs, 100, 10_000),
      eventHistory: boundedInteger(
        ui.eventHistory,
        DEFAULT_FABRIC_CONFIG.ui.eventHistory,
        1,
        500,
      ),
      haltOnEscape: booleanValue(ui.haltOnEscape, DEFAULT_FABRIC_CONFIG.ui.haltOnEscape),
    },
    compaction: {
      engine: compactionEngineValue(compaction.engine, DEFAULT_FABRIC_CONFIG.compaction.engine),
    },
    mesh: {
      enabled: booleanValue(mesh.enabled, DEFAULT_FABRIC_CONFIG.mesh.enabled),
      ...(meshRoot ? { root: meshRoot } : {}),
      actorScope: actorScopeValue(mesh.actorScope, DEFAULT_FABRIC_CONFIG.mesh.actorScope),
      maxEventBytes: boundedInteger(
        mesh.maxEventBytes,
        DEFAULT_FABRIC_CONFIG.mesh.maxEventBytes,
        1_024,
        4 * 1024 * 1024,
      ),
      maxReadEvents: boundedInteger(
        mesh.maxReadEvents,
        DEFAULT_FABRIC_CONFIG.mesh.maxReadEvents,
        1,
        10_000,
      ),
      actorPollMs: boundedInteger(
        mesh.actorPollMs,
        DEFAULT_FABRIC_CONFIG.mesh.actorPollMs,
        50,
        10_000,
      ),
      actorQueueLimit: boundedInteger(
        mesh.actorQueueLimit,
        DEFAULT_FABRIC_CONFIG.mesh.actorQueueLimit,
        1,
        1_000,
      ),
      eventContextChars: boundedInteger(
        mesh.eventContextChars,
        DEFAULT_FABRIC_CONFIG.mesh.eventContextChars,
        1_000,
        1_000_000,
      ),
      actorContextEntries: boundedInteger(
        mesh.actorContextEntries,
        DEFAULT_FABRIC_CONFIG.mesh.actorContextEntries,
        1,
        100,
      ),
    },
    memory: {
      enabled: booleanValue(memory.enabled, DEFAULT_FABRIC_CONFIG.memory.enabled),
      ...(memoryIndexDir ? { indexDir: memoryIndexDir } : {}),
      maxSessions: boundedInteger(
        memory.maxSessions,
        DEFAULT_FABRIC_CONFIG.memory.maxSessions,
        1,
        100_000,
      ),
      maxEntryChars: boundedInteger(
        memory.maxEntryChars,
        DEFAULT_FABRIC_CONFIG.memory.maxEntryChars,
        100,
        1_000_000,
      ),
      hotSessions: boundedInteger(
        memory.hotSessions,
        DEFAULT_FABRIC_CONFIG.memory.hotSessions ?? 50,
        0,
        100_000,
      ),
      digestTerms: boundedInteger(
        memory.digestTerms,
        DEFAULT_FABRIC_CONFIG.memory.digestTerms ?? 200,
        1,
        10_000,
      ),
    },
  };
};

export const effectiveToolCaptureConfig = (
  config: Pick<FabricConfig, "fullCodeMode" | "capture">,
): FabricToolCaptureConfig =>
  config.fullCodeMode
    ? {
        ...config.capture,
        keepVisible: config.capture.keepVisible.filter(
          (name) => !PI_CORE_TOOL_NAME_SET.has(name),
        ),
        risks: { ...config.capture.risks },
      }
    : {
        ...config.capture,
        enabled: false,
        hideFromModel: false,
        keepVisible: [...config.capture.keepVisible],
        risks: { ...config.capture.risks },
      };

export const loadFabricConfig = (options: {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
}): FabricConfig => {
  let merged = structuredClone(DEFAULT_FABRIC_CONFIG) as unknown as Record<string, unknown>;
  const globalConfig = readJsonObject(path.join(options.agentDir, "fabric.json"));
  if (globalConfig) merged = mergeObjects(merged, globalConfig);
  if (options.projectTrusted) {
    const projectConfig = readJsonObject(path.join(options.cwd, ".pi", "fabric.json"));
    if (projectConfig) merged = mergeObjects(merged, projectConfig);
  }
  const inheritedFullCodeMode = process.env.PI_FABRIC_FULL_CODE_MODE;
  if (inheritedFullCodeMode === "true" || inheritedFullCodeMode === "false") {
    merged.fullCodeMode = inheritedFullCodeMode === "true";
  }
  return normalizeFabricConfig(merged);
};

export const saveFabricConfig = (
  options: { cwd: string; agentDir: string; projectTrusted: boolean },
  partial: Record<string, unknown>,
): { scope: "global" | "project"; path: string } => {
  const targetPath = options.projectTrusted
    ? path.join(options.cwd, ".pi", "fabric.json")
    : path.join(options.agentDir, "fabric.json");
  const existing = readJsonObject(targetPath) ?? {};
  const merged = mergeObjects(existing, partial) as Record<string, unknown>;
  const directory = path.dirname(targetPath);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return { scope: options.projectTrusted ? "project" : "global", path: targetPath };
};
