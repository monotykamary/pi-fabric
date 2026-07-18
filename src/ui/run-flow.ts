import type { FabricActivityRun } from "../activity/types.js";
import type { FabricUiAgent } from "./types.js";
import { isActiveStatus, orderAgentsByCreation } from "./types.js";

const UNPHASED = Symbol("fabric-run-flow-unphased");
const UNPHASED_ROW_ID = "__fabric_run_flow_unphased";
const failureStatuses = new Set(["failed", "timed_out", "error"]);

interface FabricRunFlowPhaseRow {
  kind: "phase";
  id: string;
  name: string;
  status: string;
  agentCount: number;
}

interface FabricRunFlowAgentRow {
  kind: "agent";
  entityId: string;
  agent: FabricUiAgent;
  ancestorLast: boolean[];
  ancestorEntityIds: string[];
  isLast: boolean;
}

type FabricRunFlowRow = FabricRunFlowPhaseRow | FabricRunFlowAgentRow;

interface FabricRunFlowOmissionRow {
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

type FabricRunFlowDisplayRow = FabricRunFlowRow | FabricRunFlowOmissionRow;

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

const flattenGroup = (group: FlowGroup): FabricRunFlowAgentRow[] => {
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

  const rows: FabricRunFlowAgentRow[] = [];
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

export const buildRunFlowRows = (
  run: FabricActivityRun,
  agents: FabricUiAgent[],
  options: { includeEmptyPhases?: boolean } = {},
): FabricRunFlowRow[] => {
  const rows: FabricRunFlowRow[] = [];
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
  direction: FabricRunFlowOmissionRow["direction"],
  rows: FabricRunFlowRow[],
  context?: string[],
): FabricRunFlowOmissionRow => {
  const agents = rows.filter(
    (row): row is FabricRunFlowAgentRow => row.kind === "agent",
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
  rows: FabricRunFlowRow[],
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
  let phase: FabricRunFlowPhaseRow | undefined;
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

export const windowRunFlowRows = (
  rows: FabricRunFlowRow[],
  selectedEntityId: string | undefined,
  maxRows: number,
): FabricRunFlowDisplayRow[] => {
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

  const visible: FabricRunFlowDisplayRow[] = [];
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
