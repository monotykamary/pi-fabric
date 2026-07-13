import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { FabricUiWidgetMode } from "../config.js";
import type { FabricActivityRun, FabricActivityStatus } from "../activity/types.js";
import { formatDuration, formatTokens, safeText } from "./format.js";
import {
  isActiveStatus,
  type FabricDashboardSnapshot,
  type FabricUiActor,
  type FabricUiAgent,
} from "./types.js";

const spinnerFrames = ["◐", "◓", "◑", "◒"];

const statusGlyph = (status: string): string => {
  if (status === "completed" || status === "done") return "✓";
  if (status === "failed" || status === "timed_out") return "✗";
  if (status === "blocked") return "!";
  if (status === "stopped" || status === "cancelled") return "■";
  if (status === "queued" || status === "pending" || status === "ready") return "○";
  if (status === "idle" || status === "state") return "·";
  return spinnerFrames[Math.floor(Date.now() / 250) % spinnerFrames.length] ?? "●";
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

const agentLine = (theme: Theme, agent: FabricUiAgent, now: number): string => {
  const status = colorStatus(theme, agent.status, statusGlyph(agent.status));
  const activity = agent.currentTool ?? (agent.status === "running" ? "thinking" : agent.status);
  const metrics = [
    agent.toolCalls !== undefined ? `${agent.toolCalls} calls` : undefined,
    agent.usage ? `${formatTokens(agent.usage.input + agent.usage.output)} tok` : undefined,
    agent.startedAt
      ? formatDuration((agent.finishedAt ?? now) - agent.startedAt)
      : undefined,
  ].filter((value): value is string => Boolean(value));
  const indent = agent.parentId ? "    " : "  ";
  return `${indent}${status} ${safeText(agent.name)}  ${theme.fg("muted", safeText(activity))}${
    metrics.length > 0 ? theme.fg("dim", ` · ${metrics.join(" · ")}`) : ""
  }`;
};

const actorStream = (actor: FabricUiActor): string => {
  const last = actor.recentMessages[actor.recentMessages.length - 1];
  if (!last) return "";
  if (last.direction === "out") {
    if (last.error) return `← ✗ ${truncateToWidth(safeText(last.error), 48)}`;
    if (last.text) return `← ${truncateToWidth(safeText(last.text), 48)}`;
    if (last.action) return `← ${last.action}`;
    return "";
  }
  return `→ ${last.source}`;
};

const actorLine = (theme: Theme, actor: FabricUiActor): string => {
  const effectiveStatus = actor.lastError ? "failed" : actor.status;
  const status = colorStatus(theme, effectiveStatus, statusGlyph(effectiveStatus));
  const workerActivity = actor.worker?.currentTool;
  const activity = workerActivity ?? actor.status;
  const queue = actor.queued > 0 ? ` · q:${actor.queued}` : "";
  const messages = actor.messages > 0 ? ` · ${actor.messages} msg` : "";
  const usage = actor.worker?.usage
    ? ` · ${formatTokens(actor.worker.usage.input + actor.worker.usage.output)} tok`
    : "";
  const stream = actorStream(actor);
  return `  ${status} ${safeText(actor.name)}  ${theme.fg("muted", safeText(activity))}${stream ? theme.fg("muted", ` · ${stream}`) : ""}${theme.fg(
    "dim",
    `${queue}${messages}${usage}`,
  )}`;
};

export const shouldShowFabricWidget = (
  snapshot: FabricDashboardSnapshot,
  mode: FabricUiWidgetMode,
): boolean => {
  if (mode === "hidden") return false;
  if (mode === "always") return true;
  if (snapshot.agents.some((agent) => isActiveStatus(agent.status))) return true;
  if (snapshot.actors.some((actor) => actor.status !== "stopped")) return true;
  if (snapshot.state.some((entry) => isActiveStatus(entry.status))) return true;
  const run = snapshot.runs[0];
  if (!run) return false;
  if (run.status === "running") return true;
  const finishedAt = run.finishedAt ?? run.updatedAt;
  return finishedAt >= (snapshot.widgetDismissedAt ?? 0);
};

export class FabricWidget implements Component {
  constructor(
    readonly theme: Theme,
    readonly snapshot: () => FabricDashboardSnapshot,
    readonly maxRows: number,
  ) {}

  #lastWidth: number | undefined;
  #lastLines: string[] | undefined;
  #reservedRunId: string | undefined;
  #reservedRows = 0;

  render(width: number): string[] {
    if (width <= 0) return [];
    const { runId, lines: content } = this.#buildContent(width);
    if (runId !== this.#reservedRunId) {
      this.#reservedRunId = runId;
      this.#reservedRows = 0;
    }
    this.#reservedRows = Math.max(this.#reservedRows, Math.min(content.length, this.maxRows));
    const lines = this.#applyReserve(runId, content, width);
    this.#lastWidth = width;
    this.#lastLines = lines;
    return lines;
  }

  hasChanged(): boolean {
    if (this.#lastWidth === undefined || this.#lastLines === undefined) return true;
    const { runId, lines: content } = this.#buildContent(this.#lastWidth);
    const lines = this.#applyReserve(runId, content, this.#lastWidth);
    return JSON.stringify(lines) !== JSON.stringify(this.#lastLines);
  }

  invalidate(): void {}

  #buildContent(width: number): { runId: string | undefined; lines: string[] } {
    const snapshot = this.snapshot();
    const candidateRun = snapshot.runs[0];
    const candidateFinishedAt = candidateRun?.finishedAt ?? candidateRun?.updatedAt ?? 0;
    const run =
      candidateRun &&
      (candidateRun.status === "running" ||
        candidateFinishedAt >= (snapshot.widgetDismissedAt ?? 0))
        ? candidateRun
        : undefined;
    const activeAgents = snapshot.agents.filter((agent) => isActiveStatus(agent.status));
    const visibleActors = snapshot.actors.filter((actor) => actor.status !== "stopped");
    const activeState = snapshot.state.filter((entry) => isActiveStatus(entry.status));
    const nestedCalls =
      run?.calls.filter((call) => call.kind !== "agent" && call.kind !== "actor") ?? [];
    const runningItems = run?.items.filter((item) => isActiveStatus(item.status)) ?? [];
    const title = run?.name ?? "Fabric session";
    const headerStatus = run?.status ?? (activeAgents.length > 0 ? "running" : "idle");
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
    if (run) parts.push(formatDuration((run.finishedAt ?? snapshot.now) - run.startedAt));

    const glyph = colorStatus(this.theme, headerStatus, statusGlyph(headerStatus));
    const header = `${glyph} ${this.theme.fg("accent", "Fabric")} ${this.theme.fg(
      "text",
      safeText(title),
    )}${parts.length > 0 ? this.theme.fg("dim", ` · ${parts.join(" · ")}`) : ""}`;
    const lines = [header];

    for (const agent of activeAgents) lines.push(agentLine(this.theme, agent, snapshot.now));
    for (const actor of visibleActors) lines.push(actorLine(this.theme, actor));
    for (const item of runningItems) {
      const current = item.current ?? item.detail;
      const progress =
        item.total !== undefined
          ? ` · ${item.completed ?? 0}/${item.total}`
          : current
            ? ` · ${safeText(current)}`
            : "";
      lines.push(
        `  ${colorStatus(this.theme, item.status, statusGlyph(item.status))} ${safeText(
          item.label,
        )}${this.theme.fg("dim", progress)}`,
      );
    }
    for (const entry of activeState) {
      lines.push(
        `  ${colorStatus(this.theme, entry.status, statusGlyph(entry.status))} ${safeText(
          entry.label,
        )}${this.theme.fg("dim", ` · ${entry.owner ?? entry.status}`)}`,
      );
    }
    return { runId: run?.id, lines };
  }

  #applyReserve(runId: string | undefined, content: string[], width: number): string[] {
    const baseReserved = runId === this.#reservedRunId ? this.#reservedRows : 0;
    const peak = Math.max(baseReserved, Math.min(content.length, this.maxRows));
    const lines = [...content];
    while (lines.length < peak) lines.push("");
    const bounded = lines.slice(0, Math.max(1, this.maxRows));
    if (lines.length > bounded.length && bounded.length > 0) {
      bounded[bounded.length - 1] = `${bounded[bounded.length - 1]} ${this.theme.fg(
        "dim",
        `+${lines.length - bounded.length}`,
      )}`;
    }
    return bounded.map((line) => truncateToWidth(line, width));
  }
}
