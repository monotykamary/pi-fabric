import { createHash } from "node:crypto";
import type { FabricActivityRun } from "../activity/types.js";
import type { MeshEvent } from "../mesh/store.js";
import type { FabricParticipantInfo } from "../topology/types.js";
import type {
  FabricUiActor,
  FabricUiAgent,
  FabricUiMain,
  FabricUiStateEntry,
} from "./types.js";
import { isActiveStatus, orderAgentsByCreation } from "./types.js";

const UNPHASED = Symbol("fabric-run-topology-unphased");
const UNPHASED_ROW_ID = "__fabric_run_topology_unphased";
const failureStatuses = new Set(["failed", "timed_out", "error"]);

interface FabricRunTopologyPhaseRow {
  kind: "phase";
  id: string;
  name: string;
  status: string;
  agentCount: number;
}

interface FabricRunTopologyAgentRow {
  kind: "agent";
  entityId: string;
  agent: FabricUiAgent;
  ancestorLast: boolean[];
  ancestorEntityIds: string[];
  isLast: boolean;
}

type FabricRunTopologyRow = FabricRunTopologyPhaseRow | FabricRunTopologyAgentRow;

interface FabricRunTopologyOmissionRow {
  kind: "omission";
  direction: "before" | "after" | "both";
  rows: number;
  agents: number;
  phases: number;
  active: number;
  blocked: number;
  failed: number;
  context?: string[];
}

type FabricRunTopologyDisplayRow = FabricRunTopologyRow | FabricRunTopologyOmissionRow;

interface FlowGroup {
  id: string;
  name: string;
  status: string;
  agents: FabricUiAgent[];
}

const statusForAgents = (agents: FabricUiAgent[], fallback: string): string => {
  if (agents.some((agent) => failureStatuses.has(agent.status))) return "failed";
  if (agents.some((agent) => agent.status === "blocked")) return "blocked";
  if (agents.some((agent) => isActiveStatus(agent.status))) return "running";
  if (
    agents.length > 0 &&
    agents.every((agent) => ["completed", "done", "stopped", "cancelled"].includes(agent.status))
  ) {
    return agents.some((agent) => agent.status === "stopped" || agent.status === "cancelled")
      ? "stopped"
      : "completed";
  }
  return fallback;
};

type FlowPhaseKey = string | typeof UNPHASED;

const phaseKey = (agent: FabricUiAgent): FlowPhaseKey => agent.phaseId ?? UNPHASED;

const flowGroups = (
  run: FabricActivityRun,
  agents: FabricUiAgent[],
  includeEmptyPhases: boolean,
): FlowGroup[] => {
  const grouped = new Map<FlowPhaseKey, FabricUiAgent[]>();
  for (const agent of agents) {
    const key = phaseKey(agent);
    const entries = grouped.get(key) ?? [];
    entries.push(agent);
    grouped.set(key, entries);
  }

  const groups: FlowGroup[] = [];
  const unphased = grouped.get(UNPHASED) ?? [];
  if (unphased.length > 0) {
    groups.push({
      id: UNPHASED_ROW_ID,
      name: "Run activity",
      status: statusForAgents(unphased, run.status),
      agents: unphased,
    });
  }

  const knownPhaseIds = new Set<string>();
  for (const phase of run.phases) {
    knownPhaseIds.add(phase.id);
    const phaseAgents = grouped.get(phase.id) ?? [];
    if (!includeEmptyPhases && phaseAgents.length === 0) continue;
    groups.push({
      id: phase.id,
      name: phase.name,
      status: statusForAgents(phaseAgents, phase.status),
      agents: phaseAgents,
    });
  }

  const unknownGroups = new Map<string, FabricUiAgent[]>();
  for (const agent of agents) {
    if (!agent.phaseId || knownPhaseIds.has(agent.phaseId)) continue;
    const entries = unknownGroups.get(agent.phaseId) ?? [];
    entries.push(agent);
    unknownGroups.set(agent.phaseId, entries);
  }
  for (const [id, phaseAgents] of unknownGroups) {
    groups.push({
      id,
      name: id,
      status: statusForAgents(phaseAgents, "running"),
      agents: phaseAgents,
    });
  }

  if (groups.length === 0 && agents.length > 0) {
    groups.push({
      id: UNPHASED_ROW_ID,
      name: "Run activity",
      status: statusForAgents(agents, run.status),
      agents,
    });
  }
  return groups;
};

