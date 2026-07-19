import fs from "node:fs";
import { readJsonlPageFromDescriptor } from "../log-tail.js";
import type { FabricLogLine } from "../subagents/types.js";

const PAGE_LINES = 240;
const MAX_CACHE_ENTRIES = 32;
const MAX_LIVE_LINES = 2_000;
const MAX_LIVE_ENTRIES = 1_000;
const MAX_TRACKED_ACTIVE_TOOLS = 64;
const MAX_TOOL_SUMMARY_CHARS = 500;
const TRANSCRIPT_ENTRY_LIMIT = 80;
const MAX_ENCODED_STRING_CHARS = 160;
const secretKey = /authorization|api[-_]?key|token|password|secret|cookie|credential|private[-_]?key/i;

type FabricTranscriptEntryStatus = "running" | "completed" | "failed";

export interface FabricTranscriptEntry {
  id: string;
  kind: "user" | "assistant" | "tool" | "error" | "status";
  label: string;
  text?: string;
  status?: FabricTranscriptEntryStatus;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  parentId?: string;
  depth?: number;
}

export interface FabricAgentTranscript {
  entries: FabricTranscriptEntry[];
  /** Kept for compatibility; true means older pages are available. */
  truncated: boolean;
  hasMore?: boolean;
  updatedAt?: number;
}

export interface FabricTranscriptSource {
  id: string;
  status: string;
  logFile?: string;
}

export interface FabricNestedToolPreview {
  kind: "fabric-agent-tools";
  id: string;
  name: string;
  status: string;
  runner?: "pi" | "claude";
  owner: "agent" | "actor";
  text?: string;
  tools: FabricTranscriptEntry[];
}

interface CachedTranscript {
  device: number;
  inode: number;
  modifiedAt: number;
  offset: number;
  remainder: Buffer;
  remainderOffset: number;
  lines: FabricLogLine[];
  before: number | undefined;
  hasMore: boolean;
  accumulator: TranscriptAccumulator;
  entriesTrimmed: boolean;
  linesTrimmed: boolean;
  retainAll: boolean;
  transcript: FabricAgentTranscript;
}

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const terminalSafe = (value: string, trim = true): string => {
  const safe = value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/gi, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ")
    .replace(/\r\n?/g, "\n");
  return trim ? safe.trim() : safe;
};

const graphemeSegmenter = Intl.Segmenter
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

const graphemes = (value: string): string[] =>
  graphemeSegmenter
    ? [...graphemeSegmenter.segment(value)].map((entry) => entry.segment)
    : Array.from(value);

