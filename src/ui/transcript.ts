import fs from "node:fs";
import type { FabricUiAgent } from "./types.js";

const MAX_READ_BYTES = 512 * 1024;
const MAX_ENTRIES = 80;
const MAX_CACHE_ENTRIES = 32;
const MAX_ASSISTANT_CHARS = 8_000;
const MAX_TOOL_CHARS = 500;

export interface FabricAgentTranscript {
  entries: Array<{
    id: string;
    kind: "assistant" | "tool" | "error" | "status";
    label: string;
    text?: string;
    status?: "running" | "completed" | "failed";
  }>;
  truncated: boolean;
  updatedAt?: number;
}

type TranscriptEntry = FabricAgentTranscript["entries"][number];

interface CachedTranscript {
  device: number;
  inode: number;
  offset: number;
  remainder: string;
  accumulator: TranscriptAccumulator;
  transcript: FabricAgentTranscript;
}

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const clip = (value: string, max: number): string => {
  const normalized = value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (normalized.length <= max) return normalized;
  const tail = Math.min(1_000, Math.floor(max * 0.25));
  return `${normalized.slice(0, max - tail - 2)}…\n${normalized.slice(-tail)}`;
};

const contentText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        const record = recordOf(part);
        return record?.type === "text" && typeof record.text === "string" ? record.text : "";
      })
      .filter(Boolean)
      .join("");
  }
  const record = recordOf(value);
  if (!record) return "";
  if (typeof record.text === "string") return record.text;
  if (record.content !== undefined) return contentText(record.content);
  return "";
};

const messageText = (event: Record<string, unknown>): string => {
  const message = recordOf(event.message);
  if (!message || message.role !== "assistant") return "";
  return clip(contentText(message.content), MAX_ASSISTANT_CHARS);
};

const messageError = (event: Record<string, unknown>): string => {
  const message = recordOf(event.message);
  if (!message || message.role !== "assistant" || message.stopReason !== "error") return "";
  const details: string[] = [];
  if (typeof message.errorMessage === "string") details.push(message.errorMessage);
  else if (typeof message.error === "string") details.push(message.error);
  if (Array.isArray(message.diagnostics)) {
    for (const value of message.diagnostics) {
      const diagnostic = recordOf(value);
      const nested = recordOf(diagnostic?.error);
      const detail =
        typeof nested?.message === "string"
          ? nested.message
          : typeof diagnostic?.message === "string"
            ? diagnostic.message
            : undefined;
      if (detail) details.push(detail);
    }
  }
  return clip([...new Set(details)].join(" · ") || "Agent response failed", MAX_TOOL_CHARS);
};

const compactValue = (value: unknown): string => {
  const text = contentText(value);
  if (text) return clip(text.replace(/\s+/g, " "), MAX_TOOL_CHARS);
  try {
    return clip(JSON.stringify(value).replace(/\s+/g, " "), MAX_TOOL_CHARS);
  } catch {
    return clip(String(value ?? "").replace(/\s+/g, " "), MAX_TOOL_CHARS);
  }
};

class TranscriptAccumulator {
  readonly entries: TranscriptEntry[] = [];
  readonly #tools = new Map<string, TranscriptEntry>();
  #assistant: TranscriptEntry | undefined;
  #sequence = 0;
  truncated = false;

  append(events: Array<Record<string, unknown>>): void {
    for (const event of events) this.#append(event);
  }

  snapshot(updatedAt?: number): FabricAgentTranscript {
    return {
      entries: this.entries.map((entry) => ({ ...entry })),
      truncated: this.truncated,
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    };
  }

  #append(event: Record<string, unknown>): void {
    if (typeof event.type !== "string") return;
    const id =
      typeof event.toolCallId === "string"
        ? event.toolCallId
        : `event-${this.#sequence++}`;

