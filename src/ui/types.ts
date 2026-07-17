import type { FabricActorInfo, FabricActorMessage, GlobalActorDefinition } from "../actors/types.js";
import type { FabricActivityRun } from "../activity/types.js";
import type { MeshEvent } from "../mesh/store.js";
import type { SubagentUsage } from "../subagents/types.js";

export interface FabricUiAgent {
  id: string;
  name: string;
  status: string;
  runner?: "pi" | "claude";
  transport: string;
  cwd: string;
  task?: string;
  model?: string;
  thinking?: string;
  currentTool?: string;
  startedAt?: number;
  updatedAt?: number;
  finishedAt?: number;
  turns?: number;
  toolCalls?: number;
  usage?: SubagentUsage;
  text?: string;
  error?: string;
  logFile?: string;
  attachCommand?: string;
  branch?: string;
  worktree?: string;
  actorId?: string;
  actorName?: string;
  runId?: string;
  phaseId?: string;
  parentId?: string;
}

export interface FabricUiActor extends FabricActorInfo {
  /** The actor's default instruction (persona text); shown and edited in the dashboard. */
  instructions: string;
  recentMessages: FabricActorMessage[];
  worker?: FabricUiAgent;
}

export interface FabricUiStateEntry {
  key: string;
  label: string;
  status: string;
  owner?: string;
  detail?: string;
  value: unknown;
  version: number;
  updatedAt: number;
}

export interface FabricDashboardSnapshot {
  now: number;
  widgetDismissedAt?: number;
  runs: FabricActivityRun[];
  agents: FabricUiAgent[];
  actors: FabricUiActor[];
  /** Project-independent actor templates from the global registry. */
  globalActors: GlobalActorDefinition[];
  state: FabricUiStateEntry[];
  events: MeshEvent[];
}

export const activeStatuses = new Set([
  "queued",
  "pending",
  "ready",
  "claimed",
  "running",
  "in_progress",
  "blocked",
]);

export const isActiveStatus = (status: string): boolean => activeStatuses.has(status);

export const orderAgentsByCreation = (agents: FabricUiAgent[]): FabricUiAgent[] =>
  agents
    .map((agent, index) => ({ agent, index }))
    .sort(
      (left, right) =>
        (left.agent.startedAt ?? Number.MAX_SAFE_INTEGER) -
          (right.agent.startedAt ?? Number.MAX_SAFE_INTEGER) ||
        left.index - right.index,
    )
    .map(({ agent }) => agent);
