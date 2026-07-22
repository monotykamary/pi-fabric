import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { FabricActivityRun } from "../activity/types.js";
import type { Entity, StatusFilter } from "./dashboard-model.js";
import { colorStatus, entityTail, statusGlyph } from "./dashboard-presentation.js";
import { formatDuration, padToWidth, safeText } from "./format.js";
import {
  buildProjectMeshTopology,
  buildRunTopologyRows,
  windowProjectMeshTopology,
  windowRunTopologyRows,
  type FabricProjectMeshModel,
} from "./topology.js";
import type { FabricDashboardSnapshot } from "./types.js";
import { isActiveStatus } from "./types.js";

export const renderProjectMeshPanel = ({
  theme,
  filter,
  selectedEntityId,
  snapshot,
  allEntities,
  entities,
  width,
  height,
  model: providedModel,
}: {
  theme: Theme;
  filter: StatusFilter;
  selectedEntityId: string | undefined;
  snapshot: FabricDashboardSnapshot;
  allEntities: Entity[];
  entities: Entity[];
  width: number;
  height: number;
  model?: FabricProjectMeshModel;
}): string[] => {
  const model = providedModel ?? buildProjectMeshTopology({
    main: snapshot.main,
    actors: snapshot.actors,
    agents: snapshot.agents,
    state: snapshot.state,
    events: snapshot.events,
    ...(snapshot.participants ? { participants: snapshot.participants } : {}),
    now: snapshot.now,
  });
  const selectableEntityIds = new Set(entities.map((entity) => entity.id));
  const entityById = new Map(allEntities.map((entity) => [entity.id, entity] as const));
  const active = entities.filter(
    (entity) => isActiveStatus(entity.status) && entity.status !== "blocked",
  ).length;
  const blocked = entities.filter((entity) => entity.status === "blocked").length;
  const failed = entities.filter((entity) =>
    ["failed", "timed_out", "error"].includes(entity.status),
  ).length;
  const stats = [
    `${snapshot.actors.length} actor${snapshot.actors.length === 1 ? "" : "s"}`,
    `${model.participants.length} participant${model.participants.length === 1 ? "" : "s"}`,
    `${model.topics.length} topic${model.topics.length === 1 ? "" : "s"}`,
    `${snapshot.state.length} state`,
    `${model.routes.length} route${model.routes.length === 1 ? "" : "s"}`,
    filter !== "all" ? `${entities.length}/${allEntities.length} ${filter}` : undefined,
    active > 0 ? `${active} active` : undefined,
    blocked > 0 ? `${blocked} blocked` : undefined,
    failed > 0 ? `${failed} failed` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  const lines = [
    truncateToWidth(
      `${theme.fg("accent", "▸ Project mesh")}${stats ? ` · ${theme.fg("dim", stats)}` : ""}`,
      width,
      "",
    ),
  ];
  const available = Math.max(0, height - 1);
  if (available === 0) return lines.slice(0, height);

  const rows: typeof model.rows = [];
  let pendingSection: (typeof model.rows)[number] | undefined;
  for (const row of model.rows) {
    if (row.kind === "meshRoot") {
      rows.push(row);
      continue;
    }
    if (row.kind === "meshSection") {
      pendingSection = row;
      continue;
    }
    const visible =
      row.kind === "meshLink"
        ? selectableEntityIds.has(row.targetId)
        : "entityId" in row && selectableEntityIds.has(row.entityId);
    if (!visible) continue;
    if (pendingSection?.kind === "meshSection") rows.push(pendingSection);
    pendingSection = undefined;
    rows.push(row);
  }

  const visibleRows = windowProjectMeshTopology(rows, selectedEntityId, available);
  for (const row of visibleRows) {
    if (row.kind === "meshOmission") {
      const direction =
        row.direction === "before" ? "↑" : row.direction === "after" ? "↓" : "↕";
      const compact = width < 62;
      const kinds = [
        row.main > 0 ? (compact ? `m:${row.main}` : "Main") : undefined,
        row.actors > 0 ? (compact ? `a:${row.actors}` : `${row.actors} actors`) : undefined,
        row.agents > 0 ? (compact ? `g:${row.agents}` : `${row.agents} agents`) : undefined,
        row.topics > 0 ? (compact ? `t:${row.topics}` : `${row.topics} topics`) : undefined,
        row.state > 0 ? (compact ? `s:${row.state}` : `${row.state} state`) : undefined,
        row.routes > 0 ? (compact ? `r:${row.routes}` : `${row.routes} routes`) : undefined,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" · ");
      const attention = [
        row.active > 0 ? (compact ? `on:${row.active}` : `${row.active} active`) : undefined,
        row.blocked > 0 ? (compact ? `b:${row.blocked}` : `${row.blocked} blocked`) : undefined,
        row.failed > 0 ? (compact ? `f:${row.failed}` : `${row.failed} failed`) : undefined,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" · ");
      const summary = [
        row.nodes > 0 ? `${row.nodes} node${row.nodes === 1 ? "" : "s"} hidden` : `${row.rows} rows hidden`,
        kinds || undefined,
        attention || undefined,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" · ");
      lines.push(
        truncateToWidth(theme.fg("muted", `  ${direction} … ${summary}`), width, ""),
      );
      continue;
    }
    if (row.kind === "meshRoot") {
      const selected = row.entityId === selectedEntityId;
      const prefix = selected ? "› " : "  ";
      const summary = [
        entityById.get(row.entityId)
          ? entityTail(entityById.get(row.entityId)!, snapshot.now)
          : undefined,
        `${row.actors} actors`,
        `${row.agents} participants`,
        `${row.topics} topics`,
        `${row.state} state`,
        `${row.routes} recent routes`,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" · ");
      let line = `${prefix}${colorStatus(
        theme,
        row.main.status,
        statusGlyph(row.main.status),
      )} ${theme.bold("Main")}  ${theme.fg("dim", summary)}`;
      if (selected) line = theme.bg("selectedBg", padToWidth(line, width));
      lines.push(truncateToWidth(line, width, ""));
      continue;
    }
    if (row.kind === "meshSection") {
      lines.push(
        truncateToWidth(
          `  ${theme.fg("borderMuted", "│")} ${theme.bold(row.label)} ${theme.fg("dim", `(${row.count})`)}`,
          width,
          "",
        ),
      );
      continue;
    }
    if (row.kind === "meshLink") {
      const connector = row.isLast ? "└─" : "├─";
      lines.push(
        truncateToWidth(
          `  ${theme.fg("borderMuted", `│  ${connector}`)} ${colorStatus(
            theme,
            row.status,
            statusGlyph(row.status),
          )} ${safeText(row.sourceName)}  ${theme.fg("dim", "subscribes")}`,
          width,
          "",
        ),
      );
      continue;
    }

    const entityId = row.entityId;
    const entity = entityById.get(entityId);
    const selected = entityId === selectedEntityId;
    const prefix = selected ? "› " : "  ";
    let status: string;
    let label: string;
    let tail: string;
    if (row.kind === "meshActor") {
      status = row.actor.lastError ? "failed" : row.actor.status;
      label = row.actor.name;
      tail = [
        row.actor.runner,
        `delivery:${row.actor.delivery}`,
        row.actor.events.length > 0 ? `host:${row.actor.events.join(",")}` : undefined,
        row.actor.topics.length > 0
          ? `${row.actor.topics.length} subscription${row.actor.topics.length === 1 ? "" : "s"}`
          : undefined,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" · ");
    } else if (row.kind === "meshAgent") {
      status = row.participant.status;
      label = row.participant.name;
      tail = entity
        ? entityTail(entity, snapshot.now)
        : `${row.participant.routes} routes · ${formatDuration(
            Math.max(0, snapshot.now - row.participant.lastSeenAt),
          )} ago`;
    } else if (row.kind === "meshTopic") {
      status = row.topic.status;
      label = row.topic.name;
      tail = entity ? entityTail(entity, snapshot.now) : "";
    } else if (row.kind === "meshState") {
      status = row.state.status;
      label = row.state.owner
        ? `${row.state.label} ← ${row.state.owner}`
        : row.state.label;
      tail = [row.state.detail, `v${row.state.version}`]
        .filter((value): value is string => Boolean(value))
        .join(" · ");
    } else {
      status = row.route.status;
      label = `${row.route.fromName} ─${row.route.kind}→ ${row.route.targetName}`;
      tail = [
        row.route.topic,
        row.route.count > 1 ? `×${row.route.count}` : undefined,
        `${formatDuration(Math.max(0, snapshot.now - row.route.lastAt))} ago`,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" · ");
    }
    const connector =
      row.kind === "meshAgent"
        ? `${row.ancestorLast.map((last) => (last ? "  " : "│ ")).join("")}${
            row.isLast ? "└─" : "├─"
          }`
        : "├─";
    const lead = `${prefix}${theme.fg("borderMuted", connector)} ${colorStatus(
      theme,
      status,
      statusGlyph(status),
    )} ${safeText(label)}`;
    let line = tail ? `${lead}  ${theme.fg("dim", safeText(tail))}` : lead;
    if (selected) line = theme.bg("selectedBg", padToWidth(line, width));
    lines.push(truncateToWidth(line, width, ""));
  }

  if (allEntities.length === 0 && lines.length < height) {
    lines.push(theme.fg("dim", "  (no project mesh nodes yet)"));
  } else if (entities.length === 0 && lines.length < height) {
    lines.push(theme.fg("dim", `  (no ${filter} mesh nodes; press f to change filter)`));
  }
  while (lines.length < height) lines.push("");
  return lines.slice(0, height);
};

export const renderRunTopologyPanel = ({
  theme,
  filter,
  selectedEntityId,
  run,
  allEntities,
  entities,
  width,
  height,
  now,
}: {
  theme: Theme;
  filter: StatusFilter;
  selectedEntityId: string | undefined;
  run: FabricActivityRun | undefined;
  allEntities: Entity[];
  entities: Entity[];
  width: number;
  height: number;
  now: number;
}): string[] => {
  const selectableEntityIds = new Set(entities.map((entity) => entity.id));
  const mainEntity = allEntities.find((entity) => entity.kind === "main");
  const allAgents = allEntities.flatMap((entity) =>
    entity.kind === "agent" ? [entity.value] : [],
  );
  const agentById = new Map(allAgents.map((agent) => [agent.id, agent] as const));
  const displayedEntityIds = new Set(selectableEntityIds);
  for (const entity of entities) {
    if (entity.kind !== "agent") continue;
    let parentId = entity.value.parentId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      displayedEntityIds.add(`agent:${parentId}`);
      parentId = agentById.get(parentId)?.parentId;
    }
  }
  const displayEntities = allEntities.filter((entity) => displayedEntityIds.has(entity.id));
  const agents = displayEntities.flatMap((entity) =>
    entity.kind === "agent" ? [entity.value] : [],
  );
  const selectableAgents = entities.flatMap((entity) =>
    entity.kind === "agent" ? [entity.value] : [],
  );
  const selected = entities.find((entity) => entity.id === selectedEntityId);
  const selectedPhase =
    selected?.kind === "agent" && selected.value.phaseId
      ? run?.phases.find((phase) => phase.id === selected.value.phaseId)?.name ??
        selected.value.phaseId
      : undefined;
  const currentPhase = run?.currentPhaseId
    ? run.phases.find((phase) => phase.id === run.currentPhaseId)?.name ?? run.currentPhaseId
    : undefined;
  const active = selectableAgents.filter(
    (agent) => isActiveStatus(agent.status) && agent.status !== "blocked",
  ).length;
  const blocked = selectableAgents.filter((agent) => agent.status === "blocked").length;
  const failed = selectableAgents.filter((agent) =>
    ["failed", "timed_out", "error"].includes(agent.status),
  ).length;
  const stats = [
    `${selectableAgents.length} agent${selectableAgents.length === 1 ? "" : "s"}`,
    currentPhase ? `current ${currentPhase}` : undefined,
    active > 0 ? `${active} active` : undefined,
    blocked > 0 ? `${blocked} blocked` : undefined,
    failed > 0 ? `${failed} failed` : undefined,
    selectedPhase && selectedPhase !== currentPhase ? `focus ${selectedPhase}` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  const lines = [
    truncateToWidth(
      `${theme.fg("accent", "▸ Run topology")}${stats ? ` · ${theme.fg("dim", stats)}` : ""}`,
      width,
      "",
    ),
  ];
  let available = Math.max(0, height - 1);
  if (available === 0) return lines.slice(0, height);
  if (mainEntity?.kind === "main") {
    const selectedMain = mainEntity.id === selectedEntityId;
    const prefix = selectedMain ? "› " : "  ";
    const tail = entityTail(mainEntity, now);
    let line = `${prefix}${colorStatus(
      theme,
      mainEntity.status,
      statusGlyph(mainEntity.status),
    )} ${theme.bold("Main")}${tail ? `  ${theme.fg("dim", safeText(tail))}` : ""}`;
    if (selectedMain) line = theme.bg("selectedBg", padToWidth(line, width));
    lines.push(truncateToWidth(line, width, ""));
    available--;
  }
  if (available === 0) return lines.slice(0, height);
  if (!run) {
    lines.push(theme.fg("dim", "  (no Fabric run selected)"));
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  const rows = buildRunTopologyRows(run, agents, {
    includeEmptyPhases: filter === "all",
  });
  if (rows.length === 0) {
    const label = filter === "all" ? "agents" : `${filter} agents`;
    lines.push(theme.fg("dim", `  (no ${label} linked to this run)`));
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  const entityById = new Map(allEntities.map((entity) => [entity.id, entity] as const));
  const visibleRows = windowRunTopologyRows(rows, selectedEntityId, available);
  for (const row of visibleRows) {
    if (row.kind === "omission") {
      const direction =
        row.direction === "before" ? "↑" : row.direction === "after" ? "↓" : "↕";
      const compact = width < 56;
      const hidden =
        row.agents > 0
          ? compact
            ? `${row.agents} hidden`
            : `${row.agents} agent${row.agents === 1 ? "" : "s"} hidden`
          : compact
            ? `${row.rows} rows hidden`
            : `${row.rows} flow row${row.rows === 1 ? "" : "s"} hidden`;
      const context =
        row.context && row.context.length > 0
          ? `${compact ? "" : "path "}${row.context
              .map((part) => safeText(part))
              .join(" › ")}`
          : undefined;
      const detail = [
        row.active > 0 ? (compact ? `a:${row.active}` : `${row.active} active`) : undefined,
        row.blocked > 0 ? (compact ? `b:${row.blocked}` : `${row.blocked} blocked`) : undefined,
        row.failed > 0 ? (compact ? `f:${row.failed}` : `${row.failed} failed`) : undefined,
        row.phases > 0
          ? compact
            ? `p:${row.phases}`
            : `${row.phases} phase${row.phases === 1 ? "" : "s"}`
          : undefined,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" · ");
      const summary = [hidden, context, detail || undefined]
        .filter((value): value is string => Boolean(value))
        .join(" · ");
      lines.push(
        truncateToWidth(
          theme.fg("muted", `  ${direction} … ${summary}`),
          width,
          "",
        ),
      );
      continue;
    }
    if (row.kind === "phase") {
      const count = `${row.agentCount} agent${row.agentCount === 1 ? "" : "s"}`;
      lines.push(
        truncateToWidth(
          `  ${colorStatus(theme, row.status, statusGlyph(row.status))} ${theme.bold(
            safeText(row.name),
          )}  ${theme.fg("dim", count)}`,
          width,
          "",
        ),
      );
      continue;
    }

    const entity = entityById.get(row.entityId);
    const selectedRow = row.entityId === selectedEntityId;
    const contextRow = !selectableEntityIds.has(row.entityId);
    const prefix = selectedRow ? "› " : "  ";
    const maxIndentLevels = Math.max(0, Math.min(8, Math.floor((width - 24) / 3)));
    const hiddenDepth = Math.max(0, row.ancestorLast.length - maxIndentLevels);
    const visibleAncestors =
      maxIndentLevels > 0 ? row.ancestorLast.slice(-maxIndentLevels) : [];
    const tree =
      (hiddenDepth > 0 ? "… " : "") +
      visibleAncestors.map((isLast) => (isLast ? "   " : "│  ")).join("") +
      (row.isLast ? "└─ " : "├─ ");
    const name = contextRow
      ? theme.fg("muted", safeText(row.agent.name))
      : safeText(row.agent.name);
    const lead = `${prefix}${theme.fg("borderMuted", tree)}${colorStatus(
      theme,
      row.agent.status,
      statusGlyph(row.agent.status),
    )} ${name}`;
    const entitySummary = entity ? safeText(entityTail(entity, now)) : "";
    const tail = [contextRow ? "context" : undefined, entitySummary]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
    let line = tail ? `${lead}  ${theme.fg("dim", tail)}` : lead;
    if (selectedRow) line = theme.bg("selectedBg", padToWidth(line, width));
    lines.push(truncateToWidth(line, width, ""));
  }

  while (lines.length < height) lines.push("");
  return lines.slice(0, height);
};
