import fs from "node:fs";
import { readJsonlPageFromDescriptor } from "../log-tail.js";
import type { FabricLogLine } from "../subagents/types.js";

const PAGE_LINES = 40;
const MAX_PAGE_BYTES = 512 * 1024;
const MAX_CACHE_ENTRIES = 32;
const FORWARD_READ_CHUNK_BYTES = 64 * 1024;
const MAX_TOOL_SUMMARY_CHARS = 500;
const TRANSCRIPT_ENTRY_LIMIT = 80;
const MAX_ENCODED_STRING_CHARS = 160;
const MAX_TRANSCRIPT_MESSAGE_CHARS = 40_000;
const MAX_TRANSCRIPT_VALUE_CHARS = 40_000;
const MAX_TRANSCRIPT_STRING_CHARS = 12_000;
const MAX_TRANSCRIPT_VALUE_NODES = 400;
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
  hasNewer?: boolean;
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

interface RedactionBudget {
  chars: number;
  nodes: number;
}

interface CachedTranscript {
  device: number;
  inode: number;
  modifiedAt: number;
  offset: number;
  completeEnd: number;
  pageStart: number;
  pageEnd: number;
  hasMore: boolean;
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

const clip = (value: string, max: number, trim = true): string => {
  const normalized = terminalSafe(value, trim);
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

const redact = (
  value: unknown,
  key = "",
  depth = 0,
  budget: RedactionBudget = {
    chars: MAX_TRANSCRIPT_VALUE_CHARS,
    nodes: MAX_TRANSCRIPT_VALUE_NODES,
  },
): unknown => {
  if (secretKey.test(key)) return "[redacted]";
  if (depth > 12) return "[nested value]";
  if (budget.nodes <= 0) return "[value omitted]";
  budget.nodes--;
  if (typeof value === "string") {
    const safe = terminalSafe(value, false);
    if (safe.length >= MAX_ENCODED_STRING_CHARS && /^[A-Za-z0-9+/=_-]+$/.test(safe)) {
      return `[large encoded value · ${safe.length} chars]`;
    }
    const available = Math.max(0, Math.min(MAX_TRANSCRIPT_STRING_CHARS, budget.chars));
    if (available === 0) return "[text omitted]";
    const hidden = redactInlineSecrets(clip(safe, available, false));
    budget.chars = Math.max(0, budget.chars - hidden.length);
    return hidden;
  }
  if (Array.isArray(value)) {
    const entries: unknown[] = [];
    for (const entry of value) {
      if (budget.nodes <= 0) {
        entries.push(`[${value.length - entries.length} entries omitted]`);
        break;
      }
      entries.push(redact(entry, key, depth + 1, budget));
    }
    return entries;
  }
  const record = recordOf(value);
  if (!record) return value;
  const entries = Object.entries(record);
  const redacted: Record<string, unknown> = {};
  for (let index = 0; index < entries.length; index++) {
    if (budget.nodes <= 0) {
      redacted["…"] = `[${entries.length - index} fields omitted]`;
      break;
    }
    const [name, entry] = entries[index]!;
    redacted[name] = redact(entry, name, depth + 1, budget);
  }
  return redacted;
};

const redactRecord = (value: unknown): Record<string, unknown> | undefined => {
  const record = recordOf(value);
  if (!record) return undefined;
  return recordOf(redact(record));
};

const compactRedactedValue = (value: unknown): string => {
  try {
    return clip(JSON.stringify(value).replace(/\s+/g, " "), MAX_TOOL_SUMMARY_CHARS);
  } catch {
    return clip(String(value ?? "").replace(/\s+/g, " "), MAX_TOOL_SUMMARY_CHARS);
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

interface ForwardTranscriptPage {
  lines: FabricLogLine[];
  end: number;
}

const completeLogEnd = (descriptor: number, size: number, fallback = 0): number => {
  if (size <= 0) return 0;
  const scanFloor = Math.max(0, size - MAX_PAGE_BYTES);
  let scanEnd = size;
  while (scanEnd > scanFloor) {
    const scanStart = Math.max(scanFloor, scanEnd - FORWARD_READ_CHUNK_BYTES);
    const chunk = Buffer.allocUnsafe(scanEnd - scanStart);
    const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, scanStart);
    if (bytesRead <= 0) return 0;
    for (let index = bytesRead - 1; index >= 0; index--) {
      if (chunk[index] === 0x0a) return scanStart + index + 1;
    }
    scanEnd = scanStart;
  }
  return Math.min(fallback, size);
};

const readForwardPage = (
  descriptor: number,
  start: number,
  end: number,
): ForwardTranscriptPage => {
  const lines: FabricLogLine[] = [];
  const readLimit = Math.min(end, Math.max(0, start) + MAX_PAGE_BYTES);
  let readOffset = Math.max(0, start);
  let pending = Buffer.alloc(0);
  let pendingOffset = readOffset;
  let pageEnd = readOffset;

  while (readOffset < readLimit && lines.length < PAGE_LINES) {
    const chunkSize = Math.min(FORWARD_READ_CHUNK_BYTES, readLimit - readOffset);
    const chunk = Buffer.allocUnsafe(chunkSize);
    const bytesRead = fs.readSync(descriptor, chunk, 0, chunkSize, readOffset);
    if (bytesRead <= 0) break;
    const data = pending.length > 0
      ? Buffer.concat([pending, chunk.subarray(0, bytesRead)])
      : chunk.subarray(0, bytesRead);
    const dataOffset = pending.length > 0 ? pendingOffset : readOffset;
    let lineStart = 0;
    for (let index = 0; index < data.length; index++) {
      if (data[index] !== 0x0a) continue;
      const raw = data.subarray(lineStart, index).toString("utf8").replace(/\r$/, "");
      pageEnd = dataOffset + index + 1;
      if (raw) {
        const offset = dataOffset + lineStart;
        const parsed = parseRaw(raw);
        lines.push({ offset, raw, ...(parsed ? { parsed } : {}) });
        if (lines.length >= PAGE_LINES) return { lines, end: pageEnd };
      }
      lineStart = index + 1;
    }
    pending = Buffer.from(data.subarray(lineStart));
    pendingOffset = dataOffset + lineStart;
    readOffset += bytesRead;
  }

  return { lines, end: readOffset >= end ? end : pageEnd };
};

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

  read(
    source: FabricTranscriptSource,
    followLatest = true,
  ): FabricAgentTranscript {
    const filePath = source.logFile;
    if (!filePath) {
      return { entries: [], truncated: false, hasMore: false, hasNewer: false };
    }
    const cached = this.#cache.get(filePath);
    let descriptor: number | undefined;
    try {
      const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) {
        return cached?.transcript ?? {
          entries: [],
          truncated: false,
          hasMore: false,
          hasNewer: false,
        };
      }
      const sameFile = cached?.device === stat.dev && cached.inode === stat.ino;
      const sameSizeRewrite =
        sameFile && cached.offset === stat.size && cached.modifiedAt !== stat.mtimeMs;
      let state: CachedTranscript;
      if (!cached || !sameFile || stat.size < cached.offset || sameSizeRewrite) {
        state = this.#latestState(descriptor, stat);
      } else if (stat.size !== cached.offset || stat.mtimeMs !== cached.modifiedAt) {
        const wasAtTail = cached.pageEnd >= cached.completeEnd;
        const completeEnd = completeLogEnd(descriptor, stat.size, cached.completeEnd);
        if (
          cached.pageEnd > completeEnd ||
          (followLatest && wasAtTail && completeEnd > cached.completeEnd)
        ) {
          state = this.#latestState(descriptor, stat, completeEnd);
        } else {
          state = {
            ...cached,
            modifiedAt: stat.mtimeMs,
            offset: stat.size,
            completeEnd,
            transcript: {
              ...cached.transcript,
              hasNewer: cached.pageEnd < completeEnd,
              updatedAt: stat.mtimeMs,
            },
          };
        }
      } else {
        state = cached;
      }
      this.#remember(filePath, state);
      return state.transcript;
    } catch {
      return cached?.transcript ?? {
        entries: [],
        truncated: false,
        hasMore: false,
        hasNewer: false,
      };
    } finally {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
    }
  }

  loadOlder(source: FabricTranscriptSource): boolean {
    const filePath = source.logFile;
    if (!filePath) return false;
    this.read(source, false);
    const cached = this.#cache.get(filePath);
    if (!cached?.hasMore || cached.pageStart <= 0) return false;
    let descriptor: number | undefined;
    try {
      const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.dev !== cached.device || stat.ino !== cached.inode) return false;
      const completeEnd = completeLogEnd(descriptor, stat.size, cached.completeEnd);
      const pageEnd = Math.min(cached.pageStart, completeEnd);
      const page = readJsonlPageFromDescriptor(
        descriptor,
        PAGE_LINES,
        pageEnd,
        stat.size,
        MAX_PAGE_BYTES,
      );
      const pageStart = page.lines[0]?.offset;
      if (pageStart === undefined) return false;
      const state = this.#stateForPage(
        stat,
        completeEnd,
        page.lines,
        pageStart,
        pageEnd,
        page.hasMore,
      );
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

  loadNewer(source: FabricTranscriptSource): boolean {
    const filePath = source.logFile;
    if (!filePath) return false;
    this.read(source, false);
    const cached = this.#cache.get(filePath);
    if (!cached || cached.pageEnd >= cached.completeEnd) return false;
    let descriptor: number | undefined;
    try {
      const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.dev !== cached.device || stat.ino !== cached.inode) return false;
      const completeEnd = completeLogEnd(descriptor, stat.size, cached.completeEnd);
      const page = readForwardPage(descriptor, cached.pageEnd, completeEnd);
      if (page.lines.length === 0 || page.end <= cached.pageEnd) return false;
      const state = this.#stateForPage(
        stat,
        completeEnd,
        page.lines,
        cached.pageEnd,
        page.end,
        cached.pageEnd > 0,
      );
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

  loadLatest(source: FabricTranscriptSource): boolean {
    const filePath = source.logFile;
    if (!filePath) return false;
    this.read(source, false);
    const cached = this.#cache.get(filePath);
    let descriptor: number | undefined;
    try {
      const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) return false;
      if (cached && (stat.dev !== cached.device || stat.ino !== cached.inode)) return false;
      const completeEnd = completeLogEnd(descriptor, stat.size, cached?.completeEnd ?? 0);
      const state = this.#latestState(descriptor, stat, completeEnd);
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

  clear(): void {
    this.#cache.clear();
  }

  #latestState(
    descriptor: number,
    stat: fs.Stats,
    knownCompleteEnd?: number,
  ): CachedTranscript {
    const completeEnd = knownCompleteEnd ?? completeLogEnd(descriptor, stat.size);
    const page = readJsonlPageFromDescriptor(
      descriptor,
      PAGE_LINES,
      completeEnd,
      stat.size,
      MAX_PAGE_BYTES,
    );
    return this.#stateForPage(
      stat,
      completeEnd,
      page.lines,
      page.lines[0]?.offset ?? completeEnd,
      completeEnd,
      page.hasMore,
    );
  }

  #stateForPage(
    stat: fs.Stats,
    completeEnd: number,
    lines: FabricLogLine[],
    pageStart: number,
    pageEnd: number,
    hasMore: boolean,
  ): CachedTranscript {
    const accumulator = new TranscriptAccumulator();
    accumulator.append(parsedEvents(lines));
    const transcript = {
      ...accumulator.snapshot(hasMore, stat.mtimeMs, Number.MAX_SAFE_INTEGER),
      hasNewer: pageEnd < completeEnd,
    };
    return {
      device: stat.dev,
      inode: stat.ino,
      modifiedAt: stat.mtimeMs,
      offset: stat.size,
      completeEnd,
      pageStart,
      pageEnd,
      hasMore: transcript.hasMore ?? false,
      transcript,
    };
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
