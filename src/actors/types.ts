import type { FabricAgentRunner, FabricSubagentTransport } from "../config.js";
import type { FabricThinking } from "../thinking.js";
import type { FabricLogLine, SubagentRunRecord, SubagentUsage } from "../subagents/types.js";

export type FabricActorHostEvent =
  | "input"
  | "turn_end"
  | "agent_settled"
  | "tool_error"
  | "session_compact";

export type FabricActorDelivery = "mailbox" | "steer" | "followUp" | "nextTurn";
export type FabricActorResponseMode = "text" | "directive";
export type FabricActorStatus = "idle" | "queued" | "running" | "stopped";

export interface FabricActorRequest {
  name: string;
  instructions: string;
  events?: FabricActorHostEvent[];
  topics?: string[];
  delivery?: FabricActorDelivery;
  responseMode?: FabricActorResponseMode;
  triggerTurn?: boolean;
  coalesce?: boolean;
  runner?: FabricAgentRunner;
  model?: string;
  thinking?: FabricThinking;
  tools?: string[];
  transport?: FabricSubagentTransport;
  timeoutMs?: number;
}

export interface FabricActorInfo {
  id: string;
  name: string;
  status: FabricActorStatus;
  runner: FabricAgentRunner;
  events: FabricActorHostEvent[];
  topics: string[];
  delivery: FabricActorDelivery;
  responseMode: FabricActorResponseMode;
  triggerTurn: boolean;
  coalesce: boolean;
  model?: string;
  thinking?: FabricThinking;
  tools?: string[];
  queued: number;
  messages: number;
  createdAt: number;
  updatedAt: number;
  lastRunId?: string;
  lastError?: string;
  sessionFile?: string;
  logDir?: string;
}

export interface FabricActorLog {
  actorId: string;
  actorName: string;
  sessionFile: string;
  logDir: string;
  session: FabricLogLine[];
  sessionHasMore: boolean;
  sessionBefore?: number;
  run?: {
    runId: string;
    eventsFile: string;
    status?: SubagentRunRecord;
    events: FabricLogLine[];
    hasMore: boolean;
    before?: number;
  };
  retainedRuns: string[];
}

export interface FabricActorMessage {
  id: string;
  actorId: string;
  actorName: string;
  direction: "in" | "out";
  source: string;
  createdAt: number;
  text?: string;
  data?: unknown;
  action?: "silent" | "message" | "stop";
  runId?: string;
  usage?: SubagentUsage;
  error?: string;
}

export interface FabricActorDirective {
  action: "silent" | "message" | "stop";
  message?: string;
  data?: unknown;
}

export interface FabricActorDeliveryRequest {
  actor: FabricActorInfo;
  message: FabricActorMessage;
  delivery: Exclude<FabricActorDelivery, "mailbox">;
  triggerTurn: boolean;
}

/**
 * A project-independent actor template stored in the global registry
 * (the user's agent dir, not a project mesh). It carries only the actor
 * definition (the same fields as FabricActorRequest) plus identity and
 * timestamps — never any history (messages, session transcript, or run logs).
 * Global actors are not live: they are stamped into a project via import,
 * which creates a fresh live actor with no inherited history.
 */
export interface GlobalActorDefinition extends FabricActorRequest {
  id: string;
  createdAt: number;
  updatedAt: number;
  // Redeclared required: the registry always materializes these (defaults
  // applied on create and load), so they are never undefined on a stored
  // template. Keeping them required avoids undefined creeping into merges and
  // spreads under exactOptionalPropertyTypes.
  events: FabricActorHostEvent[];
  topics: string[];
  delivery: FabricActorDelivery;
  responseMode: FabricActorResponseMode;
  triggerTurn: boolean;
  coalesce: boolean;
  runner: FabricAgentRunner;
}
