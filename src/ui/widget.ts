import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { FabricUiWidgetMode } from "../config.js";
import { spinnerFrame } from "./spinner.js";
import { FABRIC_CONVERSATION_HINT } from "./conversation-shortcut.js";
import type {
  FabricActivityRun,
  FabricActivityStatus,
} from "../activity/types.js";
import { formatCost, formatDuration, formatTokens, safeText } from "./format.js";
import {
  isActiveStatus,
  orderAgentsByCreation,
  type FabricDashboardSnapshot,
  type FabricUiAgent,
} from "./types.js";

const statusGlyph = (status: string): string => {
  if (status === "completed" || status === "done") return "✓";
  if (status === "failed" || status === "timed_out") return "✗";
  if (status === "blocked") return "!";
  if (status === "stopped" || status === "cancelled") return "■";
  if (status === "queued" || status === "pending" || status === "ready") return "○";
  if (status === "idle" || status === "state") return "·";
  return spinnerFrame();
};

const colorStatus = (theme: Theme, status: string, value: string): string => {
  if (status === "completed" || status === "done") return theme.fg("success", value);
  if (status === "failed" || status === "timed_out") return theme.fg("error", value);
  if (status === "blocked") return theme.fg("warning", value);
  if (status === "running" || status === "in_progress") return theme.fg("accent", value);
  return theme.fg("dim", value);
};

const phaseProgress = (
  run: FabricActivityRun,
  phaseId: string,
): { completed: number; total: number } => {
  const phase = run.phases.find((candidate) => candidate.id === phaseId);
  const statuses: FabricActivityStatus[] = [
    ...run.calls.filter((call) => call.phaseId === phaseId).map((call) => call.status),
    ...run.items.filter((item) => item.phaseId === phaseId).map((item) => item.status),
  ];
  const completed = statuses.filter((status) => status === "completed").length;
  return { completed, total: Math.max(phase?.total ?? 0, statuses.length) };
};

const totalTokens = (
  snapshot: FabricDashboardSnapshot,
  run: FabricActivityRun | undefined,
): number =>
  snapshot.agents
    .filter((agent) => (run ? agent.runId === run.id : isActiveStatus(agent.status)))
    .reduce(
      (sum, agent) => sum + (agent.usage ? agent.usage.input + agent.usage.output : 0),
      0,
    );

const totalCost = (
  snapshot: FabricDashboardSnapshot,
  run: FabricActivityRun | undefined,
): number =>
  snapshot.agents
    .filter((agent) => (run ? agent.runId === run.id : isActiveStatus(agent.status)))
    .reduce((sum, agent) => sum + (agent.usage?.cost ?? 0), 0);

const agentLines = (
  theme: Theme,
  agent: FabricUiAgent,
  now: number,
): string[] => {
  const status = colorStatus(theme, agent.status, statusGlyph(agent.status));
  const activity =
    agent.currentTool ??
    (agent.error
      ? `error: ${truncateToWidth(safeText(agent.error), 48)}`
      : agent.text && !isActiveStatus(agent.status)
        ? `result: ${truncateToWidth(safeText(agent.text), 48)}`
        : agent.status === "running"
          ? "thinking"
          : agent.status);
  const metrics = [
    agent.toolCalls !== undefined ? `${agent.toolCalls} calls` : undefined,
    agent.usage ? `${formatTokens(agent.usage.input + agent.usage.output)} tok` : undefined,
    agent.startedAt
      ? formatDuration((agent.finishedAt ?? now) - agent.startedAt)
      : undefined,
  ].filter((value): value is string => Boolean(value));
  const indent = "  ".repeat(1 + Math.max(0, agent.nestingDepth ?? 0));
  return [
    `${indent}${status} ${theme.fg("muted", safeText(agent.name))}  ${theme.fg("muted", safeText(activity))}${
      metrics.length > 0 ? theme.fg("dim", ` · ${metrics.join(" · ")}`) : ""
    }`,
  ];
};

export const shouldShowFabricWidget = (
  snapshot: FabricDashboardSnapshot,
  mode: FabricUiWidgetMode,
): boolean => {
  if (mode === "hidden") return false;
  if (mode === "always") return true;
  if (snapshot.agents.some((agent) => isActiveStatus(agent.status))) return true;
  if (snapshot.actors.some((actor) => actor.status !== "stopped")) return true;
  const run = snapshot.runs[0];
  if (!run) return false;
  if (run.status === "running") return true;
  const finishedAt = run.finishedAt ?? run.updatedAt;
  return finishedAt > (snapshot.widgetDismissedAt ?? 0);
};

export class FabricWidget implements Component {
  constructor(
    readonly theme: Theme,
    readonly snapshot: () => FabricDashboardSnapshot,
    readonly maxRows: number,
  ) {}

  #lastWidth: number | undefined;
  #lastSnapshot: FabricDashboardSnapshot | undefined;
  #lastLines: string[] | undefined;
  #pending:
    | { width: number; snapshot: FabricDashboardSnapshot; lines: string[] }
    | undefined;

  render(width: number): string[] {
    if (width <= 0) return [];
    const snapshot = this.snapshot();
    const lines =
      this.#pending?.width === width && this.#pending.snapshot === snapshot
        ? this.#pending.lines
        : this.#lastWidth === width &&
            this.#lastSnapshot === snapshot &&
            this.#lastLines
          ? this.#lastLines
          : this.#renderLines(snapshot, width);
    this.#pending = undefined;
    this.#lastWidth = width;
    this.#lastSnapshot = snapshot;
    this.#lastLines = lines;
    return lines;
  }