    if (event.type === "message_start" || event.type === "message_update") {
      const text = messageText(event);
      if (!text) return;
      if (!this.#assistant) {
        this.#assistant = { id, kind: "assistant", label: "Agent", text, status: "running" };
        this.entries.push(this.#assistant);
      } else {
        this.#assistant.text = text;
        if (!this.entries.includes(this.#assistant)) this.entries.push(this.#assistant);
      }
      this.#bound();
      return;
    }

    if (event.type === "message_end") {
      const error = messageError(event);
      if (error) {
        this.entries.push({ id, kind: "error", label: "Agent error", text: error, status: "failed" });
        this.#assistant = undefined;
        this.#bound();
        return;
      }
      const text = messageText(event);
      if (!text) return;
      if (!this.#assistant) {
        this.#assistant = { id, kind: "assistant", label: "Agent", text };
        this.entries.push(this.#assistant);
      } else {
        this.#assistant.text = text;
        this.#assistant.status = "completed";
      }
      this.#assistant = undefined;
      this.#bound();
      return;
    }

    if (event.type === "tool_execution_start") {
      const label = typeof event.toolName === "string" ? event.toolName : "tool";
      const text = event.args === undefined ? undefined : compactValue(event.args);
      const entry: TranscriptEntry = {
        id,
        kind: "tool",
        label,
        status: "running",
        ...(text ? { text } : {}),
      };
      this.entries.push(entry);
      this.#tools.set(id, entry);
      this.#bound();
      return;
    }

    if (event.type === "tool_execution_end") {
      const entry = this.#tools.get(id);
      const failed = event.isError === true;
      if (entry) {
        entry.status = failed ? "failed" : "completed";
        this.#tools.delete(id);
      } else {
        const result = failed && event.result !== undefined ? compactValue(event.result) : "";
        this.entries.push({
          id,
          kind: "tool",
          label: typeof event.toolName === "string" ? event.toolName : "tool",
          status: failed ? "failed" : "completed",
          ...(result ? { text: result } : {}),
        });
      }
      this.#bound();
      return;
    }

    if (event.type === "auto_retry_start" || event.type === "extension_error") {
      const text =
        typeof event.errorMessage === "string"
          ? event.errorMessage
          : typeof event.error === "string"
            ? event.error
            : "Agent operation failed";
      this.entries.push({
        id,
        kind: "error",
        label: "Error",
        text: clip(text, MAX_TOOL_CHARS),
        status: "failed",
      });
      this.#bound();
      return;
    }

    if (event.type === "compaction_start") {
      this.entries.push({ id, kind: "status", label: "Compacting context", status: "running" });
      this.#bound();
    }
  }

  #bound(): void {
    while (this.entries.length > MAX_ENTRIES) {
      const removable = this.entries.findIndex((entry) => entry !== this.#assistant);
      if (removable < 0) break;
      const [removed] = this.entries.splice(removable, 1);
      if (removed) this.#tools.delete(removed.id);
      this.truncated = true;
    }
  }
}

export const projectAgentTranscript = (
  events: Array<Record<string, unknown>>,
  truncated = false,
): FabricAgentTranscript => {
  const accumulator = new TranscriptAccumulator();
  accumulator.truncated = truncated;
  accumulator.append(events);
  return accumulator.snapshot();
};

const parseEvents = (content: string): Array<Record<string, unknown>> => {
  const events: Array<Record<string, unknown>> = [];
  for (const raw of content.split("\n")) {
    if (!raw) continue;
    try {
      const event = recordOf(JSON.parse(raw));
      if (event) events.push(event);
    } catch {
      // Ignore malformed protocol output while preserving the surrounding stream.
    }
  }
  return events;
};

const readFrom = (
  descriptor: number,
  start: number,
  end: number,
): { text: string; bytesRead: number } => {
  const length = Math.max(0, end - start);
  if (length === 0) return { text: "", bytesRead: 0 };
  const buffer = Buffer.alloc(length);
  const bytesRead = fs.readSync(descriptor, buffer, 0, length, start);
  return { text: buffer.subarray(0, bytesRead).toString("utf8"), bytesRead };
};

export class AgentTranscriptReader {
  readonly #cache = new Map<string, CachedTranscript>();

  read(agent: FabricUiAgent): FabricAgentTranscript {
    const filePath = agent.logFile;
    if (!filePath) return { entries: [], truncated: false };
    const cached = this.#cache.get(filePath);
    let descriptor: number | undefined;
    try {
      const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) return cached?.transcript ?? { entries: [], truncated: false };
      const sameFile = cached?.device === stat.dev && cached.inode === stat.ino;
      let state = cached;
      if (!state || !sameFile || stat.size < state.offset) {
        const accumulator = new TranscriptAccumulator();
        const start = Math.max(0, stat.size - MAX_READ_BYTES);
        const initial = readFrom(descriptor, start, stat.size);
        let text = initial.text;
        if (start > 0) {
          const newline = text.indexOf("\n");
          text = newline >= 0 ? text.slice(newline + 1) : "";
          accumulator.truncated = true;
        }
        const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
        const remainder = text.slice(complete.length);
        accumulator.append(parseEvents(complete));
        state = {
          device: stat.dev,
          inode: stat.ino,
          offset: start + initial.bytesRead,
          remainder,
          accumulator,
          transcript: accumulator.snapshot(stat.mtimeMs),
        };
      } else if (stat.size > state.offset) {
        const start = Math.max(state.offset, stat.size - MAX_READ_BYTES);
        const skipped = start > state.offset;
        const appended = readFrom(descriptor, start, stat.size);
        let text = `${skipped ? "" : state.remainder}${appended.text}`;
        if (skipped) {
          const newline = text.indexOf("\n");
          text = newline >= 0 ? text.slice(newline + 1) : "";
          state.accumulator.truncated = true;
        }
        const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
        state.remainder = text.slice(complete.length);
        state.accumulator.append(parseEvents(complete));
        state.offset = start + appended.bytesRead;
        state.transcript = state.accumulator.snapshot(stat.mtimeMs);
      }
      this.#remember(filePath, state);
      return state.transcript;
    } catch {
      return cached?.transcript ?? { entries: [], truncated: false };
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  clear(): void {
    this.#cache.clear();
  }

  #remember(filePath: string, state: CachedTranscript): void {
    this.#cache.delete(filePath);
    this.#cache.set(filePath, state);
    while (this.#cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.#cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#cache.delete(oldest);
    }
  }
}