const flattenGroup = (group: FlowGroup): FabricRunTopologyAgentRow[] => {
  const ordered = orderAgentsByCreation(group.agents);
  const byId = new Map(ordered.map((agent) => [agent.id, agent] as const));
  const children = new Map<string, FabricUiAgent[]>();
  const roots: FabricUiAgent[] = [];

  for (const agent of ordered) {
    const parent = agent.parentId ? byId.get(agent.parentId) : undefined;
    if (!parent || parent.id === agent.id) {
      roots.push(agent);
      continue;
    }
    const entries = children.get(parent.id) ?? [];
    entries.push(agent);
    children.set(parent.id, entries);
  }

  const rows: FabricRunTopologyAgentRow[] = [];
  const visited = new Set<string>();
  const visit = (
    agent: FabricUiAgent,
    ancestorLast: boolean[],
    ancestorEntityIds: string[],
    isLast: boolean,
  ): void => {
    if (visited.has(agent.id)) return;
    visited.add(agent.id);
    rows.push({
      kind: "agent",
      entityId: `agent:${agent.id}`,
      agent,
      ancestorLast,
      ancestorEntityIds,
      isLast,
    });
    const pendingChildren = (children.get(agent.id) ?? []).filter(
      (child) => !visited.has(child.id),
    );
    for (let index = 0; index < pendingChildren.length; index++) {
      const child = pendingChildren[index];
      if (!child) continue;
      visit(
        child,
        [...ancestorLast, isLast],
        [...ancestorEntityIds, `agent:${agent.id}`],
        index === pendingChildren.length - 1,
      );
    }
  };

  for (let index = 0; index < roots.length; index++) {
    const root = roots[index];
    if (root) visit(root, [], [], index === roots.length - 1);
  }

  for (const agent of ordered) {
    if (!visited.has(agent.id)) visit(agent, [], [], true);
  }
  return rows;
};

export const buildRunTopologyRows = (
  run: FabricActivityRun,
  agents: FabricUiAgent[],
  options: { includeEmptyPhases?: boolean } = {},
): FabricRunTopologyRow[] => {
  const rows: FabricRunTopologyRow[] = [];
  for (const group of flowGroups(run, agents, options.includeEmptyPhases ?? true)) {
    rows.push({
      kind: "phase",
      id: group.id,
      name: group.name,
      status: group.status,
      agentCount: group.agents.length,
    });
    rows.push(...flattenGroup(group));
  }
  return rows;
};

const omission = (
  direction: FabricRunTopologyOmissionRow["direction"],
  rows: FabricRunTopologyRow[],
  context?: string[],
): FabricRunTopologyOmissionRow => {
  const agents = rows.filter(
    (row): row is FabricRunTopologyAgentRow => row.kind === "agent",
  );
  return {
    kind: "omission",
    direction,
    rows: rows.length,
    agents: agents.length,
    phases: rows.length - agents.length,
    active: agents.filter(
      ({ agent }) => isActiveStatus(agent.status) && agent.status !== "blocked",
    ).length,
    blocked: agents.filter(({ agent }) => agent.status === "blocked").length,
    failed: agents.filter(({ agent }) => failureStatuses.has(agent.status)).length,
    ...(context && context.length > 0 ? { context } : {}),
  };
};

