import type { ExtensionEvent } from "@earendil-works/pi-coding-agent";
import type { FabricAgentRunner, FabricSubagentTransport } from "../config.js";
import type { FabricThinking } from "../thinking.js";
import type { FabricLogLine, SubagentRunRecord, SubagentUsage } from "../subagents/types.js";

export type FabricActorPiHostEvent = Exclude<ExtensionEvent["type"], "project_trust">;

const defineFabricActorPiHostEvents = <
  const Events extends readonly FabricActorPiHostEvent[],
>(
  events: Exclude<FabricActorPiHostEvent, Events[number]> extends never ? Events : never,
): Events => events;

export const FABRIC_ACTOR_PI_HOST_EVENTS = defineFabricActorPiHostEvents([
  "resources_discover",
  "session_start",
  "session_info_changed",
  "session_before_switch",
  "session_before_fork",
  "session_before_compact",
  "session_compact",
  "session_shutdown",
  "session_before_tree",
  "session_tree",
  "input",
  "before_agent_start",
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "context",
  "before_provider_headers",
  "before_provider_request",
  "after_provider_response",
  "tool_execution_start",
  "tool_call",
  "tool_execution_update",
  "tool_result",
  "tool_execution_end",
  "model_select",
  "thinking_level_select",
  "user_bash",
]);

export const FABRIC_ACTOR_HOST_EVENTS = [
  ...FABRIC_ACTOR_PI_HOST_EVENTS,
  "tool_error",
] as const;

export type FabricActorHostEvent = (typeof FABRIC_ACTOR_HOST_EVENTS)[number];

const FABRIC_ACTOR_HOST_EVENT_SET: ReadonlySet<string> = new Set(FABRIC_ACTOR_HOST_EVENTS);

export const isFabricActorHostEvent = (value: unknown): value is FabricActorHostEvent =>
  typeof value === "string" && FABRIC_ACTOR_HOST_EVENT_SET.has(value);

export type FabricActorDelivery = "mailbox" | "steer" | "followUp" | "nextTurn";
export type FabricActorResponseMode = "text" | "directive";
export type FabricActorStatus = "idle" | "queued" | "running" | "stopped";

export interface FabricActorValidWhileSource {
  version: 1;
  source: string;
}

export interface FabricActorValidityDecision {
  valid: boolean;
  reason?: string;
}

export type FabricActorActivation =
  | {
      kind: "hostEvent";
      id: string;
      source: string;
      sequence: number;
      createdAt: number;
      event: FabricActorHostEvent;
      mainRevision: number;
      taskRevision: number;
      signal?: unknown;
    }
  | {
      kind: "direct";
      id: string;
      source: string;
      sequence: number;
      createdAt: number;
    }
  | {
      kind: "mesh";
      id: string;
      source: string;
      sequence: number;
      createdAt: number;
      topic: string;
    };

export interface FabricActorValidityFacts {
  activation: FabricActorActivation;
  current: {
    latestActivationSequence: number;
    mainRevision: number;
    taskRevision: number;
    idle: boolean;
    now: number;
  };
}

export interface FabricActorRequest {
  name: string;
  instructions: string;
  /** Asynchronous observations of session-bound Pi events plus synthetic tool_error. */
  events?: FabricActorHostEvent[];
  topics?: string[];
  /** Defaults to mailbox. steer/followUp require an explicit triggerTurn choice. */
  delivery?: FabricActorDelivery;
  responseMode?: FabricActorResponseMode;
  /** Required for steer/followUp; must be false or omitted for mailbox/nextTurn. */
  triggerTurn?: boolean;
  coalesce?: boolean;
  runner?: FabricAgentRunner;
  model?: string;
  thinking?: FabricThinking;
  tools?: string[];
  transport?: FabricSubagentTransport;
  timeoutMs?: number;
  /**
   * Fabric capability for the actor. Defaults to true (today's behavior: a Pi
   * actor is recursively Fabric-equipped with the host-required fabric_exec
   * tool). Set false to disable Fabric for a Pi actor: the activation runs with
   * extensions:false and recursive:false so fabric_exec is not injected and the
   * actor cannot call agents.* or mesh.*; the host still manages its mailbox
   * and delivery (same model as a Claude actor). This does not restrict the
   * actor's ordinary tool allowlist. Fixed at creation.
   */
  extensions?: boolean;
  /** Serialized guest predicate evaluated before work and before delivery. */
  validWhile?: FabricActorValidWhileSource;
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
  extensions?: boolean;
  validWhile?: FabricActorValidWhileSource;
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
  stale?: boolean;
  reason?: string;
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
