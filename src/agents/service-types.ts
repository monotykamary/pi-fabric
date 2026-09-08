import type { AgentRunRecord, AgentRunRequest, AgentUsage } from "./types.js";

export type AgentServiceRequest = Pick<AgentRunRequest,
  "task" | "name" | "model" | "thinking" | "tools" | "timeoutMs" | "schema" | "images" | "systemPrompt" | "recursive" | "cwd"
> & { runner?: "pi"; kernel?: "typescript" | "inherit"; extensions?: true; worktree?: false };
export type AgentServiceStatus = AgentRunRecord["status"] | "paused";
export type AgentServiceRecord = Omit<AgentRunRecord, "status" | "transport" | "cwd"> & {
  status: AgentServiceStatus; cwd?: string;
  rootId: string; parentId: string; depth: number; generation: number; checkpoint?: unknown;
};
/** Model-facing records never carry opaque host checkpoints. */
export type AgentPublicRecord = Omit<AgentServiceRecord, "checkpoint">;
export interface AgentPrepareRequest extends AgentControlRequest {
  rootId: string; parentId: string; depth: number; request: AgentServiceRequest; signal: AbortSignal;
}
export interface AgentControlRequest {
  rootId: string; parentId: string; id: string; generation: number;
}
export interface AgentExecutionRequest extends AgentPrepareRequest, AgentControlRequest {
  binding: unknown; checkpoint?: unknown;
  emit(event: AgentExecutionEvent): Promise<void>;
}
export type AgentExecutionEvent =
  | { type: "progress"; text?: string; turns?: number; toolCalls?: number; currentTool?: string; usage?: AgentUsage }
  | { type: "checkpoint"; checkpoint: unknown };
export interface AgentExecutionResponse {
  status: "completed" | "failed" | "stopped" | "timed_out" | "paused";
  text?: string; value?: unknown; error?: string; usage?: AgentUsage; checkpoint?: unknown; sessionId?: string;
}
export interface AgentExecutionPort {
  prepare?(request: AgentPrepareRequest): Promise<unknown>;
  execute(request: AgentExecutionRequest): Promise<AgentExecutionResponse>;
  resume?(request: AgentExecutionRequest): Promise<AgentExecutionResponse>;
  /** Gracefully quiesce effects, interrupt the model, and settle execute with a private paused checkpoint.
   * Must not rely on request.signal being aborted or await service cleanup. */
  pause?(request: AgentControlRequest): Promise<void>;
  stop?(request: AgentControlRequest): Promise<void>;
  steer?(request: AgentControlRequest & { message: string }): Promise<void>;
  compact?(request: AgentControlRequest & { instructions?: string }): Promise<void>;
  cleanup?(request: AgentControlRequest): Promise<void>;
}
export type AgentServiceAction = "run" | "spawn" | "wait" | "status" | "list" | "stop" | "steer" | "compact" | "resume";
export interface AgentServiceCapabilities { steer?: boolean; compact?: boolean; resume?: boolean }
export interface AgentServiceEvent {
  version: 1; sequence: number;
  type: "admitted" | "running" | "progress" | "checkpoint" | "settled" | "control";
  record: AgentServiceRecord; control?: "stop" | "steer" | "compact";
}
export interface AgentServiceSnapshot {
  version: 1; rootId: string; starts: number; sequence: number;
  records: Array<{ request: AgentServiceRequest; record: AgentServiceRecord }>;
}
/** Trusted host boundary: checkpoint permission still requires a valid lease. */
export interface AgentAuthorityBoundary { checkpoint?: boolean }
export interface AgentServiceOptions {
  rootId: string; port: AgentExecutionPort;
  maxStarts?: number; maxDepth?: number; maxConcurrent?: number;
  assertAuthority?(callerId: string, boundary?: AgentAuthorityBoundary): void | Promise<void>;
  onEvent?(event: AgentServiceEvent): void | Promise<void>;
  snapshot?: AgentServiceSnapshot;
  /** Trusted host only: a new root turn rebases lineage and resets admission, never generations. */
  restorePolicy?: "preserve" | "new-root";
}
export type AgentServiceDispatcher = (action: AgentServiceAction, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
export interface AgentServiceClient {
  readonly capabilities: AgentServiceCapabilities;
  dispatch: AgentServiceDispatcher;
  run(request: AgentServiceRequest, signal?: AbortSignal): Promise<AgentPublicRecord>;
  spawn(request: AgentServiceRequest, signal?: AbortSignal): Promise<AgentPublicRecord>;
  wait(id: string, signal?: AbortSignal): Promise<AgentPublicRecord>;
  status(id: string): Promise<AgentPublicRecord>;
  list(): Promise<AgentPublicRecord[]>;
  stop(id: string): Promise<AgentPublicRecord>;
  steer(id: string, message: string): Promise<AgentPublicRecord>;
  compact(id: string, instructions?: string): Promise<AgentPublicRecord>;
  resume(id: string, task?: string, signal?: AbortSignal): Promise<AgentPublicRecord>;
}