const structuralContext = (
  rows: FabricRunTopologyRow[],
  selectedIndex: number,
  visibleStart: number,
  visibleEnd: number,
): string[] | undefined => {
  const selected = rows[selectedIndex];
  if (selected?.kind !== "agent") return undefined;
  const visibleEntityIds = new Set(
    rows
      .slice(visibleStart, visibleEnd)
      .flatMap((row) => (row.kind === "agent" ? [row.entityId] : [])),
  );
  const agentNames = new Map(
    rows.flatMap((row) =>
      row.kind === "agent" ? [[row.entityId, row.agent.name] as const] : [],
    ),
  );
  const ancestors = selected.ancestorEntityIds
    .filter((id) => !visibleEntityIds.has(id))
    .flatMap((id) => {
      const name = agentNames.get(id);
      return name ? [name] : [];
    });
  let phase: FabricRunTopologyPhaseRow | undefined;
  let phaseIndex = -1;
  for (let index = selectedIndex; index >= 0; index--) {
    const row = rows[index];
    if (row?.kind !== "phase") continue;
    phase = row;
    phaseIndex = index;
    break;
  }
  const context = [
    phase && (phaseIndex < visibleStart || phaseIndex >= visibleEnd) ? phase.name : undefined,
    ...ancestors.slice(-3),
  ].filter((value): value is string => Boolean(value));
  return context.length > 0 ? context : undefined;
};

export const windowRunTopologyRows = (
  rows: FabricRunTopologyRow[],
  selectedEntityId: string | undefined,
  maxRows: number,
): FabricRunTopologyDisplayRow[] => {
  const limit = Math.max(0, Math.floor(maxRows));
  if (limit === 0 || rows.length === 0) return [];
  if (rows.length <= limit) return rows;

  const selectedIndex = Math.max(
    0,
    rows.findIndex(
      (row) => row.kind === "agent" && row.entityId === selectedEntityId,
    ),
  );
  const selectedRow = rows[selectedIndex] ?? rows[0]!;
  if (limit === 1) return [selectedRow];
  if (limit === 2 && selectedIndex > 0 && selectedIndex < rows.length - 1) {
    const omitted = [...rows.slice(0, selectedIndex), ...rows.slice(selectedIndex + 1)];
    return [
      omission(
        "both",
        omitted,
        structuralContext(rows, selectedIndex, selectedIndex, selectedIndex + 1),
      ),
      selectedRow,
    ];
  }

  let contentSlots = Math.max(1, limit - 2);
  let start = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(contentSlots / 2), rows.length - contentSlots),
  );
  let end = Math.min(rows.length, start + contentSlots);

  for (let iteration = 0; iteration < 4; iteration++) {
    const summaryRows = Number(start > 0) + Number(end < rows.length);
    contentSlots = Math.max(1, limit - summaryRows);
    const nextStart = Math.max(
      0,
      Math.min(selectedIndex - Math.floor(contentSlots / 2), rows.length - contentSlots),
    );
    const nextEnd = Math.min(rows.length, nextStart + contentSlots);
    if (nextStart === start && nextEnd === end) break;
    start = nextStart;
    end = nextEnd;
  }

  const visible: FabricRunTopologyDisplayRow[] = [];
  if (start > 0) {
    visible.push(
      omission(
        "before",
        rows.slice(0, start),
        structuralContext(rows, selectedIndex, start, end),
      ),
    );
  }
  visible.push(...rows.slice(start, end));
  if (end < rows.length) visible.push(omission("after", rows.slice(end)));
  return visible;
};

export interface FabricProjectMeshTopic {
  id: string;
  name: string;
  status: string;
  system: boolean;
  subscribers: Array<{ id: string; name: string; status: string }>;
  recentEvents: number;
  lastEventAt?: number;
}

export interface FabricProjectMeshParticipant {
  id: string;
  entityId: string;
  name: string;
  status: string;
  routes: number;
  lastSeenAt: number;
  agent?: FabricUiAgent;
  participant?: FabricParticipantInfo;
}

