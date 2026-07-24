import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FabricActivityRun } from "../activity/types.js";
import type { FabricState } from "../fabric-state.js";
import type { MeshEvent, MeshStateEntry } from "../mesh/store.js";
import type { AgentHandleInfo, AgentRunRecord } from "../agents/types.js";
import { safeText } from "./format.js";
import {
  activeStatuses,
  orderAgentsByCreation,
  type FabricDashboardSnapshot,
  type FabricUiAgent,
  type FabricUiStateEntry,
} from "./types.js";

const MAX_UI_AGENTS = 240;

const boundedUiAgents = (
  local: FabricUiAgent[],
  remote: FabricUiAgent[],
): FabricUiAgent[] => {
  const selected = new Map<string, FabricUiAgent>();
  for (const agent of local) {
    if (activeStatuses.has(agent.status)) selected.set(agent.id, agent);
  }
  const addNewest = (agents: FabricUiAgent[]): void => {
    for (let index = agents.length - 1; index >= 0 && selected.size < MAX_UI_AGENTS; index--) {
      const agent = agents[index];
      if (agent) selected.set(agent.id, agent);
    }
  };
  addNewest(orderAgentsByCreation(local));
  addNewest(orderAgentsByCreation(remote));
  return orderAgentsByCreation([...selected.values()]);
};

const isRunRecord = (
  value: AgentRunRecord | AgentHandleInfo,
): value is AgentRunRecord => "startedAt" in value;

const numberFrom = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const stateEntry = (entry: MeshStateEntry): FabricUiStateEntry => {
  const value =
    typeof entry.value === "object" && entry.value !== null && !Array.isArray(entry.value)
      ? (entry.value as Record<string, unknown>)
      : undefined;
  const label = safeText(
    value?.title ?? value?.label ?? value?.name ?? value?.task ?? entry.key,
  ).slice(0, 160);
  const status = safeText(value?.status ?? value?.state ?? "state").toLowerCase() || "state";
  const owner = safeText(value?.owner ?? value?.claimedBy ?? value?.claimed_by);
  const detail = safeText(
    value?.current ?? value?.activity ?? value?.description ?? value?.summary,
  );
  return {
    key: entry.key,
    label: label || entry.key,
    status,
    value: entry.value,
    version: entry.version,
    updatedAt: entry.updatedAt,
    ...(owner ? { owner } : {}),
    ...(detail ? { detail: detail.slice(0, 500) } : {}),
  };
};

