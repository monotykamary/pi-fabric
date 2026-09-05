import type { FabricConversationTarget } from "./conversation.js";
import {
  isActiveStatus,
  orderAgentsByCreation,
  type FabricDashboardSnapshot,
  type FabricUiAgent,
} from "./types.js";

const terminalStatuses = new Set([
  "completed",
  "done",
  "failed",
  "error",
  "timed_out",
  "stopped",
  "cancelled",
]);

const vedaReason = "Veda runner does not support steer or follow-up";

interface FabricTargetEligibility {
  status: string;
  runner?: string;
  /** Advertised participant capabilities; absent means no metadata. */
  caps?: readonly string[];
  stale?: boolean;
  /** Remote target with no live participant route. */
  foreign?: boolean;
  /** Nested agent row; the agent manager cannot steer grandchildren directly. */
  nested?: boolean;
  /** Veda lacks steer/followUp only for one-shot agent runs, not actor mailboxes. */
  gateVeda?: boolean;
}

const deny = (reason: string) => ({
  canSteer: false,
  canFollowUp: false,
  canStop: false,
  readOnlyReason: reason,
});

const eligibilityFor = (input: FabricTargetEligibility) => {
  if (input.stale) return { ...deny("Owner is unavailable or stale"), stale: true };
  if (terminalStatuses.has(input.status)) {
    if (input.status === "stopped") return deny("Target is stopped");
    if (input.status === "failed" || input.status === "error") {
      return deny("Target failed its last run");
    }
    return deny(`Target finished (${input.status}); one-shot runs are read-only`);
  }
  const veda = input.gateVeda === true && input.runner === "veda";
  if (input.caps) {
    const canSteer = !veda && input.caps.includes("steer");
    const canFollowUp = !veda && input.caps.includes("followUp");
    const canStop = input.caps.includes("stop");
    const readOnlyReason = canSteer || canFollowUp
      ? undefined
      : veda
        ? vedaReason
        : "Target capabilities do not allow messaging";
    return { canSteer, canFollowUp, canStop, ...(readOnlyReason ? { readOnlyReason } : {}) };
  }
  if (input.foreign) return deny("No live participant route for remote target");
  if (input.nested) return deny("No direct control route for nested agent");
  const canSteer = !veda;
  const canFollowUp = !veda;
  return {
    canSteer,
    canFollowUp,
    canStop: true,
    ...(canSteer || canFollowUp ? {} : { readOnlyReason: vedaReason }),
  };
};

const targetForAgent = (
  agent: FabricUiAgent,
  mainId: string,
  parentId: string | undefined,
): FabricConversationTarget => ({
  id: agent.id,
  name: agent.name,
  kind: "agent",
  status: agent.status,
  ...(parentId ? { parentId } : {}),
  ...(agent.runner ? { runner: agent.runner } : {}),
  ...(agent.model ? { model: agent.model } : {}),
  ...(agent.thinking ? { thinking: agent.thinking } : {}),
  ...(agent.cwd ? { cwd: agent.cwd } : {}),
  ...(agent.branch ? { branch: agent.branch } : {}),
  ...(agent.usage ? { usage: { ...agent.usage } } : {}),
  ...(agent.updatedAt !== undefined ? { updatedAt: agent.updatedAt } : {}),
  ...eligibilityFor({
    status: agent.status,
    ...(agent.runner ? { runner: agent.runner } : {}),
    ...(agent.capabilities ? { caps: agent.capabilities } : {}),
    ...(agent.stale ? { stale: true } : {}),
    // Explicit local ownership is authoritative for the local manager
    // fallback even when ownerHostId is stale decoration; caps metadata
    // normally exists alongside it.
    foreign: agent.local === false,
    nested:
      (agent.nestingDepth ?? 0) > 0 ||
      (agent.parentId !== undefined && agent.parentId !== mainId),
    gateVeda: true,
  }),
});

