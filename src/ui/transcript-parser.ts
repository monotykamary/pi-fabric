import type { FabricLogLine } from "../agents/types.js";
import type { FabricAgentTranscript, FabricTranscriptEntry } from "./transcript.js";
import {
  clip,
  compactRedactedValue,
  contentText,
  messageError,
  recordOf,
  redact,
  redactRecord,
  terminalSafe,
} from "./transcript-sanitization.js";

const MAX_TOOL_SUMMARY_CHARS = 500;
const MAX_TRANSCRIPT_MESSAGE_CHARS = 40_000;
const TRANSCRIPT_ENTRY_LIMIT = 80;

type FabricTranscriptEntryStatus = "running" | "completed" | "failed";

export class TranscriptAccumulator {
  readonly entries: FabricTranscriptEntry[] = [];
  readonly #tools = new Map<string, FabricTranscriptEntry>();
  readonly #anonymousTools = new Map<string, FabricTranscriptEntry[]>();
  readonly #activeTools: FabricTranscriptEntry[] = [];
  #assistant: FabricTranscriptEntry | undefined;
  #retry: FabricTranscriptEntry | undefined;
  #compaction: FabricTranscriptEntry | undefined;
  #sequence = 0;

  append(events: Array<Record<string, unknown>>): void {
    for (const event of events) this.#append(event);
  }

  snapshot(
    olderAvailable = false,
    updatedAt?: number,
    maxEntries = TRANSCRIPT_ENTRY_LIMIT,
  ): FabricAgentTranscript {
    const entries = maxEntries > 0 && this.entries.length > maxEntries
      ? this.entries.slice(-maxEntries)
      : this.entries;
    const omitted = entries.length < this.entries.length;
    return {
      entries: entries.map((entry) => ({ ...entry })),
      truncated: olderAvailable || omitted,
      hasMore: olderAvailable || omitted,
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    };
  }