export interface FabricProjectMeshRoute {
  id: string;
  fromId: string;
  fromName: string;
  fromKind: string;
  targetId: string;
  targetName: string;
  targetKind: "main" | "actor" | "agent" | "topic";
  topic: string;
  kind: string;
  status: string;
  count: number;
  lastAt: number;
  text?: string;
}

interface FabricProjectMeshRootRow {
  kind: "meshRoot";
  entityId: string;
  main: FabricUiMain;
  actors: number;
  agents: number;
  topics: number;
  state: number;
  routes: number;
}

interface FabricProjectMeshSectionRow {
  kind: "meshSection";
  label: string;
  count: number;
}

interface FabricProjectMeshActorRow {
  kind: "meshActor";
  entityId: string;
  actor: FabricUiActor;
}

interface FabricProjectMeshAgentRow {
  kind: "meshAgent";
  entityId: string;
  participant: FabricProjectMeshParticipant;
  ancestorLast: boolean[];
  isLast: boolean;
}

interface FabricProjectMeshTopicRow {
  kind: "meshTopic";
  entityId: string;
  topic: FabricProjectMeshTopic;
}

interface FabricProjectMeshLinkRow {
  kind: "meshLink";
  relation: "subscribes";
  sourceId: string;
  sourceName: string;
  targetId: string;
  targetName: string;
  status: string;
  isLast: boolean;
}

interface FabricProjectMeshStateRow {
  kind: "meshState";
  entityId: string;
  state: FabricUiStateEntry;
}

interface FabricProjectMeshRouteRow {
  kind: "meshRoute";
  entityId: string;
  route: FabricProjectMeshRoute;
}

interface FabricProjectMeshOmissionRow {
  kind: "meshOmission";
  direction: "before" | "after" | "both";
  rows: number;
  nodes: number;
  main: number;
  actors: number;
  agents: number;
  topics: number;
  state: number;
  routes: number;
  active: number;
  blocked: number;
  failed: number;
}

export type FabricProjectMeshRow =
  | FabricProjectMeshRootRow
  | FabricProjectMeshSectionRow
  | FabricProjectMeshActorRow
  | FabricProjectMeshAgentRow
  | FabricProjectMeshTopicRow
  | FabricProjectMeshLinkRow
  | FabricProjectMeshStateRow
  | FabricProjectMeshRouteRow;

export type FabricProjectMeshDisplayRow = FabricProjectMeshRow | FabricProjectMeshOmissionRow;

export interface FabricProjectMeshModel {
  participants: FabricProjectMeshParticipant[];
  topics: FabricProjectMeshTopic[];
  routes: FabricProjectMeshRoute[];
  rows: FabricProjectMeshRow[];
  entityOrder: string[];
}

const SYSTEM_TOPICS = new Set([
  "fabric.actor.input",
  "fabric.actor.output",
  "fabric.actor.lifecycle",
  "fabric.compact",
  "fabric.steer",
  "fabric.control.command",
  "fabric.control.ack",
]);

const IGNORED_ROUTE_TOPICS = new Set([
  "fabric.actor.lifecycle",
  "fabric.compact",
  "fabric.control.ack",
]);

const eventData = (event: MeshEvent): Record<string, unknown> | undefined =>
  typeof event.data === "object" && event.data !== null && !Array.isArray(event.data)
    ? (event.data as Record<string, unknown>)
    : undefined;

const failureEventKinds = new Set([
  "error",
  "failed",
  "failure",
  "blocked",
  "reject",
  "rejected",
]);

const routeStatus = (kind: string): string =>
  kind
    .toLowerCase()
    .split(/[.:/_-]+/)
    .some((part) => failureEventKinds.has(part))
    ? "failed"
    : "completed";

