import type { FabricSubagentTransport } from "../config.js";
import type { SubagentUsage } from "../subagents/types.js";

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
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  tools?: string[];
  transport?: FabricSubagentTransport;
  timeoutMs?: number;
}

export interface FabricActorInfo {
  id: string;
  name: string;
  status: FabricActorStatus;
  events: FabricActorHostEvent[];
  topics: string[];
  delivery: FabricActorDelivery;
  responseMode: FabricActorResponseMode;
  triggerTurn: boolean;
  queued: number;
  messages: number;
  createdAt: number;
  updatedAt: number;
  lastRunId?: string;
  lastError?: string;
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