  #nextId(event: Record<string, unknown>, prefix = "event"): string {
    if (typeof event.toolCallId === "string") return event.toolCallId;
    if (typeof event.uuid === "string") return event.uuid;
    if (typeof event.id === "string") return event.id;
    return `${prefix}-${this.#sequence++}`;
  }

  #finishAssistant(status: "completed" | "failed"): void {
    if (!this.#assistant) return;
    this.#assistant.status = status;
    this.#assistant = undefined;
  }

  #pushMessage(
    kind: "user" | "assistant",
    id: string,
    text: string,
    status: FabricTranscriptEntryStatus = "completed",
    label = kind === "assistant" ? "Agent" : "User",
  ): void {
    const safe = clip(text, MAX_TRANSCRIPT_MESSAGE_CHARS);
    if (!safe) return;
    this.entries.push({ id, kind, label, text: safe, status });
  }

  #toolParent(id: string): FabricTranscriptEntry | undefined {
    if (!id.startsWith("fabric_")) return undefined;
    for (let index = this.#activeTools.length - 1; index >= 0; index--) {
      const candidate = this.#activeTools[index];
      if (candidate?.toolName === "fabric_exec" && candidate.status === "running") return candidate;
    }
    return undefined;
  }

  #startTool(
    id: string,
    label: string,
    args: unknown,
  ): FabricTranscriptEntry {
    const existing = this.#tools.get(id);
    const safeArgs = args === undefined ? undefined : redactRecord(args);
    if (existing) {
      if (safeArgs !== undefined) existing.args = safeArgs;
      if (args !== undefined) existing.text = compactRedactedValue(safeArgs ?? redact(args));
      return existing;
    }
    const parent = this.#toolParent(id);
    const safeLabel = terminalSafe(label) || "tool";
    const entry: FabricTranscriptEntry = {
      id,
      kind: "tool",
      label: safeLabel,
      toolName: safeLabel,
      status: "running",
      ...(safeArgs !== undefined ? { args: safeArgs } : {}),
      ...(args !== undefined
        ? { text: compactRedactedValue(safeArgs ?? redact(args)) }
        : {}),
      ...(parent ? { parentId: parent.id, depth: (parent.depth ?? 0) + 1 } : {}),
    };
    this.entries.push(entry);
    this.#tools.set(id, entry);
    this.#activeTools.push(entry);
    return entry;
  }

  #finishTool(id: string | undefined, label: string, result: unknown, failed: boolean): void {
    const safeLabel = terminalSafe(label) || "tool";
    const anonymous = this.#anonymousTools.get(safeLabel);
    const entry = id ? this.#tools.get(id) : anonymous?.shift();
    if (anonymous?.length === 0) this.#anonymousTools.delete(safeLabel);
    const safeResult = result === undefined ? undefined : redact(result);
    if (entry) {
      entry.status = failed ? "failed" : "completed";
      if (safeResult !== undefined) entry.result = safeResult;
      if (failed && result !== undefined) {
        const failure = compactRedactedValue(safeResult);
        entry.text = clip(
          `${entry.text ? `${entry.text} · ` : ""}error: ${failure}`,
          MAX_TOOL_SUMMARY_CHARS,
        );
      }
      this.#tools.delete(entry.id);
      const activeIndex = this.#activeTools.indexOf(entry);
      if (activeIndex >= 0) this.#activeTools.splice(activeIndex, 1);
      return;
    }
    this.entries.push({
      id: id ?? `tool-${this.#sequence++}`,
      kind: "tool",
      label: safeLabel,
      toolName: safeLabel,
      status: failed ? "failed" : "completed",
      ...(safeResult !== undefined ? { result: safeResult } : {}),
      ...(failed && safeResult !== undefined ? { text: compactRedactedValue(safeResult) } : {}),
    });
  }

  #appendSessionMessage(event: Record<string, unknown>, message: Record<string, unknown>): void {
    const id = this.#nextId(event, "message");
    if (message.role === "user") {
      this.#pushMessage("user", id, contentText(message.content));
      return;
    }
    if (message.role === "assistant") {
      const error = messageError(message);
      const text = contentText(message.content);
      if (text) this.#pushMessage("assistant", id, text, error ? "failed" : "completed");
      if (error) {
        this.entries.push({
          id: `${id}-error`,
          kind: "error",
          label: "Agent error",
          text: error,
          status: "failed",
        });
      }
      if (Array.isArray(message.content)) {
        for (const value of message.content) {
          const part = recordOf(value);
          if (part?.type !== "toolCall" || typeof part.name !== "string") continue;
          const toolId = typeof part.id === "string" ? part.id : `session-tool-${this.#sequence++}`;
          this.#startTool(toolId, part.name, part.arguments);
        }
      }
      return;
    }
    if (message.role === "toolResult") {
      const toolId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
      const label = typeof message.toolName === "string" ? message.toolName : "tool";
      this.#finishTool(
        toolId,
        label,
        { content: message.content, ...(message.details !== undefined ? { details: message.details } : {}) },
        message.isError === true,
      );
    }
  }

  #append(event: Record<string, unknown>): void {
    if (typeof event.type !== "string") return;
    const id = this.#nextId(event);

    if (event.type === "message") {
      const message = recordOf(event.message);
      if (message) this.#appendSessionMessage(event, message);
      return;
    }

    if (event.type === "model_change") {
      const provider = typeof event.provider === "string" ? event.provider : "";
      const model = typeof event.modelId === "string" ? event.modelId : "";
      this.entries.push({
        id,
        kind: "status",
        label: "Model changed",
        ...(provider || model ? { text: [provider, model].filter(Boolean).join("/") } : {}),
        status: "completed",
      });
      return;
    }

    if (event.type === "thinking_level_change") {
      this.entries.push({
        id,
        kind: "status",
        label: "Thinking changed",
        ...(typeof event.thinkingLevel === "string" ? { text: event.thinkingLevel } : {}),
        status: "completed",
      });
      return;
    }

    if (event.type === "compaction") {
      this.entries.push({
        id,
        kind: "status",
        label: "Compacted context",
        ...(typeof event.summary === "string" ? { text: terminalSafe(event.summary) } : {}),
        status: "completed",
      });
      return;
    }

    if (event.type === "stream_event") {
      const stream = recordOf(event.event);
      const delta = recordOf(stream?.delta);
      if (stream?.type === "content_block_delta" && delta?.type === "text_delta") {
        const text = typeof delta.text === "string" ? terminalSafe(delta.text, false) : "";
        if (!text) return;
        if (!this.#assistant) {
          this.#assistant = {
            id,
            kind: "assistant",
            label: "Claude",
            text: clip(text, MAX_TRANSCRIPT_MESSAGE_CHARS, false),
            status: "running",
          };
          this.entries.push(this.#assistant);
        } else {
          this.#assistant.text = clip(
            `${this.#assistant.text ?? ""}${text}`,
            MAX_TRANSCRIPT_MESSAGE_CHARS,
            false,
          );
        }
      }
      return;
    }

    if (event.type === "assistant") {
      const message = recordOf(event.message);
      if (!message || message.role !== "assistant") return;
      if (Array.isArray(message.content)) {
        for (const value of message.content) {
          const part = recordOf(value);
          if (part?.type !== "tool_use") continue;
          const toolId = typeof part.id === "string" ? part.id : `claude-tool-${this.#sequence++}`;
          const label = typeof part.name === "string" ? part.name : "tool";
          this.#startTool(toolId, label, part.input);
        }
      }
      const text = terminalSafe(contentText(message.content));
      if (text) {
        if (this.#assistant) {
          this.#assistant.text = clip(text, MAX_TRANSCRIPT_MESSAGE_CHARS);
          this.#finishAssistant("completed");
        } else {
          this.#pushMessage("assistant", id, text, "completed", "Claude");
        }
      }
      if (typeof event.error === "string") {
        this.entries.push({
          id: `${id}-error`,
          kind: "error",
          label: "Claude error",
          text: clip(event.error, MAX_TOOL_SUMMARY_CHARS),
          status: "failed",
        });
      }
      return;
    }

    if (event.type === "user") {
      const message = recordOf(event.message);
      if (!message || !Array.isArray(message.content)) return;
      let hasToolResult = false;
      for (const value of message.content) {
        const part = recordOf(value);
        if (part?.type !== "tool_result" || typeof part.tool_use_id !== "string") continue;
        hasToolResult = true;
        this.#finishTool(part.tool_use_id, "tool", part.content, part.is_error === true);
      }
      if (!hasToolResult) this.#pushMessage("user", id, contentText(message.content));
      return;
    }

    if (event.type === "result") {
      this.#finishAssistant(event.is_error === true ? "failed" : "completed");
      if (event.is_error === true || event.subtype !== "success") {
        const errors = Array.isArray(event.errors)
          ? event.errors.filter((value): value is string => typeof value === "string").join(" · ")
          : "";
        const text = errors || (typeof event.result === "string" ? event.result : "Claude run failed");
        this.entries.push({
          id,
          kind: "error",
          label: "Claude result",
          text: clip(text, MAX_TOOL_SUMMARY_CHARS),
          status: "failed",
        });
      }
      return;
    }

    if (event.type === "system" && event.subtype === "api_retry") {
      this.entries.push({
        id,
        kind: "status",
        label: "Claude API retry",
        status: "running",
        ...(typeof event.error === "string"
          ? { text: clip(event.error, MAX_TOOL_SUMMARY_CHARS) }
          : {}),
      });
      return;
    }

    if (event.type === "message_start") this.#finishAssistant("completed");
    if (event.type === "message_start" || event.type === "message_update") {
      const message = recordOf(event.message);
      if (!message) return;
      if (message.role === "user") {
        if (event.type === "message_start") this.#pushMessage("user", id, contentText(message.content));
        return;
      }
      if (message.role !== "assistant") return;
      const text = terminalSafe(contentText(message.content));
      if (!text) return;
      if (!this.#assistant) {
        this.#assistant = {
          id,
          kind: "assistant",
          label: "Agent",
          text: clip(text, MAX_TRANSCRIPT_MESSAGE_CHARS),
          status: "running",
        };
        this.entries.push(this.#assistant);
      } else {
        this.#assistant.text = clip(text, MAX_TRANSCRIPT_MESSAGE_CHARS);
        if (!this.entries.includes(this.#assistant)) this.entries.push(this.#assistant);
      }
      return;
    }

    if (event.type === "message_end") {
      const message = recordOf(event.message);
      if (!message) return;
      if (message.role === "user") {
        this.#pushMessage("user", id, contentText(message.content));
        return;
      }
      if (message.role !== "assistant") return;
      const error = messageError(message);
      if (error) {
        this.#finishAssistant("failed");
        this.entries.push({ id, kind: "error", label: "Agent error", text: error, status: "failed" });
        return;
      }
      const text = terminalSafe(contentText(message.content));
      if (!text) {
        this.#finishAssistant("completed");
        return;
      }
      if (!this.#assistant) this.#pushMessage("assistant", id, text);
      else {
        this.#assistant.text = clip(text, MAX_TRANSCRIPT_MESSAGE_CHARS);
        this.#finishAssistant("completed");
      }
      return;
    }

    if (event.type === "response" && event.command === "prompt" && event.success === false) {
      const text = typeof event.error === "string" ? event.error : "Pi rejected the prompt";
      this.entries.push({
        id,
        kind: "error",
        label: "Prompt rejected",
        text: clip(text, MAX_TOOL_SUMMARY_CHARS),
        status: "failed",
      });
      return;
    }

    if (event.type === "tool_execution_start") {
      const label = typeof event.toolName === "string" ? event.toolName : "tool";
      const entry = this.#startTool(id, label, event.args);
      if (typeof event.toolCallId !== "string") {
        const key = terminalSafe(label) || "tool";
        this.#tools.delete(entry.id);
        this.#anonymousTools.set(key, [...(this.#anonymousTools.get(key) ?? []), entry]);
      }
      return;
    }

    if (event.type === "tool_execution_end") {
      const label = typeof event.toolName === "string" ? event.toolName : "tool";
      this.#finishTool(
        typeof event.toolCallId === "string" ? event.toolCallId : undefined,
        label,
        event.result,
        event.isError === true,
      );
      return;
    }

    if (event.type === "auto_retry_start") {
      const attempt = typeof event.attempt === "number" ? ` ${event.attempt}` : "";
      this.#retry = {
        id,
        kind: "status",
        label: `Retry${attempt}`,
        status: "running",
        ...(typeof event.errorMessage === "string"
          ? { text: clip(event.errorMessage, MAX_TOOL_SUMMARY_CHARS) }
          : {}),
      };
      this.entries.push(this.#retry);
      return;
    }
    if (event.type === "auto_retry_end") {
      const failed = event.success === false;
      if (this.#retry) {
        this.#retry.status = failed ? "failed" : "completed";
        if (failed && typeof event.finalError === "string") {
          this.#retry.text = clip(event.finalError, MAX_TOOL_SUMMARY_CHARS);
        }
        this.#retry = undefined;
      }
      return;
    }

    if (event.type === "compaction_start") {
      this.#compaction = {
        id,
        kind: "status",
        label: "Compacting context",
        status: "running",
      };
      this.entries.push(this.#compaction);
      return;
    }
    if (event.type === "compaction_end") {
      if (this.#compaction) {
        const failed = event.aborted === true || typeof event.errorMessage === "string";
        this.#compaction.status = failed ? "failed" : "completed";
        if (typeof event.errorMessage === "string") {
          this.#compaction.text = clip(event.errorMessage, MAX_TOOL_SUMMARY_CHARS);
        }
        this.#compaction = undefined;
      }
      return;
    }

    if (event.type === "extension_error" || event.type === "worker_stderr") {
      const text =
        typeof event.error === "string"
          ? event.error
          : typeof event.text === "string"
            ? event.text
            : "Extension error";
      this.entries.push({
        id,
        kind: "error",
        label: event.type === "worker_stderr" ? "Worker stderr" : "Error",
        text: clip(text, MAX_TOOL_SUMMARY_CHARS),
        status: "failed",
      });
    }
  }
}

