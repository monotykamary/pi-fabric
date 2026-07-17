import fs from "node:fs";
import type { FabricUiAgent } from "./types.js";

const MAX_READ_BYTES = 512 * 1024;
const MAX_ENTRIES = 80;
const MAX_CACHE_ENTRIES = 32;
const MAX_ASSISTANT_CHARS = 8_000;
const MAX_TOOL_CHARS = 500;
const secretKey = /authorization|api[-_]?key|token|password|secret|cookie|credential|private[-_]?key/i;

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
  modifiedAt: number;
  offset: number;
  remainder: Buffer;
  accumulator: TranscriptAccumulator;
  transcript: FabricAgentTranscript;
}

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const terminalSafe = (value: string): string =>
  value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/gi, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ")
    .replace(/\r\n?/g, "\n")
    .trim();

const graphemes = (value: string): string[] => {
  const Segmenter = Intl.Segmenter;
  if (Segmenter) {
    return [...new Segmenter(undefined, { granularity: "grapheme" }).segment(value)].map(
      (entry) => entry.segment,
    );
  }
  return Array.from(value);
};

const clip = (value: string, max: number): string => {
  const normalized = terminalSafe(value);
  const parts = graphemes(normalized);
  if (parts.length <= max) return normalized;
  const tail = Math.min(1_000, Math.floor(max * 0.25));
  return `${parts.slice(0, max - tail - 2).join("")}…\n${parts.slice(-tail).join("")}`;
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

const redact = (value: unknown, key = "", depth = 0): unknown => {
  if (secretKey.test(key)) return "[redacted]";
  if (depth > 5) return "[nested value]";
  if (typeof value === "string") {
    const hidden = value
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
      .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g, "[redacted]");
    if (/^[A-Za-z0-9+/=_-]{160,}$/.test(hidden)) return `[large encoded value · ${hidden.length} chars]`;
    return hidden;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => redact(entry, key, depth + 1));
  const record = recordOf(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record)
      .slice(0, 30)
      .map(([name, entry]) => [name, redact(entry, name, depth + 1)]),
  );
};

const compactValue = (value: unknown): string => {
  try {
    return clip(JSON.stringify(redact(value)).replace(/\s+/g, " "), MAX_TOOL_CHARS);
  } catch {
    return clip(String(redact(value) ?? "").replace(/\s+/g, " "), MAX_TOOL_CHARS);
  }
};

class TranscriptAccumulator {
  readonly entries: TranscriptEntry[] = [];
  readonly #tools = new Map<string, TranscriptEntry>();
  readonly #anonymousTools = new Map<string, TranscriptEntry[]>();
  #assistant: TranscriptEntry | undefined;
  #retry: TranscriptEntry | undefined;
  #compaction: TranscriptEntry | undefined;
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

