import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatDuration, formatTokens, safeText } from "./format.js";
import { spinnerFrame } from "./spinner.js";
import type { Entity } from "./dashboard-model.js";

export const statusGlyph = (status: string): string => {
  if (status === "completed" || status === "done") return "✓";
  if (status === "failed" || status === "timed_out" || status === "error") return "✗";
  if (status === "blocked") return "!";
  if (status === "stopped" || status === "cancelled") return "■";
  if (status === "queued" || status === "pending" || status === "ready") return "○";
  if (status === "idle" || status === "state") return "·";
  if (status === "global") return "◇";
  return spinnerFrame();
};

export const colorStatus = (theme: Theme, status: string, value: string): string => {
  if (status === "completed" || status === "done") return theme.fg("success", value);
  if (status === "failed" || status === "timed_out" || status === "error") {
    return theme.fg("error", value);
  }
  if (status === "blocked" || status === "warning") return theme.fg("warning", value);
  if (status === "running" || status === "in_progress") return theme.fg("accent", value);
  if (status === "global") return theme.fg("muted", value);
  return theme.fg("dim", value);
};

export const entityTail = (entity: Entity, now: number): string => {
  if (entity.kind === "main") {
    const main = entity.value;
    return [
      "host Pi",
      main.model,
      main.thinking,
      main.pendingMessages ? "messages queued" : undefined,
      main.local ? undefined : "remote",
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }
  if (entity.kind === "agent") {
    const agent = entity.value;
    const narrative = safeText(agent.error ?? agent.text).slice(0, 140);
    const summary =
      agent.status === "blocked" && narrative
        ? `needs input: ${narrative}`
        : (agent.status === "failed" || agent.status === "timed_out") && narrative
          ? `error: ${narrative}`
          : agent.status === "completed" && narrative
            ? `result: ${narrative}`
            : agent.currentTool ?? (agent.status === "running" ? "thinking" : undefined);
    const parts = [
      summary,
      agent.runner,
      agent.model,
      agent.usage ? `${formatTokens(agent.usage.input + agent.usage.output)} tok` : undefined,
      agent.toolCalls !== undefined ? `${agent.toolCalls} tools` : undefined,
      agent.startedAt ? formatDuration((agent.finishedAt ?? now) - agent.startedAt) : undefined,
    ];
    return parts.filter((value): value is string => Boolean(value)).join(" · ");
  }
  if (entity.kind === "actor") {
    const actor = entity.value;
    return [
      actor.runner,
      actor.model ?? actor.worker?.model,
      actor.worker?.currentTool,
      actor.worker?.usage
        ? `${formatTokens(actor.worker.usage.input + actor.worker.usage.output)} tok`
        : undefined,
      `${actor.messages} msg`,
      actor.queued > 0 ? `q:${actor.queued}` : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }
  if (entity.kind === "globalActor") {
    const def = entity.value;
    return [
      "global template",
      def.runner,
      def.model ?? "inherit",
      def.responseMode === "directive" ? "directive" : undefined,
      def.delivery !== "mailbox" ? def.delivery : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }
  if (entity.kind === "call") {
    const call = entity.value;
    return [
      call.ref,
      call.progress,
      call.metrics?.tokens !== undefined ? `${formatTokens(call.metrics.tokens)} tok` : undefined,
      call.metrics?.toolCalls !== undefined ? `${call.metrics.toolCalls} tools` : undefined,
      formatDuration((call.finishedAt ?? now) - call.startedAt),
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }
  if (entity.kind === "item") {
    const item = entity.value;
    return [
      item.current ?? item.detail,
      item.total !== undefined ? `${item.completed ?? 0}/${item.total}` : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }
  if (entity.kind === "peer") {
    const peer = entity.value;
    return [peer.sessionId, peer.model, `${formatDuration(Math.max(0, now - peer.updatedAt))} ago`]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }
  if (entity.kind === "meshParticipant") {
    const participant = entity.value;
    return [
      participant.participant ? `project ${participant.participant.kind}` : "observed mesh agent",
      `${participant.routes} route${participant.routes === 1 ? "" : "s"}`,
      `${formatDuration(Math.max(0, now - participant.lastSeenAt))} ago`,
    ].join(" · ");
  }
  if (entity.kind === "meshTopic") {
    const topic = entity.value;
    return [
      `${topic.subscribers.length} subscriber${topic.subscribers.length === 1 ? "" : "s"}`,
      topic.recentEvents > 0 ? `${topic.recentEvents} recent event${topic.recentEvents === 1 ? "" : "s"}` : undefined,
      topic.lastEventAt ? `${formatDuration(Math.max(0, now - topic.lastEventAt))} ago` : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }
  if (entity.kind === "meshRoute") {
    const route = entity.value;
    return [
      route.kind,
      route.topic,
      route.count > 1 ? `×${route.count}` : undefined,
      `${formatDuration(Math.max(0, now - route.lastAt))} ago`,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
  }
  return [entity.value.owner, entity.value.detail, `v${entity.value.version}`]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
};