const projectMeshRoutes = (
  main: FabricUiMain,
  actors: FabricUiActor[],
  agents: FabricUiAgent[],
  events: MeshEvent[],
): FabricProjectMeshRoute[] => {
  const actorByKey = new Map<string, FabricUiActor>();
  for (const actor of actors) {
    actorByKey.set(actor.id, actor);
    actorByKey.set(actor.name, actor);
  }
  const agentByKey = new Map<string, FabricUiAgent>();
  for (const agent of agents) {
    agentByKey.set(agent.id, agent);
    agentByKey.set(agent.name, agent);
  }
  const mainByKey = new Map<string, string>([
    [main.id, main.name],
    [main.name, main.name],
    ["main", main.name],
  ]);
  for (const event of events) {
    if (event.from.kind !== "main") continue;
    mainByKey.set(event.from.id, event.from.name);
    mainByKey.set(event.from.name, event.from.name);
  }
  const routes = new Map<string, FabricProjectMeshRoute>();
  for (const event of events) {
    if (IGNORED_ROUTE_TOPICS.has(event.topic)) continue;
    const data = eventData(event);
    let targetId: string;
    let targetName: string;
    let targetKind: FabricProjectMeshRoute["targetKind"];
    const actorInputId =
      event.topic === "fabric.actor.input" && typeof data?.actorId === "string"
        ? data.actorId
        : undefined;
    const controlTarget =
      event.topic === "fabric.control.command" && typeof data?.targetId === "string"
        ? data.targetId
        : undefined;
    const addressed = controlTarget ?? event.to ?? actorInputId;
    const targetMain = addressed ? mainByKey.get(addressed) : undefined;
    const targetActor = addressed ? actorByKey.get(addressed) : undefined;
    const targetAgent = addressed ? agentByKey.get(addressed) : undefined;
    if (targetMain) {
      targetId = addressed!;
      targetName = targetMain;
      targetKind = "main";
    } else if (targetActor) {
      targetId = targetActor.id;
      targetName = targetActor.name;
      targetKind = "actor";
    } else if (targetAgent) {
      targetId = targetAgent.id;
      targetName = targetAgent.name;
      targetKind = "agent";
    } else if (addressed) {
      targetId = addressed;
      targetName = addressed;
      targetKind = "agent";
    } else if (event.topic === "fabric.actor.output") {
      targetId = main.id;
      targetName = main.name;
      targetKind = "main";
    } else {
      targetId = event.topic;
      targetName = event.topic;
      targetKind = "topic";
    }
    const key = JSON.stringify([
      event.from.id,
      event.from.kind,
      targetKind,
      targetId,
      event.topic,
      event.kind,
    ]);
    const existing = routes.get(key);
    if (existing) {
      existing.count++;
      if (event.createdAt >= existing.lastAt) {
        existing.lastAt = event.createdAt;
        if (event.text) existing.text = event.text;
        else delete existing.text;
      }
      if (routeStatus(event.kind) === "failed") existing.status = "failed";
      continue;
    }
    routes.set(key, {
      id: `route:${createHash("sha256").update(key).digest("hex").slice(0, 20)}`,
      fromId: event.from.id,
      fromName: event.from.name,
      fromKind: event.from.kind,
      targetId,
      targetName,
      targetKind,
      topic: event.topic,
      kind: event.kind,
      status: routeStatus(event.kind),
      count: 1,
      lastAt: event.createdAt,
      ...(event.text ? { text: event.text } : {}),
    });
  }
  return [...routes.values()].sort((left, right) => right.lastAt - left.lastAt);
};