const targetForActor = (
  actor: FabricDashboardSnapshot["actors"][number],
  participantById: Map<string, FabricParticipantAlias>,
  parentId: string | undefined,
  localCwd: string | undefined,
): FabricConversationTarget => {
  const participant = participantById.get(actor.id);
  const worker = !actor.lastRunId || actor.worker?.id === actor.lastRunId ? actor.worker : undefined;
  const cwd = worker?.cwd ?? participant?.cwd ?? (actor.local !== false ? localCwd : undefined);
  const lastMessage = actor.recentMessages.slice().reverse().find((message) => message.direction === "out" &&
    actor.lastRunId !== undefined && message.runId === actor.lastRunId && message.usage);
  const usage = worker?.usage ?? lastMessage?.usage;
  const active = worker && isActiveStatus(worker.status) ? worker : undefined;
  const model = active?.model ?? actor.model;
  const thinking = active?.thinking ?? actor.thinking;
  return {
    id: actor.id,
    name: actor.name,
    kind: "actor",
    status: actor.status,
    ...(parentId ? { parentId } : {}),
    ...(actor.runner ? { runner: actor.runner } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(cwd ? { cwd } : {}),
    ...(worker?.branch ? { branch: worker.branch } : {}),
    ...(usage ? { usage: { ...usage } } : {}),
    ...(actor.updatedAt !== undefined ? { updatedAt: actor.updatedAt } : {}),
    ...eligibilityFor({
      status: actor.status,
      ...(actor.runner ? { runner: actor.runner } : {}),
      ...(participant ? { caps: [...participant.capabilities] } : {}),
      ...(participant?.stale ? { stale: true } : {}),
      foreign: actor.local === false && !participant,
      // A Veda actor mailbox can still launch subsequent activations.
      gateVeda: false,
    }),
  };
};

const targetForPeer = (
  peer: FabricDashboardSnapshot["peers"][number],
  participantById: Map<string, FabricParticipantAlias>,
): FabricConversationTarget => {
  const participant = participantById.get(peer.id);
  return {
    id: peer.id,
    name: peer.name,
    kind: "peer",
    status: peer.status,
    runner: peer.runner,
    ...(peer.model ? { model: peer.model } : {}),
    ...(peer.thinking ? { thinking: peer.thinking } : {}),
    ...(peer.cwd ? { cwd: peer.cwd } : {}),
    updatedAt: peer.updatedAt,
    ...eligibilityFor({
      status: peer.status,
      runner: peer.runner,
      ...(participant ? { caps: [...participant.capabilities] } : {}),
      ...(participant?.stale ? { stale: true } : {}),
    }),
    // Peer sessions are not stoppable without an advertised stop capability
    // route (stopParticipant requires a participant record).
    ...(participant ? {} : { canStop: false }),
  };
};

const targetForParticipant = (
  participant: FabricParticipantAlias,
  parentId: string | undefined,
): FabricConversationTarget => {
  const kind =
    participant.kind === "agent" ? "agent" : participant.kind === "actor" ? "actor" : "peer";
  return {
    id: participant.id,
    name: participant.name,
    kind: kind as FabricConversationTarget["kind"],
    status: participant.status,
    ...(parentId ? { parentId } : {}),
    ...(participant.runner ? { runner: participant.runner } : {}),
    ...(participant.model ? { model: participant.model } : {}),
    ...(participant.thinking ? { thinking: participant.thinking } : {}),
    ...(participant.cwd ? { cwd: participant.cwd } : {}),
    updatedAt: participant.updatedAt,
    ...eligibilityFor({
      status: participant.status,
      runner: participant.runner,
      caps: [...participant.capabilities],
      ...(participant.stale ? { stale: true } : {}),
      gateVeda: participant.kind === "agent",
    }),
  };
};

type FabricParticipantAlias = NonNullable<FabricDashboardSnapshot["participants"]>[number];

const resolvedAgentParent = (
  agent: FabricUiAgent,
  knownIds: Set<string>,
  mainId: string,
): string | undefined => {
  const parentId = agent.parentId === agent.id ? undefined : agent.parentId;
  const rootId = agent.rootId === agent.id ? undefined : agent.rootId;
  if (parentId && knownIds.has(parentId)) return parentId;
  if (rootId && rootId !== mainId) return knownIds.has(rootId) ? rootId : undefined;
  return mainId;
};

// Actor lineage: participant.parentId is authoritative when known, then
// actor.rootId; otherwise a local actor hangs under Main and a foreign one
// stays unowned.
const actorParentId = (
  actor: FabricDashboardSnapshot["actors"][number],
  participantById: Map<string, FabricParticipantAlias>,
  knownIds: Set<string>,
  mainId: string,
): string | undefined => {
  const participantParent = participantById.get(actor.id)?.parentId;
  if (
    participantParent &&
    participantParent !== actor.id &&
    knownIds.has(participantParent)
  ) {
    return participantParent;
  }
  const foreign = actor.local === false;
  if (actor.rootId && actor.rootId !== actor.id && knownIds.has(actor.rootId)) {
    // Never pretend Main owns a foreign actor whose lineage root is Main.
    return foreign && actor.rootId === mainId ? undefined : actor.rootId;
  }
  return foreign ? undefined : mainId;
};

// Stable preorder: every parent target is emitted before its children,
// across all kinds. Cycles and orphaned parents are bounded by a visited
// fixup pass in source order.
const preorderTargets = (targets: FabricConversationTarget[]): FabricConversationTarget[] => {
  const ids = new Set(targets.map((target) => target.id));
  const children = new Map<string, FabricConversationTarget[]>();
  const roots: FabricConversationTarget[] = [];
  for (const target of targets) {
    const parent =
      target.parentId && target.parentId !== target.id && ids.has(target.parentId)
        ? target.parentId
        : undefined;
    if (!parent) {
      roots.push(target);
      continue;
    }
    const entries = children.get(parent) ?? [];
    entries.push(target);
    children.set(parent, entries);
  }
  const out: FabricConversationTarget[] = [];
  const visited = new Set<string>();
  const emit = (target: FabricConversationTarget): void => {
    if (visited.has(target.id)) return;
    visited.add(target.id);
    out.push(target);
    for (const child of children.get(target.id) ?? []) emit(child);
  };
  for (const root of roots) emit(root);
  for (const target of targets) emit(target);
  return out;
};

export const conversationTargets = (
  snapshot: FabricDashboardSnapshot,
): FabricConversationTarget[] => {
  const drafts: FabricConversationTarget[] = [];
  const seen = new Set<string>();
  const participants = snapshot.participants ?? [];
  const participantById = new Map(participants.map((participant) => [participant.id, participant]));

  const main = snapshot.main;

  seen.add(main.id);
  drafts.push({
    id: main.id,
    name: main.name,
    kind: "main",
    status: main.status,
    runner: "pi",
    ...(main.model ? { model: main.model } : {}),
    ...(main.thinking ? { thinking: main.thinking } : {}),
    ...(main.cwd ? { cwd: main.cwd } : {}),
    updatedAt: main.updatedAt,
    canSteer: false,
    canFollowUp: false,
    canStop: false,
    readOnlyReason: "Main is navigation-only in the focused view",
  });

  const agents: FabricUiAgent[] = [];
  for (const agent of orderAgentsByCreation(snapshot.agents)) {
    if (seen.has(agent.id)) continue;
    seen.add(agent.id);
    agents.push(agent);
  }

  const knownIds = new Set<string>([
    main.id,
    ...agents.map((agent) => agent.id),
    ...snapshot.actors.map((actor) => actor.id),
    ...snapshot.peers.map((peer) => peer.id),
    ...participants.map((participant) => participant.id),
  ]);

  for (const agent of agents) {
    drafts.push(targetForAgent(agent, main.id, resolvedAgentParent(agent, knownIds, main.id)));
  }
  for (const actor of snapshot.actors) {
    if (seen.has(actor.id)) continue;
    seen.add(actor.id);
    drafts.push(
      targetForActor(actor, participantById, actorParentId(actor, participantById, knownIds, main.id), main.cwd),
    );
  }
  for (const peer of snapshot.peers) {
    if (seen.has(peer.id)) continue;
    seen.add(peer.id);
    drafts.push(targetForPeer(peer, participantById));
  }
  for (const participant of participants) {
    if (seen.has(participant.id)) continue;
    seen.add(participant.id);
    const parentId =
      participant.parentId &&
      participant.parentId !== participant.id &&
      knownIds.has(participant.parentId)
        ? participant.parentId
        : undefined;
    drafts.push(targetForParticipant(participant, parentId));
  }

  return preorderTargets(drafts);
};

/** Implicit opens prefer a live working child, never the oldest retained run. */
export const defaultConversationTarget = (
  targets: FabricConversationTarget[],
  rememberedId?: string,
): FabricConversationTarget | undefined => {
  const candidates = targets.filter((target) => target.kind !== "main" && !target.stale);
  const available = (target: FabricConversationTarget): boolean => target.canSteer || target.canFollowUp || target.canStop;
  const recent = (a: FabricConversationTarget, b: FabricConversationTarget): number =>
    (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  const active = candidates.filter((target) => isActiveStatus(target.status) && available(target));
  const children = active.filter((target) => target.kind !== "peer");
  const preferred = children.length ? children : active;
  const remembered = candidates.find((target) => target.id === rememberedId);
  return preferred.find((target) => target === remembered)
    ?? preferred.sort(recent)[0]
    ?? (remembered && available(remembered) ? remembered : undefined)
    ?? candidates.filter(available).sort(recent)[0]
    ?? remembered
    ?? candidates.sort(recent)[0];
};

export const resolveConversationTarget = (
  targets: FabricConversationTarget[],
  query: string,
): FabricConversationTarget => {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error("No conversation target specified");
  }
  const exactId = targets.find((target) => target.id === trimmed);
  if (exactId) return exactId;
  const lower = trimmed.toLowerCase();
  const nameMatches = targets.filter((target) => target.name.toLowerCase() === lower);
  if (nameMatches.length === 1 && nameMatches[0]) return nameMatches[0];
  if (nameMatches.length > 1) {
    throw new Error(
      `Ambiguous conversation target: "${trimmed}" matches ${nameMatches.map((t) => t.id).join(", ")}`,
    );
  }
  const prefixMatches = targets.filter((target) => target.id.toLowerCase().startsWith(lower));
  if (prefixMatches.length === 1 && prefixMatches[0]) return prefixMatches[0];
  if (prefixMatches.length > 1) {
    throw new Error(
      `Ambiguous conversation target: "${trimmed}" matches ${prefixMatches.map((t) => t.id).join(", ")}`,
    );
  }
  throw new Error(`Unknown conversation target: "${trimmed}"`);
};