export const parseRaw = (raw: string): Record<string, unknown> | undefined => {
  try {
    return recordOf(JSON.parse(raw));
  } catch {
    return undefined;
  }
};

export const parsedEvents = (lines: FabricLogLine[]): Array<Record<string, unknown>> =>
  lines
    .map((line) => recordOf(line.parsed) ?? parseRaw(line.raw))
    .filter((event): event is Record<string, unknown> => event !== undefined);

interface ToolLifecycleStart {
  id: string;
  event: Record<string, unknown>;
}

export const normalizedToolStarts = (event: Record<string, unknown>): ToolLifecycleStart[] => {
  if (
    event.type === "tool_execution_start" &&
    typeof event.toolCallId === "string"
  ) {
    return [{ id: event.toolCallId, event }];
  }

  const starts: ToolLifecycleStart[] = [];
  const appendContentStarts = (
    content: unknown,
    type: "toolCall" | "tool_use",
  ): void => {
    if (!Array.isArray(content)) return;
    for (const value of content) {
      const part = recordOf(value);
      if (part?.type !== type || typeof part.id !== "string") continue;
      const name = typeof part.name === "string" ? part.name : "tool";
      starts.push({
        id: part.id,
        event: {
          type: "tool_execution_start",
          toolCallId: part.id,
          toolName: name,
          args: type === "toolCall" ? part.arguments : part.input,
        },
      });
    }
  };

  if (event.type === "message") {
    const message = recordOf(event.message);
    if (message?.role === "assistant") appendContentStarts(message.content, "toolCall");
  } else if (event.type === "assistant") {
    const message = recordOf(event.message);
    if (message?.role === "assistant") appendContentStarts(message.content, "tool_use");
  }
  return starts;
};

const toolLifecycleEndIds = (event: Record<string, unknown>): string[] => {
  if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
    return [event.toolCallId];
  }
  if (event.type === "message") {
    const message = recordOf(event.message);
    return message?.role === "toolResult" && typeof message.toolCallId === "string"
      ? [message.toolCallId]
      : [];
  }
  if (event.type !== "user") return [];
  const message = recordOf(event.message);
  if (!Array.isArray(message?.content)) return [];
  return message.content.flatMap((value) => {
    const part = recordOf(value);
    return part?.type === "tool_result" && typeof part.tool_use_id === "string"
      ? [part.tool_use_id]
      : [];
  });
};

export const missingToolStartIds = (events: Array<Record<string, unknown>>): Set<string> => {
  const active = new Set<string>();
  const missing = new Set<string>();
  for (const event of events) {
    for (const start of normalizedToolStarts(event)) active.add(start.id);
    for (const id of toolLifecycleEndIds(event)) {
      if (active.has(id)) active.delete(id);
      else missing.add(id);
    }
  }
  return missing;
};