const projectMeshParticipants = (
  agents: FabricUiAgent[],
  routes: FabricProjectMeshRoute[],
  directoryParticipants: FabricParticipantInfo[],
): FabricProjectMeshParticipant[] => {
  const agentByKey = new Map<string, FabricUiAgent>();
  for (const agent of agents) {
    agentByKey.set(agent.id, agent);
    agentByKey.set(agent.name, agent);
  }
  const observed = new Map<
    string,
    { id: string; name: string; lastSeenAt: number; participant?: FabricParticipantInfo }
  >();
  const touch = (
    id: string,
    name: string,
    lastSeenAt: number,
    participant?: FabricParticipantInfo,
  ): void => {
    const existing = observed.get(id);
    if (!existing) {
      observed.set(id, {
        id,
        name,
        lastSeenAt,
        ...(participant ? { participant } : {}),
      });
      return;
    }
    if (lastSeenAt >= existing.lastSeenAt) {
      existing.name = name;
      existing.lastSeenAt = lastSeenAt;
    }
    if (participant) existing.participant = participant;
  };
  for (const participant of directoryParticipants) {
    const name =
      participant.kind === "root" && participant.sessionId
        ? `Peer ${participant.sessionId.slice(0, 8)}`
        : participant.name;
    touch(participant.id, name, participant.updatedAt, participant);
  }
  for (const route of routes) {
    if (route.fromKind === "agent") touch(route.fromId, route.fromName, route.lastAt);
    if (route.targetKind === "agent") touch(route.targetId, route.targetName, route.lastAt);
  }
  return [...observed.values()]
    .map((identity) => {
      const agent = agentByKey.get(identity.id) ?? agentByKey.get(identity.name);
      const routesForParticipant = routes.reduce(
        (count, route) =>
          count +
          ((route.fromKind === "agent" && route.fromId === identity.id) ||
          (route.targetKind === "agent" && route.targetId === identity.id)
            ? route.count
            : 0),
        0,
      );
      return {
        id: identity.id,
        entityId: agent ? `agent:${agent.id}` : `participant:${identity.id}`,
        name: agent?.name ?? identity.name,
        status: agent?.status ?? "idle",
        routes: routesForParticipant,
        lastSeenAt: identity.lastSeenAt,
        ...(agent ? { agent } : {}),
        ...(identity.participant ? { participant: identity.participant } : {}),
      };
    })
    .sort(
      (left, right) =>
        Number(isActiveStatus(right.status)) - Number(isActiveStatus(left.status)) ||
        left.name.localeCompare(right.name),
    );
};

const projectParticipantTree = (
  participants: FabricProjectMeshParticipant[],
): Array<{ participant: FabricProjectMeshParticipant; ancestorLast: boolean[]; isLast: boolean }> => {
  const byId = new Map(participants.map((participant) => [participant.id, participant] as const));
  const children = new Map<string, FabricProjectMeshParticipant[]>();
  const roots: FabricProjectMeshParticipant[] = [];
  for (const participant of participants) {
    const parentId = participant.participant?.parentId ?? participant.agent?.parentId;
    if (!parentId || !byId.has(parentId) || parentId === participant.id) {
      roots.push(participant);
      continue;
    }
    const entries = children.get(parentId) ?? [];
    entries.push(participant);
    children.set(parentId, entries);
  }
  const rows: Array<{
    participant: FabricProjectMeshParticipant;
    ancestorLast: boolean[];
    isLast: boolean;
  }> = [];
  const visited = new Set<string>();
  const visit = (
    participant: FabricProjectMeshParticipant,
    ancestorLast: boolean[],
    isLast: boolean,
  ): void => {
    if (visited.has(participant.id)) return;
    visited.add(participant.id);
    rows.push({ participant, ancestorLast, isLast });
    const descendants = (children.get(participant.id) ?? []).filter(
      (candidate) => !visited.has(candidate.id),
    );
    for (let index = 0; index < descendants.length; index++) {
      const descendant = descendants[index];
      if (descendant) {
        visit(descendant, [...ancestorLast, isLast], index === descendants.length - 1);
      }
    }
  };
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index];
    if (root) visit(root, [], index === roots.length - 1);
  }
  for (const participant of participants) {
    if (!visited.has(participant.id)) visit(participant, [], true);
  }
  return rows;
};

