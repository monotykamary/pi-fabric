import type { FabricAgentRunner, FabricSubagentTransport } from "../config.js";
import type { FabricThinking } from "../thinking.js";

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
  runner?: FabricAgentRunner;
  transport?: FabricSubagentTransport;
  model?: string;
  thinking?: FabricThinking;
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
  runnerSessionId?: string;
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

export interface SubagentCompactionStatus {
  status: "queued" | "in_flight" | "completed" | "failed";
  requestedAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  attempts: number;
  coalescedRequests: number;
  queued?: boolean;
  error?: string;
}

export interface SubagentRunRecord {
  id: string;
  name: string;
  task: string;
  status: SubagentRunStatus;
  runner: FabricAgentRunner;
  transport: FabricSubagentTransport;
  cwd: string;
  model?: string;
  thinking?: FabricThinking;
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
  runnerSessionId?: string;
  attachCommand?: string;
  branch?: string;
  worktree?: string;
  logFile?: string;
  nestedAgents?: SubagentRunRecord[];
  pendingMessages?: { steering: string[]; followUp: string[] };
  compaction?: SubagentCompactionStatus;
}

export interface SubagentRunResult extends SubagentRunRecord {
  status: "completed" | "failed" | "stopped" | "timed_out";
}

export interface SubagentHandleInfo {
  id: string;
  name: string;
  status: SubagentRunStatus;
  runner: FabricAgentRunner;
  transport: FabricSubagentTransport;
  cwd: string;
  model?: string;
  thinking?: FabricThinking;
  actorId?: string;
  actorName?: string;
  sessionId?: string;
  runnerSessionId?: string;
  attachCommand?: string;
  branch?: string;
  worktree?: string;
}

export interface SubagentWorkerOptions {
  id: string;
  runner: FabricAgentRunner;
  name: string;
  taskFile: string;
  statusFile: string;
  logFile: string;
  schemaFile?: string;
  cwd: string;
  piBinary: string;
  claudeBinary: string;
  timeoutMs: number;
  depth: number;
  fullCodeMode: boolean;
  extensions: boolean;
  tools: string[];
  grantedRisks: string[];
  maxTokens?: number;
  fabricExtensionPath?: string;
  model?: string;
  thinking?: string;
  systemPrompt?: string;
  sessionFile?: string;
  actorId?: string;
  actorName?: string;
  meshRoot?: string;
  runnerSessionId?: string;
  runRoot?: string;
  steerFile?: string;
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

export interface FabricLogLine {
  /** Legacy absolute line index; newer paged readers expose byte offset instead. */
  index?: number;
  offset: number;
  raw: string;
  parsed?: unknown;
}

export interface FabricSubagentLog {
  id: string;
  runDirectory: string;
  logFile: string;
  status?: SubagentRunRecord;
  events: FabricLogLine[];
  hasMore: boolean;
  before?: number;
}

export type FabricSteeringMode = "all" | "one-at-a-time";

export interface SubagentSteerEntry {
  type: "steer" | "follow_up" | "set_steering_mode" | "set_follow_up_mode" | "compact";
  id: string;
  message?: string;
  mode?: FabricSteeringMode;
  instructions?: string;
  data?: unknown;
  ts: number;
}

export interface SubagentSteerResult {
  queued: true;
  messageId: string;
}
