import type { ImageContent } from "@earendil-works/pi-ai";
import type {
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { FabricAgentRunner, FabricAgentTransport } from "../config.js";
import type { ThinkingTransferInput } from "./thinking-transfer.js";
import type { FabricThinking } from "../thinking.js";
import type { FabricParticipantResidency } from "../topology/types.js";

export type AgentRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "timed_out";

export type AgentToolResultMessage = Extract<
  SessionMessageEntry["message"],
  { role: "toolResult" }
>;

/** Deterministic Fabric compaction applied to the inherited handoff trajectory. */
export interface HandoffCompactionRequest {
  instructions?: string;
  preserve?: string[];
}

export interface AgentSessionSeed {
  sourceSessionId: string;
  sourceSessionFile?: string;
  sourceBranchLeafId: string;
  /** Present only when the source session is in memory and must be materialized. */
  sourceBranch?: SessionEntry[];
  sourceModel?: { provider: string; modelId: string };
  sourceThinkingLevel?: string;
  outerToolResult: AgentToolResultMessage;
}

export interface AgentRunRequest {
  task: string;
  images?: ImageContent[];
  name?: string;
  runner?: FabricAgentRunner;
  transport?: FabricAgentTransport;
  model?: string;
  /** Veda persona name; only used when runner is "veda". */
  persona?: string;
  thinking?: FabricThinking;
  tools?: string[];
  timeoutMs?: number;
  extensions?: boolean;
  recursive?: boolean;
  worktree?: boolean;
  residency?: FabricParticipantResidency;
  schema?: Record<string, unknown>;
  systemPrompt?: string;
  sessionFile?: string;
  actorId?: string;
  actorName?: string;
  meshRoot?: string;
  runnerSessionId?: string;
  /** Host-created Pi branch seed ending with the native outer fabric_exec result. */
  sessionSeed?: AgentSessionSeed;
  /** Source/executor reasoning channels for trajectory thinking transfer. */
  thinkingTransfer?: ThinkingTransferInput | undefined;
  /** Compact the inherited trajectory with Fabric's deterministic compactor before the executor resumes. */
  handoffCompact?: HandoffCompactionRequest;
}

export interface AgentUsage {
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

export interface AgentCompactionStatus {
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

export interface AgentRunRecord {
  id: string;
  name: string;
  task: string;
  status: AgentRunStatus;
  runner: FabricAgentRunner;
  transport: FabricAgentTransport;
  cwd: string;
  model?: string;
  thinking?: FabricThinking;
  actorId?: string;
  actorName?: string;
  recursive?: boolean;
  residency?: FabricParticipantResidency;
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
  usage: AgentUsage;
  budget?: FabricBudgetSummary;
  sessionId?: string;
  runnerSessionId?: string;
  attachCommand?: string;
  branch?: string;
  worktree?: string;
  logFile?: string;
  nestedAgents?: AgentRunRecord[];
  pendingMessages?: { steering: string[]; followUp: string[] };
  compaction?: AgentCompactionStatus;
}

export interface AgentRunResult extends AgentRunRecord {
  status: "completed" | "failed" | "stopped" | "timed_out";
}

export interface AgentHandleInfo {
  id: string;
  name: string;
  status: AgentRunStatus;
  runner: FabricAgentRunner;
  transport: FabricAgentTransport;
  cwd: string;
  model?: string;
  thinking?: FabricThinking;
  actorId?: string;
  actorName?: string;
  recursive?: boolean;
  residency?: FabricParticipantResidency;
  sessionId?: string;
  runnerSessionId?: string;
  attachCommand?: string;
  branch?: string;
  worktree?: string;
}

export interface AgentWorkerOptions {
  id: string;
  runner: FabricAgentRunner;
  name: string;
  taskFile: string;
  imagesFile?: string;
  statusFile: string;
  lifecycleFile: string;
  logFile: string;
  schemaFile?: string;
  cwd: string;
  piBinary: string;
  claudeBinary: string;
  vedaBinary: string;
  vedaBackend: string;
  vedaPersona: string;
  timeoutMs: number;
  depth: number;
  fullCodeMode: boolean;
  mainAgentId?: string;
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
  projectRoot?: string;
  ownerHostId?: string;
  ownerIdentityId?: string;
  runnerSessionId?: string;
  runRoot?: string;
  steerFile?: string;
  transport: FabricAgentTransport;
  sessionId?: string;
  attachCommand?: string;
  branch?: string;
  worktree?: string;
}

export interface AgentTransportLaunch {
  id: string;
  name: string;
  cwd: string;
  workerPath: string;
  workerArguments: string[];
}

export interface AgentTransportHandle {
  kind: FabricAgentTransport;
  sessionId?: string;
  attachCommand?: string;
  livenessPollIntervalMs?: number;
  isAlive(): Promise<boolean>;
  stop(): Promise<void>;
}

export interface AgentTransportAdapter {
  kind: FabricAgentTransport;
  available(): Promise<boolean>;
  launch(request: AgentTransportLaunch): Promise<AgentTransportHandle>;
}

export interface FabricLogLine {
  /** Legacy absolute line index; newer paged readers expose byte offset instead. */
  index?: number;
  offset: number;
  raw: string;
  parsed?: unknown;
}

export interface FabricAgentLog {
  id: string;
  runDirectory: string;
  logFile: string;
  status?: AgentRunRecord;
  events: FabricLogLine[];
  hasMore: boolean;
  before?: number;
}

export type FabricSteeringMode = "all" | "one-at-a-time";

export interface AgentSteerEntry {
  type: "steer" | "follow_up" | "set_steering_mode" | "set_follow_up_mode" | "compact";
  id: string;
  message?: string;
  mode?: FabricSteeringMode;
  instructions?: string;
  data?: unknown;
  ts: number;
}

export interface AgentSteerResult {
  queued: true;
  messageId: string;
}