  #nextId(event: Record<string, unknown>): string {
    if (typeof event.toolCallId === "string") return event.toolCallId;
    if (typeof event.uuid === "string") return event.uuid;
    return `event-${this.#sequence++}`;
  }

  #finishAssistant(status: "completed" | "failed"): void {
    if (!this.#assistant) return;
    this.#assistant.status = status;
    this.#assistant = undefined;
  }

  #append(event: Record<string, unknown>): void {
    if (typeof event.type !== "string") return;
    const id = this.#nextId(event);


    if (event.type === "stream_event") {
      const stream = recordOf(event.event);
      const delta = recordOf(stream?.delta);
      if (stream?.type === "content_block_delta" && delta?.type === "text_delta") {
        const text = typeof delta.text === "string" ? delta.text : "";
        if (!text) return;
        if (!this.#assistant) {
          this.#assistant = {
            id,
            kind: "assistant",
            label: "Claude",
            text: clip(text, MAX_ASSISTANT_CHARS),
            status: "running",
          };
          this.entries.push(this.#assistant);
        } else {
          this.#assistant.text = clip(`${this.#assistant.text ?? ""}${text}`, MAX_ASSISTANT_CHARS);
        }
        this.#bound();
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
          const label = typeof part.name === "string" ? terminalSafe(part.name) : "tool";
          const text = part.input === undefined ? undefined : compactValue(part.input);
          const entry: TranscriptEntry = {
            id: toolId,
            kind: "tool",
            label,
            status: "running",
            ...(text ? { text } : {}),
          };
          this.entries.push(entry);
          this.#tools.set(toolId, entry);
        }
      }
      const text = clip(contentText(message.content), MAX_ASSISTANT_CHARS);
      if (text) {
        if (this.#assistant) {
          this.#assistant.text = text;
          this.#finishAssistant("completed");
        } else {
          this.entries.push({ id, kind: "assistant", label: "Claude", text, status: "completed" });
        }
      }
      if (typeof event.error === "string") {
        this.entries.push({
          id: `${id}-error`,
          kind: "error",
          label: "Claude error",
          text: clip(event.error, MAX_TOOL_CHARS),
          status: "failed",
        });
      }
      this.#bound();
      return;
    }

    if (event.type === "user") {
      const message = recordOf(event.message);
      if (!message || !Array.isArray(message.content)) return;
      for (const value of message.content) {
        const part = recordOf(value);
        if (part?.type !== "tool_result" || typeof part.tool_use_id !== "string") continue;
        const entry = this.#tools.get(part.tool_use_id);
        const failed = part.is_error === true;
        const failure = failed ? compactValue(part.content) : "";
        if (entry) {
          entry.status = failed ? "failed" : "completed";
          if (failure) {
            entry.text = clip(
              `${entry.text ? `${entry.text} · ` : ""}error: ${failure}`,
              MAX_TOOL_CHARS,
            );
          }
          this.#tools.delete(part.tool_use_id);
        }
      }
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
          text: clip(text, MAX_TOOL_CHARS),
          status: "failed",
        });
        this.#bound();
      }
      return;
    }

    if (event.type === "system" && event.subtype === "api_retry") {
      const text = typeof event.error === "string" ? clip(event.error, MAX_TOOL_CHARS) : undefined;
      this.entries.push({
        id,
        kind: "status",
        label: "Claude API retry",
        status: "running",
        ...(text ? { text } : {}),
      });
      this.#bound();
      return;
    }

    if (event.type === "message_start") this.#finishAssistant("completed");
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
        this.#finishAssistant("failed");
        this.entries.push({ id, kind: "error", label: "Agent error", text: error, status: "failed" });
        this.#bound();
        return;
      }
      const text = messageText(event);
      if (!text) {
        this.#finishAssistant("completed");
        return;
      }
      if (!this.#assistant) {
        this.entries.push({ id, kind: "assistant", label: "Agent", text, status: "completed" });
      } else {
        this.#assistant.text = text;
        this.#finishAssistant("completed");
      }
      this.#bound();
      return;
    }

    if (event.type === "response" && event.command === "prompt" && event.success === false) {
      const text = typeof event.error === "string" ? event.error : "Pi rejected the prompt";
      this.entries.push({ id, kind: "error", label: "Prompt rejected", text: clip(text, MAX_TOOL_CHARS), status: "failed" });
      this.#bound();
      return;
    }

    if (event.type === "tool_execution_start") {
      const label = typeof event.toolName === "string" ? terminalSafe(event.toolName) : "tool";
      const text = event.args === undefined ? undefined : compactValue(event.args);
      const entry: TranscriptEntry = { id, kind: "tool", label, status: "running", ...(text ? { text } : {}) };
      this.entries.push(entry);
      if (typeof event.toolCallId === "string") this.#tools.set(event.toolCallId, entry);
      else this.#anonymousTools.set(label, [...(this.#anonymousTools.get(label) ?? []), entry]);
      this.#bound();
      return;
    }

    if (event.type === "tool_execution_end") {
      const label = typeof event.toolName === "string" ? terminalSafe(event.toolName) : "tool";
      const anonymous = this.#anonymousTools.get(label);
      const entry =
        typeof event.toolCallId === "string"
          ? this.#tools.get(event.toolCallId)
          : anonymous?.shift();
      if (anonymous?.length === 0) this.#anonymousTools.delete(label);
      const failed = event.isError === true;
      const failure = failed && event.result !== undefined ? compactValue(event.result) : "";
      if (entry) {
        entry.status = failed ? "failed" : "completed";
        if (failure) entry.text = clip(`${entry.text ? `${entry.text} · ` : ""}error: ${failure}`, MAX_TOOL_CHARS);
        this.#tools.delete(entry.id);
      } else {
        this.entries.push({ id, kind: "tool", label, status: failed ? "failed" : "completed", ...(failure ? { text: failure } : {}) });
      }
      this.#bound();
      return;
    }

    if (event.type === "auto_retry_start") {
      const attempt = typeof event.attempt === "number" ? ` ${event.attempt}` : "";
      const text =
        typeof event.errorMessage === "string"
          ? clip(event.errorMessage, MAX_TOOL_CHARS)
          : undefined;
      const retry: TranscriptEntry = {
        id,
        kind: "status",
        label: `Retry${attempt}`,
        status: "running",
        ...(text ? { text } : {}),
      };
      this.#retry = retry;
      this.entries.push(retry);
      this.#bound();
      return;
    }
    if (event.type === "auto_retry_end") {
      const failed = event.success === false;
      if (this.#retry) {
        this.#retry.status = failed ? "failed" : "completed";
        if (failed && typeof event.finalError === "string") this.#retry.text = clip(event.finalError, MAX_TOOL_CHARS);
        this.#retry = undefined;
      }
      return;
    }

    if (event.type === "compaction_start") {
      this.#compaction = { id, kind: "status", label: "Compacting context", status: "running" };
      this.entries.push(this.#compaction);
      this.#bound();
      return;
    }
    if (event.type === "compaction_end") {
      if (this.#compaction) {
        const failed = event.aborted === true || typeof event.errorMessage === "string";
        this.#compaction.status = failed ? "failed" : "completed";
        if (typeof event.errorMessage === "string") this.#compaction.text = clip(event.errorMessage, MAX_TOOL_CHARS);
        this.#compaction = undefined;
      }
      return;
    }

    if (event.type === "extension_error") {
      const text = typeof event.error === "string" ? event.error : "Extension error";
      this.entries.push({ id, kind: "error", label: "Error", text: clip(text, MAX_TOOL_CHARS), status: "failed" });
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

const parseEvents = (content: Buffer): Array<Record<string, unknown>> => {
  const events: Array<Record<string, unknown>> = [];
  for (const raw of content.toString("utf8").split("\n")) {
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

const readFrom = (descriptor: number, start: number, end: number): { data: Buffer; bytesRead: number } => {
  const length = Math.max(0, end - start);
  if (length === 0) return { data: Buffer.alloc(0), bytesRead: 0 };
  const buffer = Buffer.alloc(length);
  const bytesRead = fs.readSync(descriptor, buffer, 0, length, start);
  return { data: buffer.subarray(0, bytesRead), bytesRead };
};

const splitComplete = (data: Buffer): { complete: Buffer; remainder: Buffer } => {
  const newline = data.lastIndexOf(0x0a);
  if (newline < 0) return { complete: Buffer.alloc(0), remainder: data };
  return { complete: data.subarray(0, newline + 1), remainder: data.subarray(newline + 1) };
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
      const sameSizeRewrite =
        sameFile && cached.offset === stat.size && cached.modifiedAt !== stat.mtimeMs;
      let state = cached;
      if (!state || !sameFile || stat.size < state.offset || sameSizeRewrite) {
        const accumulator = new TranscriptAccumulator();
        const start = Math.max(0, stat.size - MAX_READ_BYTES);
        const initial = readFrom(descriptor, start, stat.size);
        let data = initial.data;
        if (start > 0) {
          const newline = data.indexOf(0x0a);
          data = newline >= 0 ? data.subarray(newline + 1) : Buffer.alloc(0);
          accumulator.truncated = true;
        }
        const split = splitComplete(data);
        accumulator.append(parseEvents(split.complete));
        state = {
          device: stat.dev,
          inode: stat.ino,
          modifiedAt: stat.mtimeMs,
          offset: start + initial.bytesRead,
          remainder: Buffer.from(split.remainder),
          accumulator,
          transcript: accumulator.snapshot(stat.mtimeMs),
        };
      } else if (stat.size > state.offset) {
        const start = Math.max(state.offset, stat.size - MAX_READ_BYTES);
        const skipped = start > state.offset;
        const appended = readFrom(descriptor, start, stat.size);
        let data = skipped ? appended.data : Buffer.concat([state.remainder, appended.data]);
        if (skipped) {
          const newline = data.indexOf(0x0a);
          data = newline >= 0 ? data.subarray(newline + 1) : Buffer.alloc(0);
          state.accumulator.truncated = true;
        }
        const split = splitComplete(data);
        state.remainder = Buffer.from(split.remainder);
        state.accumulator.append(parseEvents(split.complete));
        state.offset = start + appended.bytesRead;
        state.modifiedAt = stat.mtimeMs;
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
