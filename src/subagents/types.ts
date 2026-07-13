import type { FabricSubagentTransport } from "../config.js";

export type SubagentRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "timed_out";

export interface SubagentRunRequest {
  task: string;
  name?: string;
  transport?: FabricSubagentTransport;
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  tools?: string[];
  timeoutMs?: number;
  extensions?: boolean;
  recursive?: boolean;
  worktree?: boolean;
  schema?: Record<string, unknown>;
  systemPrompt?: string;
  sessionFile?: string;
  actorId?: string;
  actorName?: string;
  meshRoot?: string;
}

export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface FabricBudgetSummary {
  limit: number;
  spent: number;
  remaining: number;
  tokens: number;
}

export interface SubagentRunRecord {
  id: string;
  name: string;
  task: string;
  status: SubagentRunStatus;
  transport: FabricSubagentTransport;
  cwd: string;
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  actorId?: string;
  actorName?: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  currentTool?: string;
  turns: number;
  toolCalls: number;
  text: string;
  value?: unknown;
  error?: string;
  stderr?: string;
  exitCode?: number | null;
  usage: SubagentUsage;
  budget?: FabricBudgetSummary;
  sessionId?: string;
  attachCommand?: string;
  branch?: string;
  worktree?: string;
  logFile?: string;
  nestedAgents?: SubagentRunRecord[];
}

export interface SubagentRunResult extends SubagentRunRecord {
  status: "completed" | "failed" | "stopped" | "timed_out";
}

export interface SubagentHandleInfo {
  id: string;
  name: string;
  status: SubagentRunStatus;
  transport: FabricSubagentTransport;
  cwd: string;
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  actorId?: string;
  actorName?: string;
  sessionId?: string;
  attachCommand?: string;
  branch?: string;
  worktree?: string;
}

export interface SubagentWorkerOptions {
  id: string;
  name: string;
  taskFile: string;
  statusFile: string;
  logFile: string;
  schemaFile?: string;
  cwd: string;
  piBinary: string;
  timeoutMs: number;
  depth: number;
  fullCodeMode: boolean;
  extensions: boolean;
  tools: string[];
  grantedRisks: string[];
  fabricExtensionPath?: string;
  model?: string;
  thinking?: string;
  systemPrompt?: string;
  sessionFile?: string;
  actorId?: string;
  actorName?: string;
  meshRoot?: string;
  runRoot?: string;
  transport: FabricSubagentTransport;
  sessionId?: string;
  attachCommand?: string;
  branch?: string;
  worktree?: string;
}

export interface SubagentTransportLaunch {
  id: string;
  name: string;
  cwd: string;
  workerPath: string;
  workerArguments: string[];
}

export interface SubagentTransportHandle {
  kind: FabricSubagentTransport;
  sessionId?: string;
  attachCommand?: string;
  isAlive(): Promise<boolean>;
  stop(): Promise<void>;
}

export interface SubagentTransportAdapter {
  kind: FabricSubagentTransport;
  available(): Promise<boolean>;
  launch(request: SubagentTransportLaunch): Promise<SubagentTransportHandle>;
}