const projectMeshTopics = (
  actors: FabricUiActor[],
  events: MeshEvent[],
  now: number,
): FabricProjectMeshTopic[] => {
  const names = new Set<string>();
  for (const actor of actors) {
    for (const topic of actor.topics) names.add(topic);
  }
  for (const event of events) {
    if (!SYSTEM_TOPICS.has(event.topic)) names.add(event.topic);
  }
  return [...names]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const topicEvents = events.filter((event) => event.topic === name);
      const lastEventAt = topicEvents.reduce(
        (latest, event) => Math.max(latest, event.createdAt),
        0,
      );
      const subscribers = actors
        .filter((actor) => actor.topics.includes(name))
        .map((actor) => ({ id: actor.id, name: actor.name, status: actor.status }));
      return {
        id: `topic:${name}`,
        name,
        status: lastEventAt > 0 && now - lastEventAt <= 10_000 ? "running" : "idle",
        system: SYSTEM_TOPICS.has(name),
        subscribers,
        recentEvents: topicEvents.length,
        ...(lastEventAt > 0 ? { lastEventAt } : {}),
      };
    });
};

export const buildProjectMeshTopology = (input: {
  main: FabricUiMain;
  actors: FabricUiActor[];
  agents: FabricUiAgent[];
  state: FabricUiStateEntry[];
  events: MeshEvent[];
  participants?: FabricParticipantInfo[];
  now: number;
}): FabricProjectMeshModel => {
  const topics = projectMeshTopics(input.actors, input.events, input.now);
  const routes = projectMeshRoutes(input.main, input.actors, input.agents, input.events);
  const localActorIds = new Set(input.actors.map((actor) => actor.id));
  const directoryParticipants = (input.participants ?? []).filter(
    (participant) =>
      participant.id !== input.main.id &&
      !(participant.kind === "actor" && localActorIds.has(participant.id)),
  );
  const participants = projectMeshParticipants(input.agents, routes, directoryParticipants);
  const rows: FabricProjectMeshRow[] = [
    {
      kind: "meshRoot",
      entityId: `main:${input.main.id}`,
      main: input.main,
      actors: input.actors.length,
      agents: participants.length,
      topics: topics.length,
      state: input.state.length,
      routes: routes.length,
    },
  ];
  if (input.actors.length > 0) {
    rows.push({ kind: "meshSection", label: "Persistent actors", count: input.actors.length });
    for (const actor of input.actors) {
      rows.push({ kind: "meshActor", entityId: `actor:${actor.id}`, actor });
    }
  }
  if (participants.length > 0) {
    rows.push({
      kind: "meshSection",
      label: "Project participants",
      count: participants.length,
    });
    for (const entry of projectParticipantTree(participants)) {
      rows.push({
        kind: "meshAgent",
        entityId: entry.participant.entityId,
        participant: entry.participant,
        ancestorLast: entry.ancestorLast,
        isLast: entry.isLast,
      });
    }
  }
  if (topics.length > 0) {
    rows.push({ kind: "meshSection", label: "Topics", count: topics.length });
    for (const topic of topics) {
      rows.push({ kind: "meshTopic", entityId: topic.id, topic });
      for (let index = 0; index < topic.subscribers.length; index++) {
        const subscriber = topic.subscribers[index];
        if (!subscriber) continue;
        rows.push({
          kind: "meshLink",
          relation: "subscribes",
          sourceId: subscriber.id,
          sourceName: subscriber.name,
          targetId: topic.id,
          targetName: topic.name,
          status: subscriber.status,
          isLast: index === topic.subscribers.length - 1,
        });
      }
    }
  }
  if (input.state.length > 0) {
    rows.push({ kind: "meshSection", label: "Shared state", count: input.state.length });
    for (const state of input.state) {
      rows.push({ kind: "meshState", entityId: `state:${state.key}`, state });
    }
  }
  if (routes.length > 0) {
    rows.push({ kind: "meshSection", label: "Recent routes", count: routes.length });
    for (const route of routes) {
      rows.push({ kind: "meshRoute", entityId: route.id, route });
    }
  }
  const entityOrder = rows.flatMap((row) =>
    "entityId" in row ? [row.entityId] : [],
  );
  return { participants, topics, routes, rows, entityOrder };
};