export const createDashboardSnapshot = (
  state: FabricState,
  events: MeshEvent[],
  context?: ExtensionContext,
  activityRuns?: FabricActivityRun[],
): FabricDashboardSnapshot => {
  const runs = activityRuns ?? state.activity.runs();
  const agentRecords =
    typeof state.agents.listForUi === "function"
      ? state.agents.listForUi()
      : state.agents.list();
  const agentLinks: Array<{ runId: string; call: FabricActivityRun["calls"][number] }> = [];
  for (const run of runs) {
    for (const call of run.calls) {
      if (call.entityId) agentLinks.push({ runId: run.id, call });
    }
  }
  agentLinks.sort((left, right) => {
    const leftLaunch = left.call.ref === "agents.spawn" || left.call.ref === "agents.run";
    const rightLaunch = right.call.ref === "agents.spawn" || right.call.ref === "agents.run";
    if (leftLaunch !== rightLaunch) return leftLaunch ? -1 : 1;
    return left.call.startedAt - right.call.startedAt;
  });
  const agentFromRecord = (
    record: AgentRunRecord | AgentHandleInfo,
    nestingDepth: number,
    parentId?: string,
    parent?: FabricUiAgent,
  ): FabricUiAgent => {
    const linked = parentId
      ? undefined
      : agentLinks.find(
          ({ call }) =>
            call.entityId &&
            (record.id.startsWith(call.entityId) || call.entityId.startsWith(record.id)),
        );
    const base: FabricUiAgent = {
      id: record.id,
      name: record.name,
      status: record.status,
      runner: record.runner,
      transport: record.transport,
      cwd: record.cwd,
      ...(!isRunRecord(record) && linked ? { startedAt: linked.call.startedAt } : {}),
      ...(record.model ? { model: record.model } : {}),
      ...(record.thinking ? { thinking: record.thinking } : {}),
      ...(record.attachCommand ? { attachCommand: record.attachCommand } : {}),
      ...(isRunRecord(record) && record.logFile ? { logFile: record.logFile } : {}),
      ...(record.branch ? { branch: record.branch } : {}),
      ...(record.worktree ? { worktree: record.worktree } : {}),
      ...(record.actorId ? { actorId: record.actorId } : {}),
      ...(record.actorName ? { actorName: record.actorName } : {}),
      ...(parentId ? { parentId } : {}),
      ...(nestingDepth > 0 ? { nestingDepth } : {}),
      ...(linked ? { runId: linked.runId } : parent?.runId ? { runId: parent.runId } : {}),
      ...(linked?.call.phaseId
        ? { phaseId: linked.call.phaseId }
        : parent?.phaseId
          ? { phaseId: parent.phaseId }
          : {}),
    };
    if (!isRunRecord(record)) return base;
    return {
      ...base,
      task: record.task,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
      ...(record.currentTool ? { currentTool: record.currentTool } : {}),
      turns: record.turns,
      toolCalls: record.toolCalls,
      usage: { ...record.usage },
      ...(record.text ? { text: record.text } : {}),
      ...(record.value !== undefined ? { value: structuredClone(record.value) } : {}),
      ...(record.error ? { error: record.error } : {}),
    };
  };
  const allAgents: FabricUiAgent[] = [];
  const appendAgent = (
    record: AgentRunRecord | AgentHandleInfo,
    nestingDepth: number,
    parentId?: string,
    parent?: FabricUiAgent,
  ): void => {
    const agent = agentFromRecord(record, nestingDepth, parentId, parent);
    allAgents.push(agent);
    if (!isRunRecord(record)) return;
    for (const nested of record.nestedAgents ?? []) {
      appendAgent(nested, nestingDepth + 1, record.id, agent);
    }
  };
  for (const record of agentRecords) appendAgent(record, 0);

  const participants =
    typeof state.participantInfos === "function"
      ? state.participantInfos({ scope: "project" })
      : [];
  const participantById = new Map(participants.map((participant) => [participant.id, participant]));
  const canonicalDirectoryActive = participants.length > 0;
  const actors = state.actors
    .list()
    .filter(
      (actor) =>
        !canonicalDirectoryActive || participantById.get(actor.id)?.local === true,
    )
    .map((actor) => {
      const worker = allAgents
        .filter((agent) => agent.actorId === actor.id)
        .sort((left, right) => {
          const active =
            Number(activeStatuses.has(right.status)) -
            Number(activeStatuses.has(left.status));
          const recency =
            (numberFrom(right.updatedAt) ?? numberFrom(right.startedAt) ?? 0) -
            (numberFrom(left.updatedAt) ?? numberFrom(left.startedAt) ?? 0);
          return active || recency;
        })[0];
      return {
        ...actor,
        instructions: state.actors.instructions(actor.id),
        recentMessages: state.actors.messages(actor.id, 12),
        ...(worker ? { worker } : {}),
      };
    });
  const localAgents = allAgents
    .filter((agent) => !agent.actorId)
    .map((agent) => {
      const participant = participantById.get(agent.id);
      return participant
        ? {
            ...agent,
            ...(agent.parentId ? {} : participant.parentId ? { parentId: participant.parentId } : {}),
            rootId: participant.rootId,
            ownerHostId: participant.ownerHostId,
            local: participant.local,
            stale: participant.stale,
            participantKind: participant.kind,
            capabilities: [...participant.capabilities],
          }
        : agent;
    });
  const localAgentIds = new Set(localAgents.map((agent) => agent.id));
  const remoteAgents: FabricUiAgent[] = participants
    .filter((participant) => participant.kind === "agent" && !localAgentIds.has(participant.id))
    .map((participant) => ({
      id: participant.id,
      name: participant.name,
      status: participant.status,
      runner: participant.runner,
      transport: participant.transport,
      cwd: participant.cwd ?? "",
      ...(participant.model ? { model: participant.model } : {}),
      ...(participant.thinking ? { thinking: participant.thinking } : {}),
      ...(participant.currentTool ? { currentTool: participant.currentTool } : {}),
      startedAt: participant.startedAt,
      updatedAt: participant.updatedAt,
      ...(participant.finishedAt !== undefined ? { finishedAt: participant.finishedAt } : {}),
      ...(participant.turns !== undefined ? { turns: participant.turns } : {}),
      ...(participant.toolCalls !== undefined ? { toolCalls: participant.toolCalls } : {}),
      ...(participant.usage ? { usage: { ...participant.usage } } : {}),
      ...(participant.parentId ? { parentId: participant.parentId } : {}),
      rootId: participant.rootId,
      ownerHostId: participant.ownerHostId,
      local: participant.local,
      stale: participant.stale,
      participantKind: participant.kind,
      capabilities: [...participant.capabilities],
    }));
  const agents = [...localAgents, ...remoteAgents];
  const visibleAgents = boundedUiAgents(localAgents, remoteAgents);
  const activeRunIds = new Set(
    agents
      .filter((agent) => agent.runId && activeStatuses.has(agent.status))
      .map((agent) => agent.runId as string),
  );
  const orderedRuns = runs
    .map((run, index) => ({ run, index }))
    .sort((left, right) => {
      const leftActive = activeRunIds.has(left.run.id) ? 1 : 0;
      const rightActive = activeRunIds.has(right.run.id) ? 1 : 0;
      return rightActive - leftActive || left.index - right.index;
    })
    .map(({ run }) => run);

  const meshEntries = state.config.mesh.enabled ? state.mesh.list("", 200) : [];
  const stateEntries = meshEntries
    .filter(
      (entry) =>
        !entry.key.startsWith("actors/") &&
        !entry.key.startsWith("sessions/") &&
        !entry.key.startsWith("topology/"),
    )
    .map(stateEntry)
    .sort((left, right) => {
      const leftActive = activeStatuses.has(left.status) ? 1 : 0;
      const rightActive = activeStatuses.has(right.status) ? 1 : 0;
      return rightActive - leftActive || right.updatedAt - left.updatedAt;
    })
    .slice(0, 120);

  return {
    now: Date.now(),
    runs: orderedRuns,
    main: state.mainAgentInfo(context),
    peers: typeof state.peerInfos === "function" ? state.peerInfos() : [],
    participants,
    widgetDismissedAt: state.widgetDismissedAt,
    globalActors: state.globalActors.list(),
    agents: visibleAgents,
    actors: actors.sort((left, right) => {
      const leftActive = activeStatuses.has(left.status) ? 1 : 0;
      const rightActive = activeStatuses.has(right.status) ? 1 : 0;
      return rightActive - leftActive || right.updatedAt - left.updatedAt;
    }),
    state: stateEntries,
    events: events.map((event) => structuredClone(event)),
  };
};
