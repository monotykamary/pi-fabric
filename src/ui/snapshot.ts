import type { FabricState } from "../fabric-state.js";
import type { MeshEvent, MeshStateEntry } from "../mesh/store.js";
import type { SubagentHandleInfo, SubagentRunRecord } from "../subagents/types.js";
import { safeText } from "./format.js";
import {
  activeStatuses,
  type FabricDashboardSnapshot,
  type FabricUiAgent,
  type FabricUiStateEntry,
} from "./types.js";

const isRunRecord = (
  value: SubagentRunRecord | SubagentHandleInfo,
): value is SubagentRunRecord => "startedAt" in value;

const numberFrom = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const agentStatusPriority = (status: string): number => {
  if (status === "blocked") return 0;
  if (activeStatuses.has(status)) return 1;
  if (status === "failed" || status === "timed_out") return 2;
  if (status === "completed" || status === "done") return 3;
  if (status === "stopped" || status === "cancelled") return 4;
  return 5;
};

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
): FabricDashboardSnapshot => {
  const runs = state.activity.runs();
  const agentRecords = state.subagents.list();
  const agentLinks = runs
    .flatMap((run) => run.calls.map((call) => ({ runId: run.id, call })))
    .sort((left, right) => {
      const leftLaunch = left.call.ref === "agents.spawn" || left.call.ref === "agents.run";
      const rightLaunch = right.call.ref === "agents.spawn" || right.call.ref === "agents.run";
      if (leftLaunch !== rightLaunch) return leftLaunch ? -1 : 1;
      return left.call.startedAt - right.call.startedAt;
    });
  const agentFromRecord = (
    record: SubagentRunRecord | SubagentHandleInfo,
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
      transport: record.transport,
      cwd: record.cwd,
      ...(record.model ? { model: record.model } : {}),
      ...(record.thinking ? { thinking: record.thinking } : {}),
      ...(record.attachCommand ? { attachCommand: record.attachCommand } : {}),
      ...(record.branch ? { branch: record.branch } : {}),
      ...(record.worktree ? { worktree: record.worktree } : {}),
      ...(record.actorId ? { actorId: record.actorId } : {}),
      ...(record.actorName ? { actorName: record.actorName } : {}),
      ...(parentId ? { parentId } : {}),
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
      ...(record.error ? { error: record.error } : {}),
    };
  };
  const allAgents: FabricUiAgent[] = [];
  for (const record of agentRecords) {
    const parent = agentFromRecord(record);
    allAgents.push(parent);
    if (isRunRecord(record) && record.nestedAgents) {
      for (const nested of record.nestedAgents) {
        allAgents.push(agentFromRecord(nested, record.id, parent));
      }
    }
  }

  const actors = state.actors.list().map((actor) => {
    const worker = allAgents.find((agent) => agent.actorId === actor.id);
    return {
      ...actor,
      instructions: state.actors.instructions(actor.id),
      recentMessages: state.actors.messages(actor.id, 12),
      ...(worker ? { worker } : {}),
    };
  });
  const agents = allAgents.filter((agent) => !agent.actorId);
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
    .filter((entry) => !entry.key.startsWith("actors/"))
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
    widgetDismissedAt: state.widgetDismissedAt,
    globalActors: state.globalActors.list(),
    agents: agents.sort((left, right) => {
      if (right.parentId === left.id) return -1;
      if (left.parentId === right.id) return 1;
      const priority = agentStatusPriority(left.status) - agentStatusPriority(right.status);
      if (priority !== 0) return priority;
      const recency =
        (numberFrom(right.updatedAt) ?? numberFrom(right.startedAt) ?? 0) -
        (numberFrom(left.updatedAt) ?? numberFrom(left.startedAt) ?? 0);
      return recency || left.id.localeCompare(right.id);
    }),
    actors: actors.sort((left, right) => {
      const leftActive = activeStatuses.has(left.status) ? 1 : 0;
      const rightActive = activeStatuses.has(right.status) ? 1 : 0;
      return rightActive - leftActive || right.updatedAt - left.updatedAt;
    }),
    state: stateEntries,
    events: events.map((event) => structuredClone(event)),
  };
};
