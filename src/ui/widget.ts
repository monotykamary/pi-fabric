import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
  return `  ${status} ${safeText(agent.name)}  ${theme.fg("muted", safeText(activity))}${
    metrics.length > 0 ? theme.fg("dim", ` · ${metrics.join(" · ")}`) : ""
  }`;
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
  return `  ${status} ${safeText(actor.name)}  ${theme.fg("muted", safeText(activity))}${theme.fg(
    "dim",
    `${queue}${messages}${usage}`,
  )}`;
};

export const shouldShowFabricWidget = (
  snapshot: FabricDashboardSnapshot,
  mode: FabricUiWidgetMode,
  lingerMs: number,
): boolean => {
  if (mode === "hidden") return false;
  if (mode === "always") return true;
  if (snapshot.agents.some((agent) => isActiveStatus(agent.status))) return true;
  if (snapshot.actors.some((actor) => actor.status !== "stopped")) return true;
  if (snapshot.state.some((entry) => isActiveStatus(entry.status))) return true;
  const run = snapshot.runs[0];
  return Boolean(
    run &&
      (run.status === "running" || snapshot.now - (run.finishedAt ?? run.updatedAt) <= lingerMs),
  );
};

export class FabricWidget implements Component {
  #reservedCallRows = 0;
  #reservedRunId: string | undefined;

  constructor(
    readonly theme: Theme,
    readonly snapshot: () => FabricDashboardSnapshot,
    readonly maxRows: number,
    readonly lingerMs: number,
  ) {}

  render(width: number): string[] {
    if (width <= 0) return [];
    const snapshot = this.snapshot();
    const candidateRun = snapshot.runs[0];
    const run =
      candidateRun &&
      (candidateRun.status === "running" ||
        snapshot.now - (candidateRun.finishedAt ?? candidateRun.updatedAt) <= this.lingerMs)
        ? candidateRun
        : undefined;
    const activeAgents = snapshot.agents.filter((agent) => isActiveStatus(agent.status));
    const activeActors = snapshot.actors.filter((actor) => isActiveStatus(actor.status));
    const activeState = snapshot.state.filter((entry) => isActiveStatus(entry.status));
    const nestedCalls =
      run?.calls.filter((call) => call.kind !== "agent" && call.kind !== "actor") ?? [];
    const runningCalls = nestedCalls.filter((call) => call.status === "running");
    const runningItems = run?.items.filter((item) => isActiveStatus(item.status)) ?? [];
    const title = run?.name ?? "Fabric session";
    const headerStatus = run?.status ?? (activeAgents.length > 0 ? "running" : "idle");
    const parts: string[] = [];

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
    if (snapshot.actors.length > 0) parts.push(`${snapshot.actors.length} actor${snapshot.actors.length === 1 ? "" : "s"}`);
    const tokens = totalTokens(snapshot, run);
    if (tokens > 0) parts.push(`${formatTokens(tokens)} tok`);
    if (run) parts.push(formatDuration((run.finishedAt ?? snapshot.now) - run.startedAt));

    const glyph = colorStatus(this.theme, headerStatus, statusGlyph(headerStatus));
    const leftHeader = `${glyph} ${this.theme.fg("accent", "Fabric")} ${this.theme.fg(
      "text",
      safeText(title),
    )}${parts.length > 0 ? this.theme.fg("dim", ` · ${parts.join(" · ")}`) : ""}`;
    const callTotal = nestedCalls.length;
    let header = leftHeader;
    if (callTotal > 0) {
      const callDone = nestedCalls.filter(
        (call) => call.status === "completed" || call.status === "failed",
      ).length;
      const count = `${callDone}/${callTotal}`;
      const room = width - visibleWidth(leftHeader) - visibleWidth(count);
      if (room >= 6) {
        const leaderLen = room - 2;
        const filled = Math.max(
          0,
          Math.min(leaderLen, Math.round((callDone / callTotal) * leaderLen)),
        );
        const leader =
          colorStatus(this.theme, headerStatus, "·").repeat(filled) +
          this.theme.fg("dim", "·").repeat(leaderLen - filled);
        header = `${leftHeader} ${leader} ${this.theme.fg("dim", count)}`;
      } else if (room >= 2) {
        header = `${leftHeader}${this.theme.fg("dim", "·".repeat(room - 1))} ${this.theme.fg("dim", count)}`;
      } else {
        header = `${leftHeader} ${this.theme.fg("dim", count)}`;
      }
    }
    const lines = [truncateToWidth(header, width)];

    for (const agent of activeAgents) lines.push(agentLine(this.theme, agent, snapshot.now));
    for (const actor of activeActors) lines.push(actorLine(this.theme, actor));
    // Stabilize the widget height across a run: remember the peak number of
    // nested-call lines shown and keep recently-finished calls visible to
    // fill back up to it. Without this, a call completing drops its line
    // instantly and the editor/input placed below the widget jumps. Running
    // calls are always shown first; the most recently finished calls fill the
    // remaining reserved slots. The reserve resets when the run changes.
    const runId = run?.id;
    if (runId !== this.#reservedRunId) {
      this.#reservedRunId = runId;
      this.#reservedCallRows = 0;
    }
    this.#reservedCallRows = Math.max(
      this.#reservedCallRows,
      Math.min(runningCalls.length, this.maxRows),
    );
    const finishedCalls = nestedCalls
      .filter((call) => call.status === "completed" || call.status === "failed")
      .sort((a, b) => (b.finishedAt ?? b.updatedAt) - (a.finishedAt ?? a.updatedAt));
    const displayCalls = [...runningCalls];
    for (const call of finishedCalls) {
      if (displayCalls.length >= this.#reservedCallRows) break;
      displayCalls.push(call);
    }
    for (const call of displayCalls) {
      const progress =
        call.status === "running" && call.progress ? ` · ${safeText(call.progress)}` : "";
      lines.push(
        `  ${colorStatus(this.theme, call.status, statusGlyph(call.status))} ${safeText(
          call.label,
        )}${this.theme.fg("dim", progress)}`,
      );
    }
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

    if (lines.length === 1 && snapshot.actors.length > 0) {
      for (const actor of snapshot.actors.filter((candidate) => candidate.status !== "stopped")) {
        lines.push(actorLine(this.theme, actor));
      }
    }

    const bounded = lines.slice(0, Math.max(1, this.maxRows));
    if (lines.length > bounded.length && bounded.length > 0) {
      bounded[bounded.length - 1] = `${bounded[bounded.length - 1]} ${this.theme.fg(
        "dim",
        `+${lines.length - bounded.length}`,
      )}`;
    }
    return bounded.map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {}
}
