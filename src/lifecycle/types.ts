import type { FabricAgentRunner } from "../config.js";
import type { MeshEvent, MeshIdentity } from "../mesh/store.js";
import type { FabricParticipantKind } from "../topology/types.js";

export const FABRIC_PARTICIPANT_LIFECYCLE_TOPIC = "fabric.participant.lifecycle";
export const FABRIC_LIFECYCLE_SUBSCRIPTION_PREFIX = "topology/subscriptions/";

export const FABRIC_LIFECYCLE_EVENTS = [
  "pi.input",
  "pi.agent_start",
  "pi.agent_end",
  "pi.turn_end",
  "pi.agent_settled",
  "pi.tool_error",
  "pi.session_compact",
  "run.completed",
  "run.failed",
  "run.stopped",
  "run.timed_out",
] as const;

export type FabricLifecycleEventType = (typeof FABRIC_LIFECYCLE_EVENTS)[number];
type FabricLifecycleDelivery = "steer" | "followUp";

export interface FabricLifecycleSource {
  id: string;
  name: string;
  kind: FabricParticipantKind;
  rootId: string;
  runner: FabricAgentRunner;
  ownerHostId?: string;
  ownerIdentityId?: string;
}

export interface FabricLifecyclePublishRequest {
  source: FabricLifecycleSource;
  event: FabricLifecycleEventType;
  occurredAt?: number;
  runId?: string;
  status?: string;
  data?: unknown;
}

export interface FabricLifecycleEvent {
  version: 1;
  id: string;
  sequence: number;
  event: FabricLifecycleEventType;
  source: FabricLifecycleSource;
  occurredAt: number;
  publishedAt: number;
  runId?: string;
  status?: string;
  data?: unknown;
}

export interface FabricLifecycleSubscriptionRequest {
  from: string;
  events: FabricLifecycleEventType[];
  to: string;
  delivery: FabricLifecycleDelivery;
  triggerTurn: boolean;
  once?: boolean;
}

export interface FabricLifecycleSubscription {
  format: 1;
  id: string;
  from: string;
  events: FabricLifecycleEventType[];
  to: string;
  delivery: FabricLifecycleDelivery;
  triggerTurn: boolean;
  once: boolean;
  afterSequence: number;
  createdAt: number;
  updatedAt: number;
  createdBy: MeshIdentity;
  lastDeliveredAt?: number;
  lastEventId?: string;
  lastError?: string;
}

const lifecycleEvents = new Set<string>(FABRIC_LIFECYCLE_EVENTS);

export const isFabricLifecycleEventType = (
  value: unknown,
): value is FabricLifecycleEventType =>
  typeof value === "string" && lifecycleEvents.has(value);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const participantKind = (value: unknown): FabricParticipantKind | undefined =>
  value === "root" || value === "agent" || value === "actor" ? value : undefined;

export const lifecycleSourceIdentity = (source: FabricLifecycleSource): MeshIdentity => ({
  id: source.id,
  name: source.name,
  kind: source.kind === "root" ? "main" : source.kind,
});

export const lifecycleEventFromMesh = (
  event: MeshEvent,
): FabricLifecycleEvent | undefined => {
  if (
    event.topic !== FABRIC_PARTICIPANT_LIFECYCLE_TOPIC ||
    !isObject(event.data) ||
    event.data.version !== 1 ||
    !isFabricLifecycleEventType(event.data.event) ||
    event.kind !== event.data.event ||
    !isObject(event.data.source)
  ) {
    return undefined;
  }
  const source = event.data.source;
  const kind = participantKind(source.kind);
  const runner = source.runner === "pi" || source.runner === "claude" ? source.runner : undefined;
  if (
    !kind ||
    !runner ||
    typeof source.id !== "string" ||
    typeof source.name !== "string" ||
    typeof source.rootId !== "string" ||
    event.from.id !== source.id ||
    (kind === "root" ? event.from.kind !== "main" : event.from.kind !== kind) ||
    typeof event.data.occurredAt !== "number"
  ) {
    return undefined;
  }
  const parsedSource: FabricLifecycleSource = {
    id: source.id,
    name: source.name,
    kind,
    rootId: source.rootId,
    runner,
    ...(typeof source.ownerHostId === "string" ? { ownerHostId: source.ownerHostId } : {}),
    ...(typeof source.ownerIdentityId === "string"
      ? { ownerIdentityId: source.ownerIdentityId }
      : {}),
  };
  return {
    version: 1,
    id: event.id,
    sequence: event.sequence,
    event: event.data.event,
    source: parsedSource,
    occurredAt: event.data.occurredAt,
    publishedAt: event.createdAt,
    ...(typeof event.data.runId === "string" ? { runId: event.data.runId } : {}),
    ...(typeof event.data.status === "string" ? { status: event.data.status } : {}),
    ...(Object.prototype.hasOwnProperty.call(event.data, "payload")
      ? { data: event.data.payload }
      : {}),
  };
};

export const lifecycleSubscriptionFromValue = (
  value: unknown,
): FabricLifecycleSubscription | undefined => {
  if (!isObject(value) || value.format !== 1 || !isObject(value.createdBy)) return undefined;
  if (
    typeof value.id !== "string" ||
    typeof value.from !== "string" ||
    typeof value.to !== "string" ||
    !Array.isArray(value.events) ||
    value.events.length === 0 ||
    !value.events.every(isFabricLifecycleEventType) ||
    (value.delivery !== "steer" && value.delivery !== "followUp") ||
    typeof value.triggerTurn !== "boolean" ||
    typeof value.once !== "boolean" ||
    typeof value.afterSequence !== "number" ||
    typeof value.createdAt !== "number" ||
    typeof value.updatedAt !== "number" ||
    typeof value.createdBy.id !== "string" ||
    typeof value.createdBy.name !== "string" ||
    (value.createdBy.kind !== "main" &&
      value.createdBy.kind !== "agent" &&
      value.createdBy.kind !== "actor")
  ) {
    return undefined;
  }
  return value as unknown as FabricLifecycleSubscription;
};