const projectMeshOmission = (
  direction: FabricProjectMeshOmissionRow["direction"],
  rows: FabricProjectMeshRow[],
): FabricProjectMeshOmissionRow => {
  const rootRows = rows.filter((row) => row.kind === "meshRoot");
  const actorRows = rows.filter((row) => row.kind === "meshActor");
  const agentRows = rows.filter((row) => row.kind === "meshAgent");
  const topicRows = rows.filter((row) => row.kind === "meshTopic");
  const stateRows = rows.filter((row) => row.kind === "meshState");
  const routeRows = rows.filter((row) => row.kind === "meshRoute");
  const statuses = [
    ...rootRows.map((row) => row.main.status),
    ...actorRows.map((row) => (row.actor.lastError ? "failed" : row.actor.status)),
    ...agentRows.map((row) => row.participant.status),
    ...topicRows.map((row) => row.topic.status),
    ...stateRows.map((row) => row.state.status),
    ...routeRows.map((row) => row.route.status),
  ];
  return {
    kind: "meshOmission",
    direction,
    rows: rows.length,
    nodes:
      rootRows.length +
      actorRows.length +
      agentRows.length +
      topicRows.length +
      stateRows.length +
      routeRows.length,
    main: rootRows.length,
    actors: actorRows.length,
    agents: agentRows.length,
    topics: topicRows.length,
    state: stateRows.length,
    routes: routeRows.length,
    active: statuses.filter((status) => isActiveStatus(status) && status !== "blocked").length,
    blocked: statuses.filter((status) => status === "blocked").length,
    failed: statuses.filter((status) => failureStatuses.has(status)).length,
  };
};

const projectMeshEntityId = (row: FabricProjectMeshRow): string | undefined =>
  "entityId" in row ? row.entityId : undefined;

export const windowProjectMeshTopology = (
  rows: FabricProjectMeshRow[],
  selectedEntityId: string | undefined,
  maxRows: number,
): FabricProjectMeshDisplayRow[] => {
  const limit = Math.max(0, Math.floor(maxRows));
  if (limit === 0 || rows.length === 0) return [];
  if (rows.length <= limit) return rows;
  const selectable = rows
    .map((row, index) => ({ row, index }))
    .filter((entry) => "entityId" in entry.row);
  const selectedIndex =
    selectable.find((entry) => projectMeshEntityId(entry.row) === selectedEntityId)?.index ??
    selectable[0]?.index ??
    0;
  const selectedRow = rows[selectedIndex] ?? rows[0]!;
  if (limit === 1) return [selectedRow];
  if (limit === 2 && selectedIndex > 0 && selectedIndex < rows.length - 1) {
    return [
      projectMeshOmission(
        "both",
        [...rows.slice(0, selectedIndex), ...rows.slice(selectedIndex + 1)],
      ),
      selectedRow,
    ];
  }
  let contentSlots = Math.max(1, limit - 2);
  let start = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(contentSlots / 2), rows.length - contentSlots),
  );
  let end = Math.min(rows.length, start + contentSlots);
  for (let iteration = 0; iteration < 4; iteration++) {
    const summaryRows = Number(start > 0) + Number(end < rows.length);
    contentSlots = Math.max(1, limit - summaryRows);
    const nextStart = Math.max(
      0,
      Math.min(selectedIndex - Math.floor(contentSlots / 2), rows.length - contentSlots),
    );
    const nextEnd = Math.min(rows.length, nextStart + contentSlots);
    if (nextStart === start && nextEnd === end) break;
    start = nextStart;
    end = nextEnd;
  }
  const visible: FabricProjectMeshDisplayRow[] = [];
  if (start > 0) visible.push(projectMeshOmission("before", rows.slice(0, start)));
  visible.push(...rows.slice(start, end));
  if (end < rows.length) visible.push(projectMeshOmission("after", rows.slice(end)));
  return visible;
};