const clip = (value: string, max: number): string => {
  const normalized = terminalSafe(value);
  if (normalized.length <= max) return normalized;
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

const messageError = (message: Record<string, unknown>): string => {
  if (message.role !== "assistant" || message.stopReason !== "error") return "";
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
  return clip([...new Set(details)].join(" · ") || "Agent response failed", MAX_TOOL_SUMMARY_CHARS);
};

const redactInlineSecrets = (value: string): string =>
  value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, "Basic [redacted]")
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .replace(
      /\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-Api-Key)\s*:\s*[^\r\n;]+/gi,
      "$1: [redacted]",
    )
    .replace(
      /\b([A-Z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|COOKIE)[A-Z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi,
      "$1=[redacted]",
    )
    .replace(
      /(--?(?:password|passwd|token|secret|api[-_]?key|access[-_]?key|credential|cookie))(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi,
      "$1=[redacted]",
    )
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[redacted]@");

const redact = (value: unknown, key = "", depth = 0): unknown => {
  if (secretKey.test(key)) return "[redacted]";
  if (depth > 12) return "[nested value]";
  if (typeof value === "string") {
    const hidden = redactInlineSecrets(terminalSafe(value, false));
    if (
      hidden.length >= MAX_ENCODED_STRING_CHARS &&
      /^[A-Za-z0-9+/=_-]+$/.test(hidden)
    ) {
      return `[large encoded value · ${hidden.length} chars]`;
    }
    return hidden;
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, key, depth + 1));
  const record = recordOf(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).map(([name, entry]) => [name, redact(entry, name, depth + 1)]),
  );
};

const redactRecord = (value: unknown): Record<string, unknown> | undefined => {
  const record = recordOf(value);
  return record ? (redact(record) as Record<string, unknown>) : undefined;
};

const compactValue = (value: unknown): string => {
  try {
    return clip(JSON.stringify(redact(value)).replace(/\s+/g, " "), MAX_TOOL_SUMMARY_CHARS);
  } catch {
    return clip(String(redact(value) ?? "").replace(/\s+/g, " "), MAX_TOOL_SUMMARY_CHARS);
  }
};

class TranscriptAccumulator {
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

  trim(maxEntries: number): boolean {
    if (this.entries.length <= maxEntries) return false;
    const protectedEntries = new Set<FabricTranscriptEntry>([
      ...this.#activeTools.slice(-MAX_TRACKED_ACTIVE_TOOLS),
      ...(this.#assistant ? [this.#assistant] : []),
      ...(this.#retry ? [this.#retry] : []),
      ...(this.#compaction ? [this.#compaction] : []),
    ]);
    let removable = this.entries.length - maxEntries;
    const removed = new Set<FabricTranscriptEntry>();
    const retained = this.entries.filter((entry) => {
      if (removable <= 0 || protectedEntries.has(entry)) return true;
      removable--;
      removed.add(entry);
      return false;
    });
    if (removed.size === 0) return false;
    this.entries.splice(0, this.entries.length, ...retained);
    for (const [id, entry] of this.#tools) {
      if (removed.has(entry)) this.#tools.delete(id);
    }
    for (const [label, entries] of this.#anonymousTools) {
      const active = entries.filter((entry) => !removed.has(entry));
      if (active.length > 0) this.#anonymousTools.set(label, active);
      else this.#anonymousTools.delete(label);
    }
    const active = this.#activeTools.filter((entry) => !removed.has(entry));
    this.#activeTools.splice(0, this.#activeTools.length, ...active);
    return true;
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
    const safe = terminalSafe(text);
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
      if (args !== undefined) existing.text = compactValue(args);
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
      ...(args !== undefined ? { text: compactValue(args) } : {}),
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
        const failure = compactValue(result);
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
      ...(failed && result !== undefined ? { text: compactValue(result) } : {}),
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
            text,
            status: "running",
          };
          this.entries.push(this.#assistant);
        } else {
          this.#assistant.text = `${this.#assistant.text ?? ""}${text}`;
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
          this.#assistant.text = text;
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
        this.#assistant = { id, kind: "assistant", label: "Agent", text, status: "running" };
        this.entries.push(this.#assistant);
      } else {
        this.#assistant.text = text;
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
        this.#assistant.text = text;
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

export const projectAgentTranscript = (
  events: Array<Record<string, unknown>>,
  olderAvailable = false,
): FabricAgentTranscript => {
  const accumulator = new TranscriptAccumulator();
  accumulator.append(events);
  return accumulator.snapshot(olderAvailable);
};

const parseRaw = (raw: string): Record<string, unknown> | undefined => {
  try {
    return recordOf(JSON.parse(raw));
  } catch {
    return undefined;
  }
};

const parsedEvents = (lines: FabricLogLine[]): Array<Record<string, unknown>> =>
  lines
    .map((line) => recordOf(line.parsed) ?? parseRaw(line.raw))
    .filter((event): event is Record<string, unknown> => event !== undefined);

const readRange = (descriptor: number, start: number, end: number): Buffer => {
  const length = Math.max(0, end - start);
  if (length === 0) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let offset = start;
  while (offset < end) {
    const size = Math.min(256 * 1024, end - offset);
    const chunk = Buffer.allocUnsafe(size);
    const bytesRead = fs.readSync(descriptor, chunk, 0, size, offset);
    if (bytesRead <= 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return Buffer.concat(chunks);
};

const splitAppendedLines = (
  data: Buffer,
  startOffset: number,
): { lines: FabricLogLine[]; remainder: Buffer; remainderOffset: number } => {
  const lines: FabricLogLine[] = [];
  let start = 0;
  for (let index = 0; index < data.length; index++) {
    if (data[index] !== 0x0a) continue;
    const raw = data.subarray(start, index).toString("utf8").replace(/\r$/, "");
    if (raw) {
      const offset = startOffset + start;
      const parsed = parseRaw(raw);
      lines.push({ offset, raw, ...(parsed ? { parsed } : {}) });
    }
    start = index + 1;
  }
  return {
    lines,
    remainder: Buffer.from(data.subarray(start)),
    remainderOffset: startOffset + start,
  };
};

export const projectAgentLogLines = (
  lines: FabricLogLine[],
  olderAvailable = false,
): FabricAgentTranscript => projectAgentTranscript(parsedEvents(lines), olderAvailable);

export const isFabricNestedToolPreview = (value: unknown): value is FabricNestedToolPreview => {
  const record = recordOf(value);
  return (
    record?.kind === "fabric-agent-tools" &&
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    (record.text === undefined || typeof record.text === "string") &&
    Array.isArray(record.tools)
  );
};

export const recentTranscriptTools = (
  transcript: FabricAgentTranscript,
  limit = 2,
): FabricTranscriptEntry[] => {
  const tools = transcript.entries.filter((entry) => entry.kind === "tool");
  const boundedLimit = Math.max(1, limit);
  const running = tools.filter((entry) => entry.status === "running");
  const completed = tools.filter((entry) => entry.status !== "running");
  const completedSlots = Math.max(0, boundedLimit - Math.min(running.length, boundedLimit));
  const retained = new Set([
    ...running.slice(-boundedLimit),
    ...completed.slice(-completedSlots),
  ]);
  return tools
    .filter((entry) => retained.has(entry))
    .slice(-boundedLimit)
    .map((entry) => ({ ...entry }));
};

export class AgentTranscriptReader {
  readonly #cache = new Map<string, CachedTranscript>();

  read(source: FabricTranscriptSource): FabricAgentTranscript {
    const filePath = source.logFile;
    if (!filePath) return { entries: [], truncated: false, hasMore: false };
    const cached = this.#cache.get(filePath);
    let descriptor: number | undefined;
    try {
      const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) return cached?.transcript ?? { entries: [], truncated: false, hasMore: false };
      const sameFile = cached?.device === stat.dev && cached.inode === stat.ino;
      const sameSizeRewrite =
        sameFile && cached.offset === stat.size && cached.modifiedAt !== stat.mtimeMs;
      let state = cached;
      if (!state || !sameFile || stat.size < state.offset || sameSizeRewrite) {
        state = this.#initialState(descriptor, stat);
      } else if (stat.size > state.offset) {
        const appended = readRange(descriptor, state.offset, stat.size);
        const startOffset = state.remainder.length > 0 ? state.remainderOffset : state.offset;
        const split = splitAppendedLines(Buffer.concat([state.remainder, appended]), startOffset);
        state.lines.push(...split.lines);
        state.accumulator.append(parsedEvents(split.lines));
        state.remainder = split.remainder;
        state.remainderOffset = split.remainderOffset;
        state.offset = stat.size;
        state.modifiedAt = stat.mtimeMs;
        this.#trimLiveState(state);
        state.transcript = this.#snapshot(state);
      }
      this.#remember(filePath, state);
      return state.transcript;
    } catch {
      return cached?.transcript ?? { entries: [], truncated: false, hasMore: false };
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  loadOlder(source: FabricTranscriptSource): boolean {
    const filePath = source.logFile;
    if (!filePath) return false;
    this.read(source);
    const state = this.#cache.get(filePath);
    if (!state?.hasMore) return false;
    if (state.entriesTrimmed && !state.linesTrimmed) {
      state.accumulator = this.#accumulator(state.lines);
      state.entriesTrimmed = false;
      state.retainAll = true;
      state.hasMore = Boolean(state.before && state.before > 0);
      state.transcript = this.#snapshot(state);
      this.#remember(filePath, state);
      return true;
    }
    const cursor = state.before ?? state.lines[0]?.offset;
    if (cursor === undefined || cursor <= 0) {
      state.hasMore = false;
      state.entriesTrimmed = false;
      state.transcript = this.#snapshot(state);
      return false;
    }
    let descriptor: number | undefined;
    try {
      const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.dev !== state.device || stat.ino !== state.inode) return false;
      const page = readJsonlPageFromDescriptor(descriptor, PAGE_LINES, cursor, state.offset);
      const start = page.lines[0]?.offset;
      if (start === undefined) {
        state.hasMore = false;
        state.transcript = this.#snapshot(state);
        return false;
      }
      const split = splitAppendedLines(readRange(descriptor, start, state.offset), start);
      state.lines = split.lines;
      state.remainder = split.remainder;
      state.remainderOffset = split.remainderOffset;
      state.before = page.before;
      state.hasMore = page.hasMore;
      state.accumulator = this.#accumulator(state.lines);
      state.entriesTrimmed = false;
      state.linesTrimmed = false;
      state.retainAll = true;
      state.transcript = this.#snapshot(state);
      this.#remember(filePath, state);
      return true;
    } catch {
      return false;
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
    }
  }

  loadAll(source: FabricTranscriptSource): boolean {
    const filePath = source.logFile;
    if (!filePath) return false;
    this.read(source);
    const state = this.#cache.get(filePath);
    if (!state?.hasMore) return false;
    let descriptor: number | undefined;
    try {
      const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.dev !== state.device || stat.ino !== state.inode) return false;
      const split = splitAppendedLines(readRange(descriptor, 0, state.offset), 0);
      const previousEntries = state.accumulator.entries.length;
      state.lines = split.lines;
      state.remainder = split.remainder;
      state.remainderOffset = split.remainderOffset;
      state.before = undefined;
      state.hasMore = false;
      state.accumulator = this.#accumulator(state.lines);
      state.entriesTrimmed = false;
      state.linesTrimmed = false;
      state.retainAll = true;
      state.transcript = this.#snapshot(state);
      this.#remember(filePath, state);
      return state.accumulator.entries.length > previousEntries;
    } catch {
      return false;
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
    }
  }

  clear(): void {
    this.#cache.clear();
  }

  #initialState(descriptor: number, stat: fs.Stats): CachedTranscript {
    const page = readJsonlPageFromDescriptor(descriptor, PAGE_LINES, undefined, stat.size);
    const lines = [...page.lines];
    let remainder: Buffer = Buffer.alloc(0);
    let remainderOffset = stat.size;
    if (stat.size > 0) {
      const lastByte = Buffer.allocUnsafe(1);
      fs.readSync(descriptor, lastByte, 0, 1, stat.size - 1);
      if (lastByte[0] !== 0x0a) {
        const partial = lines.at(-1);
        if (partial) {
          lines.pop();
          remainderOffset = partial.offset;
          remainder = readRange(descriptor, partial.offset, stat.size);
        }
      }
    }
    const accumulator = this.#accumulator(lines);
    const state: CachedTranscript = {
      device: stat.dev,
      inode: stat.ino,
      modifiedAt: stat.mtimeMs,
      offset: stat.size,
      remainder,
      remainderOffset,
      lines,
      before: page.before,
      hasMore: page.hasMore,
      accumulator,
      entriesTrimmed: false,
      linesTrimmed: false,
      retainAll: false,
      transcript: { entries: [], truncated: page.hasMore, hasMore: page.hasMore },
    };
    state.transcript = this.#snapshot(state);
    return state;
  }

  #accumulator(lines: FabricLogLine[]): TranscriptAccumulator {
    const accumulator = new TranscriptAccumulator();
    accumulator.append(parsedEvents(lines));
    return accumulator;
  }

  #trimLiveState(state: CachedTranscript): void {
    if (state.retainAll) return;
    if (state.accumulator.trim(MAX_LIVE_ENTRIES)) {
      state.entriesTrimmed = true;
      state.hasMore = true;
    }
    if (state.lines.length <= MAX_LIVE_LINES) return;
    state.lines.splice(0, state.lines.length - MAX_LIVE_LINES);
    state.linesTrimmed = true;
    state.hasMore = true;
    state.before ??= state.lines[0]?.offset;
  }

  #snapshot(state: CachedTranscript): FabricAgentTranscript {
    return state.accumulator.snapshot(
      state.hasMore || state.entriesTrimmed,
      state.modifiedAt,
      Number.MAX_SAFE_INTEGER,
    );
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
