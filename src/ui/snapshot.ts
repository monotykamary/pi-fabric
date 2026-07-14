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
  const agentFromRecord = (
    record: SubagentRunRecord | SubagentHandleInfo,
    parentId?: string,
  ): FabricUiAgent => {
    const linked = parentId
      ? undefined
      : runs
          .flatMap((run) => run.calls.map((call) => ({ runId: run.id, call })))
          .find(
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
      ...(linked ? { runId: linked.runId } : {}),
      ...(linked?.call.phaseId ? { phaseId: linked.call.phaseId } : {}),
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
    allAgents.push(agentFromRecord(record));
    if (isRunRecord(record) && record.nestedAgents) {
      for (const nested of record.nestedAgents) {
        allAgents.push(agentFromRecord(nested, record.id));
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
    runs,
    widgetDismissedAt: state.widgetDismissedAt,
    globalActors: state.globalActors.list(),
    agents: agents.sort((left, right) => {
      const leftActive = activeStatuses.has(left.status) ? 1 : 0;
      const rightActive = activeStatuses.has(right.status) ? 1 : 0;
      if (rightActive !== leftActive) return rightActive - leftActive;
      if (right.parentId === left.id) return -1;
      if (left.parentId === right.id) return 1;
      return (
        (numberFrom(right.updatedAt) ?? numberFrom(right.startedAt) ?? 0) -
          (numberFrom(left.updatedAt) ?? numberFrom(left.startedAt) ?? 0)
      );
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