  hasChanged(): boolean {
    if (this.#lastWidth === undefined || this.#lastLines === undefined) return true;
    const snapshot = this.snapshot();
    const lines = this.#renderLines(snapshot, this.#lastWidth);
    this.#pending = { width: this.#lastWidth, snapshot, lines };
    return (
      lines.length !== this.#lastLines.length ||
      lines.some((line, index) => line !== this.#lastLines?.[index])
    );
  }

  invalidate(): void {
    this.#pending = undefined;
    this.#lastWidth = undefined;
    this.#lastSnapshot = undefined;
    this.#lastLines = undefined;
  }

  #renderLines(snapshot: FabricDashboardSnapshot, width: number): string[] {
    return this.#boundContent(this.#buildContent(snapshot), width);
  }

  #buildContent(snapshot: FabricDashboardSnapshot): string[] {
    const candidateRun = snapshot.runs[0];
    const candidateFinishedAt = candidateRun?.finishedAt ?? candidateRun?.updatedAt ?? 0;
    const run =
      candidateRun &&
      (candidateRun.status === "running" ||
        candidateFinishedAt > (snapshot.widgetDismissedAt ?? 0))
        ? candidateRun
        : undefined;
    const orderedAgents = orderAgentsByCreation(snapshot.agents);
    const activeAgents = orderedAgents.filter((agent) => isActiveStatus(agent.status));
    const activeAgentIds = new Set(activeAgents.map((agent) => agent.id));
    const terminalAgents = run
      ? orderedAgents.filter(
          (agent) =>
            agent.runId === run.id &&
            !activeAgentIds.has(agent.id) &&
            !isActiveStatus(agent.status),
        )
      : [];
    const visibleActors = snapshot.actors.filter((actor) => actor.status !== "stopped");
    const activeActorWorkers = visibleActors
      .filter((actor) => actor.worker && isActiveStatus(actor.worker.status))
      .map((actor) => ({ ...actor.worker!, name: actor.name }));
    const terminalActorWorkers = visibleActors
      .filter((actor) => actor.worker && !isActiveStatus(actor.worker.status))
      .map((actor) => ({ ...actor.worker!, name: actor.name }));
    const nestedCalls =
      run?.calls.filter((call) => call.kind !== "agent" && call.kind !== "actor") ?? [];
    const title = run?.name ?? "Fabric session";
    const headerStatus =
      run?.status ??
      (activeAgents.length > 0 || activeActorWorkers.length > 0 ? "running" : "idle");
    const parts: string[] = [];

    const callTotal = nestedCalls.length;
    if (callTotal > 1) {
      const callDone = nestedCalls.filter(
        (call) => call.status === "completed" || call.status === "failed",
      ).length;
      parts.push(`${callDone}/${callTotal} calls`);
    }
    if (run?.currentPhaseId) {
      const phaseIndex = run.phases.findIndex((phase) => phase.id === run.currentPhaseId);
      const phase = run.phases[phaseIndex];
      if (phase) {
        const progress = phaseProgress(run, phase.id);
        parts.push(
          `${phaseIndex + 1}/${run.phases.length} ${safeText(phase.name)}${
            progress.total > 0 ? ` ${progress.completed}/${progress.total}` : ""
          }`,
        );
      }
    }
    if (activeAgents.length > 0) parts.push(`${activeAgents.length} running`);
    if (visibleActors.length > 0) parts.push(`${visibleActors.length} actor${visibleActors.length === 1 ? "" : "s"}`);
    const tokens = totalTokens(snapshot, run);
    if (tokens > 0) parts.push(`${formatTokens(tokens)} tok`);
    const cost = totalCost(snapshot, run);
    if (cost > 0) parts.push(formatCost(cost));
    if (run) parts.push(formatDuration((run.finishedAt ?? snapshot.now) - run.startedAt));

    const glyph = colorStatus(this.theme, headerStatus, statusGlyph(headerStatus));
    const header = `${glyph} ${this.theme.fg("accent", "Fabric")} ${this.theme.fg(
      "muted",
      safeText(title),
    )}${parts.length > 0 ? this.theme.fg("dim", ` · ${parts.join(" · ")}`) : ""}`;
    const hasActiveConversations = activeAgents.some((agent) => !agent.stale) ||
      activeActorWorkers.length > 0 || visibleActors.some((actor) => isActiveStatus(actor.status));
    const lines = [hasActiveConversations ? `${header} · ${this.theme.fg("dim", FABRIC_CONVERSATION_HINT)}` : header];

    lines.push(
      ...activeAgents.flatMap((agent) => agentLines(this.theme, agent, snapshot.now)),
      ...activeActorWorkers.flatMap((agent) =>
        agentLines(this.theme, agent, snapshot.now),
      ),
      ...terminalActorWorkers.flatMap((agent) =>
        agentLines(this.theme, agent, snapshot.now),
      ),
      ...terminalAgents.flatMap((agent) => agentLines(this.theme, agent, snapshot.now)),
    );
    return lines;
  }

  #boundContent(content: string[], width: number): string[] {
    const bounded = content.slice(0, Math.max(1, this.maxRows));
    if (content.length > bounded.length && bounded.length > 0) {
      const marker = this.theme.fg("dim", `+${content.length - bounded.length}`);
      const available = Math.max(0, width - visibleWidth(marker) - 1);
      const last = truncateToWidth(bounded[bounded.length - 1] ?? "", available, "");
      bounded[bounded.length - 1] = `${last} ${marker}`;
    }
    return bounded.map((line) => truncateToWidth(line, width));
  }
}
