export type FabricRunStatus = "running" | "completed" | "failed" | "cancelled";
export type FabricActivityStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "stopped";

export type FabricActivityKind =
  | "agent"
  | "actor"
  | "tool"
  | "extension"
  | "mcp"
  | "mesh"
  | "task"
  | "custom";

export interface FabricRunDisplay {
  name?: string;
  description?: string;
}

export interface FabricPhaseInput {
  name: string;
  id?: string;
  description?: string;
  total?: number;
}

export interface FabricActivityItemInput {
  id: string;
  label: string;
  status?: FabricActivityStatus;
  phase?: string;
  detail?: string;
  kind?: FabricActivityKind;
  current?: string;
  total?: number;
  completed?: number;
  data?: unknown;
}

export interface FabricActivityEventInput {
  message: string;
  level?: "info" | "success" | "warning" | "error";
  data?: unknown;
}

export interface FabricActivityPhase {
  id: string;
  name: string;
  description?: string;
  status: FabricActivityStatus;
  total?: number;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
}

export interface FabricActivityMetrics {
  tokens?: number;
  toolCalls?: number;
  cost?: number;
}

export interface FabricActivityCall {
  id: string;
  ref: string;
  label: string;
  kind: FabricActivityKind;
  status: FabricActivityStatus;
  phaseId?: string;
  entityId?: string;
  entityKind?: FabricActivityKind;
  progress?: string;
  error?: string;
  detail?: string;
  metrics?: FabricActivityMetrics;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
}

export interface FabricActivityItem {
  id: string;
  label: string;
  status: FabricActivityStatus;
  kind: FabricActivityKind;
  phaseId?: string;
  detail?: string;
  current?: string;
  total?: number;
  completed?: number;
  data?: unknown;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
}

export interface FabricActivityEvent {
  id: string;
  message: string;
  level: "info" | "success" | "warning" | "error";
  data?: unknown;
  createdAt: number;
}

export interface FabricActivityRun {
  id: string;
  name: string;
  description?: string;
  status: FabricRunStatus;
  phases: FabricActivityPhase[];
  calls: FabricActivityCall[];
  items: FabricActivityItem[];
  events: FabricActivityEvent[];
  currentPhaseId?: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  error?: string;
}
