import fs from "node:fs";
import path from "node:path";

export type FabricApprovalMode = "allow" | "ask" | "deny";
export type FabricSubagentTransport = "auto" | "process" | "tmux" | "screen" | "localterm";

export interface FabricExecutorConfig {
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

export interface FabricSubagentConfig {
  enabled: boolean;
  transport: FabricSubagentTransport;
  maxConcurrent: number;
  maxPerExecution: number;
  maxDepth: number;
  timeoutMs: number;
  extensions: boolean;
  defaultTools: string[];
  retainRuns: boolean;
  notifyOnComplete: boolean;
}

export interface FabricMeshConfig {
  enabled: boolean;
  root?: string;
  maxEventBytes: number;
  maxReadEvents: number;
  actorPollMs: number;
  actorQueueLimit: number;
  eventContextChars: number;
}

export interface FabricConfig {
  executor: FabricExecutorConfig;
  approvals: FabricApprovalConfig;
  mcp: FabricMcpConfig;
  subagents: FabricSubagentConfig;
  mesh: FabricMeshConfig;
}

export const DEFAULT_FABRIC_CONFIG: FabricConfig = {
  executor: {
    timeoutMs: 120_000,
    memoryLimitBytes: 64 * 1024 * 1024,
    maxOutputChars: 100_000,
    maxNestedResultChars: 2_000_000,
  },
  approvals: {
    read: "allow",
    write: "ask",
    execute: "ask",
    network: "ask",
    agent: "ask",
  },
  mcp: {
    enabled: true,
    disableOAuth: true,
    allowDynamicServers: true,
    callTimeoutMs: 120_000,
  },
  subagents: {
    enabled: true,
    transport: "process",
    maxConcurrent: 4,
    maxPerExecution: 100,
    maxDepth: 2,
    timeoutMs: 600_000,
    extensions: true,
    defaultTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    retainRuns: false,
    notifyOnComplete: true,
  },
  mesh: {
    enabled: true,
    maxEventBytes: 256 * 1024,
    maxReadEvents: 500,
    actorPollMs: 250,
    actorQueueLimit: 32,
    eventContextChars: 40_000,
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

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

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

const objectValue = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const normalizeFabricConfig = (input: Record<string, unknown>): FabricConfig => {
  const executor = objectValue(input.executor);
  const approvals = objectValue(input.approvals);
  const mcp = objectValue(input.mcp);
  const subagents = objectValue(input.subagents);
  const mesh = objectValue(input.mesh);
  const configuredTools = Array.isArray(subagents.defaultTools)
    ? subagents.defaultTools.filter(
        (tool): tool is string => typeof tool === "string" && Boolean(tool),
      )
    : DEFAULT_FABRIC_CONFIG.subagents.defaultTools;
  const configPath = stringValue(mcp.configPath);
  const meshRoot = stringValue(mesh.root);

  return {
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
      transport: transportValue(subagents.transport, DEFAULT_FABRIC_CONFIG.subagents.transport),
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
        1_000,
        3_600_000,
      ),
      extensions: booleanValue(subagents.extensions, DEFAULT_FABRIC_CONFIG.subagents.extensions),
      defaultTools: configuredTools,
      retainRuns: booleanValue(subagents.retainRuns, DEFAULT_FABRIC_CONFIG.subagents.retainRuns),
      notifyOnComplete: booleanValue(
        subagents.notifyOnComplete,
        DEFAULT_FABRIC_CONFIG.subagents.notifyOnComplete,
      ),
    },
    mesh: {
      enabled: booleanValue(mesh.enabled, DEFAULT_FABRIC_CONFIG.mesh.enabled),
      ...(meshRoot ? { root: meshRoot } : {}),
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
    },
  };
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
  return normalizeFabricConfig(merged);
};
