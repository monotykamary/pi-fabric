import fs from "node:fs";
import {
  buildContextEntries,
  sessionEntryToContextMessages,
  type SessionEntry,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

// Native Pi conversation transcript reader.
//
// Unlike the dashboard's FabricTranscriptEntry pipeline (transcript-reader.ts +
// transcript-parser.ts), which flattens, clips (500/40k char caps), redacts and
// drops fields, this reader preserves the native Pi AgentMessage union intact:
//
//   - user messages with text AND image content blocks
//   - assistant thinking blocks, tool calls with full arguments
//   - tool results with full content, details and error flags
//   - native bashExecution / custom / branchSummary / compactionSummary messages
//   - session entry tree semantics (branch via leaf→root walk, compaction
//     checkpoints, branch summaries) using pi's own buildContextEntries +
//     sessionEntryToContextMessages — the same display projection interactive
//     mode's renderSessionItems consumes, with native summary roles preserved.
//   - live streaming from the worker RPC event log (events.jsonl): partial
//     assistant assembly from message_start/message_update deltas, full
//     tool_execution_{start,update,end} lifecycle with untruncated args,
//     partialResult and result details (including nested Fabric tool audits),
//     and entry_appended folding for extension session entries.
//
// Sources: either the native Pi session JSONL (preferred full history), the
// worker run events.jsonl (surfaced by the agents.log API), or both. Retained
// actor runs work in all shapes: a persistent session file, a retained
// events.jsonl (--no-session runs keep their whole history in events only), or
// a session file passed as `logFile` (the retained-actor fallback the UI uses).
//
// The controller keeps one reader per participant (stable source id). When only
// `logFile`/`eventsFile` rolls to the next activation run, all history loaded
// from the stable session file — including pinned loadOlder pages — is
// preserved; only events-derived streaming state resets.
//
// IO is byte-bounded but always loads whole records — a single record larger
// than the page budget grows the budget instead of being clipped, so no field
// is ever dropped. Repeated loadOlder() calls walk the user through all of
// history. Files that cannot be read are reported through the bounded
// `unavailable`/`error` snapshot fields instead of throwing.

export type NativeAgentMessage = SessionMessageEntry["message"];

export interface NativeConversationSource {
  /** Stable participant id (the controller keeps one reader per id). */
  id: string;
  status: string;
  /**
   * FabricTranscriptSource-compatible path: the active worker's or latest
   * retained run's events.jsonl (RPC event log) — or, retained-actor fallback,
   * a native Pi session file.
   */
  logFile?: string;
  /** Stable native Pi session file, preferred as the full history source. */
  sessionFile?: string;
  /** Explicit events.jsonl override; wins over logFile when both are given. */
  eventsFile?: string;
}

export interface NativeToolExecution {
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  status: "running" | "completed" | "failed";
  /** tool_execution_start observed for this call. */
  executionStarted?: boolean;
  /** Full arguments are known (start/end observed or toolcall_end delivered). */
  argsComplete?: boolean;
  /** Accumulated partial result while running (content + details preserved whole). */
  partial?: { content?: unknown[]; details?: unknown };
  /** Final result (content + details preserved whole). */
  result?: { content?: unknown[]; details?: unknown };
  isError?: boolean;
}

interface NativeTranscriptEntry {
  entryId: string;
  parentId: string | null;
  entryType: string;
  timestamp: string;
  /** Present for `message` entries; the native AgentMessage, unmodified. */
  message?: NativeAgentMessage;
  /** The whole native session entry — compaction, branch_summary, custom, … */
  entry: SessionEntry;
}

interface NativeConversationStreaming {
  /** True while a partial assistant message or a tool execution is live. */
  active: boolean;
  /** Assistant message assembled from message_start + message_update deltas. */
  partialAssistant?: AssistantMessage;
  /** Tool executions keyed by toolCallId, including completed ones. */
  tools: NativeToolExecution[];
}

export interface NativeConversationTranscript {
  /** Native AgentMessage union: active-branch display sequence + live tail. */
  messages: NativeAgentMessage[];
  /** Bumped whenever new records were applied; renderers can skip unchanged reads. */
  revision: number;
  /** Active branch entries (root → leaf), compaction-applied, native and whole. */
  entries: NativeTranscriptEntry[];
  streaming: NativeConversationStreaming;
  pendingMessages?: { steering: string[]; followUp: string[] };
  leafId: string | null;
  sourceId: string;
  status: string;
  sessionFile?: string;
  eventsFile?: string;
  sessionId?: string;
  /** Both file windows reached the file starts and the branch path reaches root. */
  historyComplete: boolean;
  /** Older whole-record pages are available via loadOlder(). */
  hasMore: boolean;
  /** New complete records exist past the window (only when reads are pinned). */
  hasNewer: boolean;
  /** Which source files could not be read, when any were given but unreadable. */
  unavailable?: { sessionFile?: boolean; eventsFile?: boolean };
  /** Bounded (≤200 char) reason for the last unreadable-file condition. */
  error?: string;
  updatedAt: number;
}

const INITIAL_PAGE_BYTES = 256 * 1024;
const OLDER_PAGE_BYTES = 256 * 1024;
const GROWTH_PAGE_BYTES = 1024 * 1024;
const MAX_PAGE_BYTES = 64 * 1024 * 1024;
const CLASSIFY_PROBE_BYTES = 4096;
const MAX_ERROR_CHARS = 200;

const emptyUsage = (): AssistantMessage["usage"] => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const parseRecord = (raw: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

const isSessionEntry = (value: unknown): value is SessionEntry =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as SessionEntry).type === "string" &&
  typeof (value as SessionEntry).id === "string" &&
  ((value as SessionEntry).parentId === null || typeof (value as SessionEntry).parentId === "string");

const messageFingerprint = (message: NativeAgentMessage): string => {
  if ("content" in message) return JSON.stringify(message.content);
  if ("summary" in message) return JSON.stringify(message.summary);
  return "";
};

const messageKey = (message: NativeAgentMessage): string => {
  if (message.role === "toolResult") return `toolResult:${message.toolCallId}`;
  if (message.role === "assistant") {
    const calls = message.content
      .filter((block): block is Extract<typeof block, { type: "toolCall" }> => block.type === "toolCall")
      .map((block) => block.id);
    if (calls.length > 0) return `assistant:${message.timestamp}:calls:${calls.join(",")}`;
  }
  return `${message.role}:${message.timestamp}:${messageFingerprint(message)}`;
};

const clipError = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
};

interface RecordPage {
  /** Byte offset of the first record included (record-aligned). */
  start: number;
  /** Byte offset just past the last record included. */
  end: number;
  records: string[];
}

/**
 * Read whole JSONL records ending at `end`, backwards, byte-bounded. The start
 * is aligned forward to a record boundary; if one record exceeds the budget the
 * budget doubles so the record is always loaded whole (never clipped).
 *
 * An unterminated trailing line (mid-write at EOF) is only included when it
 * already parses as JSON; otherwise the page ends before it so the next read
 * picks up the completed record. Nothing partially written is ever surfaced.
 */
const readBackwardPage = (
  descriptor: number,
  end: number,
  budget: number,
  includeFinalPartialLine: boolean,
): RecordPage => {
  let windowBudget = Math.min(Math.max(budget, 1), MAX_PAGE_BYTES);
  for (;;) {
    const candidate = Math.max(0, end - windowBudget);
    const buffer = Buffer.allocUnsafe(end - candidate);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, candidate);
    const data = buffer.subarray(0, Math.max(0, bytesRead));
    if (data.length === 0) return { start: candidate, end: candidate, records: [] };
    const firstNewline = data.indexOf(0x0a);
    if (firstNewline === -1) {
      if (candidate === 0) {
        // The whole window is one unterminated record (single-record file
        // caught mid-write). Include it; JSON validity is decided by the parser.
        const raw = data.toString("utf8").replace(/\r$/, "");
        return { start: 0, end, records: raw ? [raw] : [] };
      }
      // One record larger than the budget: grow and retry so it loads whole.
      if (windowBudget >= MAX_PAGE_BYTES) return { start: end, end, records: [] };
      windowBudget = Math.min(windowBudget * 2, MAX_PAGE_BYTES);
      continue;
    }
    // At the file start (candidate === 0) the first line is a complete record;
    // otherwise align forward past a possibly partial head line.
    const alignStart = candidate > 0 ? firstNewline + 1 : 0;
    const records: string[] = [];
    let lineStart = alignStart;
    let lastComplete = alignStart;
    for (let index = alignStart; index < data.length; index++) {
      if (data[index] !== 0x0a) continue;
      const raw = data.subarray(lineStart, index).toString("utf8").replace(/\r$/, "");
      if (raw) records.push(raw);
      lineStart = index + 1;
      lastComplete = lineStart;
    }
    if (records.length === 0 && candidate > 0) {
      // No complete record fit before the window end (one record larger than
      // the budget): grow and retry so it loads whole.
      if (windowBudget >= MAX_PAGE_BYTES) return { start: end, end, records: [] };
      windowBudget = Math.min(windowBudget * 2, MAX_PAGE_BYTES);
      continue;
    }
    let endOffset = end;
    if (lastComplete < data.length) {
      const tail = data.subarray(lastComplete).toString("utf8").replace(/\r$/, "");
      if (includeFinalPartialLine && tail && parseRecord(tail)) {
        records.push(tail);
      } else {
        endOffset = candidate + lastComplete;
      }
    }
    return { start: candidate + alignStart, end: endOffset, records };
  }
};

/**
 * Read whole JSONL records forward from `start` up to the file end, bounded by
 * `budget`. An unterminated trailing line is only included when it already
 * parses as JSON (complete record caught mid-append); otherwise it is left for
 * the next read so no partially written record is ever surfaced.
 */
const readForwardPage = (
  descriptor: number,
  start: number,
  size: number,
  budget: number,
): RecordPage => {
  let windowBudget = Math.min(Math.max(budget, 1), MAX_PAGE_BYTES);
  for (;;) {
    const limit = Math.min(size, start + windowBudget);
    if (limit <= start) return { start, end: start, records: [] };
    const buffer = Buffer.allocUnsafe(limit - start);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, start);
    const data = buffer.subarray(0, Math.max(0, bytesRead));
    if (data.length === 0) return { start, end: start, records: [] };
    const records: string[] = [];
    let lineStart = 0;
    let lastComplete = 0;
    for (let index = 0; index < data.length; index++) {
      if (data[index] !== 0x0a) continue;
      const raw = data.subarray(lineStart, index).toString("utf8").replace(/\r$/, "");
      if (raw) records.push(raw);
      lineStart = index + 1;
      lastComplete = lineStart;
    }
    if (lastComplete < data.length) {
      const tail = data.subarray(lastComplete).toString("utf8").replace(/\r$/, "");
      if (limit >= size && tail && parseRecord(tail)) {
        records.push(tail);
        lastComplete = data.length;
      }
    }
    if (lastComplete === 0 && limit < size) {
      // One record larger than the budget: grow and retry so it loads whole.
      if (windowBudget >= MAX_PAGE_BYTES) return { start, end: start, records: [] };
      windowBudget = Math.min(windowBudget * 2, MAX_PAGE_BYTES);
      continue;
    }
    return { start, end: start + lastComplete, records };
  }
};

interface FileWindow {
  /** Oldest byte loaded so far (record-aligned); 0 once history start is reached. */
  head: number;
  /** Newest byte consumed so far. */
  tail: number;
  /** Size observed at the last read; tail === size means followed to EOF. */
  size: number;
  hasOlder: boolean;
  /** Set when the file exists but could not be read. */
  unavailable: boolean;
}

type FileKind = "session" | "events";

const classifyFile = (filePath: string): FileKind | "unreadable" => {
  let descriptor: number | undefined;
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) return "unreadable";
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(CLASSIFY_PROBE_BYTES, stat.size)));
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, Math.max(0, bytesRead)).toString("utf8");
    const firstLine = head.split("\n", 1)[0] ?? "";
    const parsed = parseRecord(firstLine);
    // Native session files start with a {"type":"session",...} header; worker
    // events.jsonl streams start with RPC events (agent_start, response, …).
    return parsed?.type === "session" ? "session" : "events";
  } catch {
    return "unreadable";
  } finally {
    if (descriptor !== undefined) closeQuietly(descriptor);
  }
};

const openDescriptor = (
  filePath: string,
): { descriptor: number; size: number } | { error: string } | undefined => {
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      closeQuietly(descriptor);
      return { error: "not a regular file" };
    }
    return { descriptor, size: stat.size };
  } catch (error) {
    return { error: clipError(error) };
  }
};

const closeQuietly = (descriptor: number): void => {
  try {
    fs.closeSync(descriptor);
  } catch {
    // best effort
  }
};

export class NativeConversationReader {
  #sourceId = "";
  #status = "";
  #sessionFile: string | undefined;
  #eventsFile: string | undefined;

  #entries: SessionEntry[] = [];
  readonly #entryIds = new Set<string>();
  readonly #byId = new Map<string, SessionEntry>();
  readonly #sessionEntryIds = new Set<string>();
  readonly #eventEntryIds = new Set<string>();
  #sessionLeafId: string | undefined;
  #eventLeafId: string | undefined;
  #sessionId: string | undefined;

  readonly #streamed = new Map<string, NativeAgentMessage>();
  #streamedOrder: string[] = [];
  #partial: AssistantMessage | undefined;
  #eventRecords: Record<string, unknown>[] = [];
  #pendingMessages: NativeConversationTranscript["pendingMessages"];
  readonly #partialArgsRaw = new Map<number, string>();
  readonly #tools = new Map<string, NativeToolExecution>();

  readonly #windows = new Map<FileKind, FileWindow>();
  #followed = true;
  #revision = 0;
  #error: string | undefined;
  #snapshot: NativeConversationTranscript | undefined;

  /** Last transcript produced; undefined before the first successful read. */
  get last(): NativeConversationTranscript | undefined {
    return this.#snapshot;
  }

  read(source: NativeConversationSource, followLatest = true): NativeConversationTranscript {
    const sourceId = typeof source?.id === "string" ? source.id : "";
    const status = typeof source?.status === "string" ? source.status : "";
    const explicitSession = typeof source?.sessionFile === "string" && source.sessionFile
      ? source.sessionFile
      : undefined;
    const explicitEvents = typeof source?.eventsFile === "string" && source.eventsFile
      ? source.eventsFile
      : undefined;
    const logFile = typeof source?.logFile === "string" ? source.logFile : undefined;

    let sessionFile = explicitSession;
    let eventsFile = explicitEvents;
    let logUnresolved = false;
    if (logFile && logFile !== explicitSession && logFile !== explicitEvents) {
      // Retained-actor fallback: logFile may BE a native session file.
      const kind = classifyFile(logFile);
      if (kind === "session") sessionFile ??= logFile;
      else if (kind === "events") eventsFile ??= logFile;
      else logUnresolved = true;
    }

    if (sourceId !== this.#sourceId || sessionFile !== this.#sessionFile) {
      this.#resetPaths(sourceId, status, sessionFile, eventsFile);
    } else {
      this.#status = status;
      if (eventsFile !== this.#eventsFile) {
        // Rolling to the next activation run: preserve every bit of session
        // history loaded so far (including pinned older pages); reset only
        // events-derived streaming state.
        this.#eventsFile = eventsFile;
        this.#resetEventsState();
        this.#revision += 1;
      }
    }
    if (logUnresolved) {
      // The log path was given but could not be read: surface it as an
      // unavailable events source instead of silently showing nothing.
      this.#windows.set("events", { head: 0, tail: 0, size: 0, hasOlder: false, unavailable: true });
      this.#setError(logFile ?? "source log unreadable");
    }
    this.#followed = followLatest !== false;
    this.#ingest(this.#followed);
    return this.#snapshot ?? this.#buildSnapshot();
  }

  /** Load older whole-record pages of history. Repeated calls load all of it. */
  loadOlder(pages = 1): NativeConversationTranscript | undefined {
    if (!this.#snapshot) return undefined;
    for (let page = 0; page < Math.max(1, pages); page++) {
      let progressed = false;
      for (const [kind, filePath] of this.#windowFiles()) {
        if (this.#loadOlderFile(kind, filePath)) progressed = true;
      }
      if (!progressed) break;
    }
    this.#revision += 1;
    this.#snapshot = this.#buildSnapshot();
    return this.#snapshot;
  }

  /** Consume any records newer than the current window (used when pinned). */
  loadNewer(): NativeConversationTranscript | undefined {
    if (!this.#snapshot) return undefined;
    this.#followed = true;
    this.#ingest(true);
    return this.#snapshot ?? undefined;
  }

  /** Drop the current windows and re-read from the tail of both files. */
  loadLatest(): NativeConversationTranscript | undefined {
    if (!this.#snapshot) return undefined;
    for (const [kind, filePath] of this.#windowFiles()) this.#initWindow(kind, filePath);
    this.#followed = true;
    this.#ingest(true);
    return this.#snapshot ?? undefined;
  }

  /** Drop all cached state for a clean re-read. */
  clear(): void {
    this.#resetPaths("", "", undefined, undefined);
  }

  #windowFiles(): Array<[FileKind, string]> {
    const files: Array<[FileKind, string]> = [];
    if (this.#sessionFile) files.push(["session", this.#sessionFile]);
    if (this.#eventsFile) files.push(["events", this.#eventsFile]);
    return files;
  }

  #setError(detail: string): void {
    this.#error = clipError(detail);
  }

  #resetPaths(
    sourceId: string,
    status: string,
    sessionFile: string | undefined,
    eventsFile: string | undefined,
  ): void {
    this.#sourceId = sourceId;
    this.#status = status;
    this.#sessionFile = sessionFile;
    this.#eventsFile = eventsFile;
    this.#entries = [];
    this.#entryIds.clear();
    this.#byId.clear();
    this.#sessionEntryIds.clear();
    this.#eventEntryIds.clear();
    this.#sessionLeafId = undefined;
    this.#eventLeafId = undefined;
    this.#sessionId = undefined;
    this.#eventRecords = [];
    this.#resetStreamingState();
    this.#windows.clear();
    this.#revision = 0;
    this.#error = undefined;
    this.#snapshot = undefined;
    for (const [kind, filePath] of this.#windowFiles()) this.#initWindow(kind, filePath);
  }

  #resetStreamingState(): void {
    this.#pendingMessages = undefined;
    this.#streamed.clear();
    this.#streamedOrder = [];
    this.#partial = undefined;
    this.#partialArgsRaw.clear();
    this.#tools.clear();
  }

  #resetEventsState(): void {
    this.#eventRecords = [];
    this.#resetStreamingState();
    this.#eventLeafId = undefined;
    for (const id of this.#eventEntryIds) {
      if (this.#sessionEntryIds.has(id)) continue;
      this.#entryIds.delete(id);
      const entry = this.#byId.get(id);
      if (entry) {
        this.#byId.delete(id);
        const index = this.#entries.indexOf(entry);
        if (index >= 0) this.#entries.splice(index, 1);
      }
    }
    this.#eventEntryIds.clear();
    this.#windows.delete("events");
    this.#error = undefined;
    if (this.#eventsFile) this.#initWindow("events", this.#eventsFile);
  }

  #initWindow(kind: FileKind, filePath: string): void {
    const opened = openDescriptor(filePath);
    if (!opened || "error" in opened) {
      this.#windows.set(kind, {
        head: 0,
        tail: 0,
        size: 0,
        hasOlder: false,
        unavailable: true,
      });
      if (opened && "error" in opened) this.#setError(`${filePath}: ${opened.error}`);
      return;
    }
    try {
      const page = readBackwardPage(opened.descriptor, opened.size, INITIAL_PAGE_BYTES, kind === "events");
      this.#applyRecords(kind, page.records, true);
      this.#windows.set(kind, {
        head: page.start,
        tail: page.end,
        size: opened.size,
        hasOlder: page.start > 0,
        unavailable: false,
      });
    } catch (error) {
      this.#windows.set(kind, {
        head: 0,
        tail: 0,
        size: 0,
        hasOlder: false,
        unavailable: true,
      });
      this.#setError(`${filePath}: ${clipError(error)}`);
    } finally {
      closeQuietly(opened.descriptor);
    }
  }

  #loadOlderFile(kind: FileKind, filePath: string): boolean {
    const window = this.#windows.get(kind);
    if (!window || !window.hasOlder || window.head <= 0) return false;
    const opened = openDescriptor(filePath);
    if (!opened) return false;
    if ("error" in opened) {
      window.unavailable = true;
      this.#setError(`${filePath}: ${opened.error}`);
      return false;
    }
    try {
      const page = readBackwardPage(opened.descriptor, window.head, OLDER_PAGE_BYTES, false);
      if (page.start >= window.head) return false;
      // Older records join the index without moving the authoritative leaf.
      this.#applyRecords(kind, page.records, false);
      window.head = page.start;
      window.hasOlder = page.start > 0;
      window.unavailable = false;
      return true;
    } finally {
      closeQuietly(opened.descriptor);
    }
  }

  #growFile(kind: FileKind, filePath: string, followLatest: boolean): boolean {
    const window = this.#windows.get(kind);
    if (!window) return false;
    const opened = openDescriptor(filePath);
    if (!opened) return false;
    if ("error" in opened) {
      window.unavailable = true;
      this.#setError(`${filePath}: ${opened.error}`);
      return false;
    }
    try {
      window.size = opened.size;
      window.unavailable = false;
      if (!followLatest || opened.size <= window.tail) return false;
      const page = readForwardPage(opened.descriptor, window.tail, opened.size, GROWTH_PAGE_BYTES);
      if (page.end <= window.tail) return false;
      this.#applyRecords(kind, page.records, true);
      window.tail = Math.max(window.tail, page.end);
      return true;
    } finally {
      closeQuietly(opened.descriptor);
    }
  }

  #ingest(followLatest: boolean): void {
    let changed = false;
    for (const [kind, filePath] of this.#windowFiles()) {
      if (this.#growFile(kind, filePath, followLatest)) changed = true;
    }
    if (changed) this.#revision += 1;
    this.#snapshot = this.#buildSnapshot();
  }

  #applyRecords(kind: FileKind, records: string[], updateLeaf: boolean): void {
    const parsed = records.map(parseRecord).filter((record): record is Record<string, unknown> => record !== undefined);
    if (kind === "session") {
      for (const record of parsed) this.#applySessionRecord(record, updateLeaf);
      return;
    }
    if (updateLeaf) {
      this.#eventRecords.push(...parsed);
      for (const record of parsed) this.#applyEventRecord(record);
    } else {
      // Older event pages must prepend in arrival order, not append messages
      // after the live tail or overwrite live queue/partial/tool state.
      this.#eventRecords = [...parsed, ...this.#eventRecords];
      this.#resetStreamingState();
      this.#eventLeafId = undefined;
      for (const record of this.#eventRecords) this.#applyEventRecord(record);
    }
  }

  #applySessionRecord(record: Record<string, unknown>, updateLeaf: boolean): void {
    if (record.type === "session") {
      if (typeof record.id === "string") this.#sessionId = record.id;
      return;
    }
    if (!isSessionEntry(record)) return;
    this.#appendEntry(record, "session", updateLeaf);
  }

  // Entry list order is irrelevant: path construction walks byId from the leaf,
  // so older pages and live folds can append in any order.
  #appendEntry(entry: SessionEntry, origin: "session" | "events", updateLeaf = true): void {
    if (this.#entryIds.has(entry.id)) {
      const existing = this.#byId.get(entry.id);
      if (existing) Object.assign(existing, entry);
      (origin === "session" ? this.#sessionEntryIds : this.#eventEntryIds).add(entry.id);
      if (updateLeaf) {
        if (origin === "session") this.#sessionLeafId = entry.id;
        else this.#eventLeafId = entry.id;
      }
      return;
    }
    this.#entryIds.add(entry.id);
    this.#byId.set(entry.id, entry);
    (origin === "session" ? this.#sessionEntryIds : this.#eventEntryIds).add(entry.id);
    this.#entries.push(entry);
    if (!updateLeaf) return;
    if (origin === "session") this.#sessionLeafId = entry.id;
    else this.#eventLeafId = entry.id;
  }

  #applyEventRecord(event: Record<string, unknown>): void {
    switch (event.type) {
      case "queue_update": {
        const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
        this.#pendingMessages = { steering: strings(event.steering), followUp: strings(event.followUp) };
        return;
      }
      case "message_start": {
        const message = event.message as NativeAgentMessage | undefined;
        if (!message || typeof message !== "object") return;
        if (message.role === "assistant") {
          this.#partial = {
            ...message,
            content: message.content.map((part) => ({ ...part })),
            usage: message.usage ?? emptyUsage(),
            stopReason: message.stopReason && message.stopReason !== "pending" ? message.stopReason : "pending",
          };
        } else {
          this.#foldMessage(message);
        }
        return;
      }
      case "message_update":
        this.#applyPartialDelta(event);
        return;
      case "message_end": {
        const message = event.message as NativeAgentMessage | undefined;
        if (!message || typeof message !== "object") return;
        if (message.role === "assistant") {
          this.#partial = undefined;
          this.#partialArgsRaw.clear();
        }
        this.#foldMessage(message);
        return;
      }
      case "tool_execution_start": {
        if (typeof event.toolCallId !== "string") return;
        const args = event.args as Record<string, unknown> | undefined;
        this.#tools.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          toolName: typeof event.toolName === "string" ? event.toolName : "",
          ...(args !== undefined ? { args } : {}),
          status: "running",
          executionStarted: true,
          argsComplete: true,
        });
        return;
      }
      case "tool_execution_update": {
        const tool = this.#toolFor(event);
        if (!tool) return;
        const partial = event.partialResult as { content?: unknown[]; details?: unknown } | undefined;
        if (partial && typeof partial === "object") {
          tool.partial = {
            ...(Array.isArray(partial.content) ? { content: partial.content } : {}),
            ...(partial.details !== undefined ? { details: partial.details } : {}),
          };
        }
        return;
      }
      case "tool_execution_end": {
        const tool = this.#toolFor(event);
        if (!tool) return;
        const result = event.result as { content?: unknown[]; details?: unknown } | undefined;
        if (result && typeof result === "object") {
          tool.result = {
            ...(Array.isArray(result.content) ? { content: result.content } : {}),
            ...(result.details !== undefined ? { details: result.details } : {}),
          };
        }
        tool.isError = event.isError === true;
        tool.status = event.isError === true ? "failed" : "completed";
        tool.executionStarted = true;
        tool.argsComplete = true;
        return;
      }
      case "turn_end": {
        const message = event.message as NativeAgentMessage | undefined;
        if (message && typeof message === "object") this.#foldMessage(message);
        if (Array.isArray(event.toolResults)) {
          for (const result of event.toolResults) {
            if (result && typeof result === "object") this.#foldMessage(result as NativeAgentMessage);
          }
        }
        return;
      }
      case "agent_end": {
        if (!Array.isArray(event.messages)) return;
        for (const message of event.messages) {
          if (message && typeof message === "object") this.#foldMessage(message as NativeAgentMessage);
        }
        return;
      }
      case "entry_appended": {
        if (isSessionEntry(event.entry)) this.#appendEntry(event.entry, "events");
        return;
      }
      default:
        return;
    }
  }

  #toolFor(event: Record<string, unknown>): NativeToolExecution | undefined {
    if (typeof event.toolCallId !== "string") return undefined;
    return this.#tools.get(event.toolCallId);
  }

  #applyPartialDelta(event: Record<string, unknown>): void {
    const delta = event.assistantMessageEvent as Record<string, unknown> | undefined;
    if (!delta || typeof delta !== "object") return;
    if (!this.#partial) {
      this.#partial = {
        role: "assistant",
        content: [],
        api: "",
        provider: "",
        model: "",
        usage: emptyUsage(),
        stopReason: "pending",
        timestamp: Date.now(),
      };
    }
    const partial = this.#partial;
    if (event.usage && typeof event.usage === "object") {
      partial.usage = event.usage as AssistantMessage["usage"];
    }
    const contentIndex = typeof delta.contentIndex === "number" ? delta.contentIndex : 0;
    switch (delta.type) {
      case "text_start":
        partial.content[contentIndex] = { type: "text", text: "" };
        return;
      case "text_delta": {
        const block = partial.content[contentIndex];
        const text = typeof delta.delta === "string" ? delta.delta : "";
        partial.content[contentIndex] = {
          type: "text",
          text: (block?.type === "text" ? block.text : "") + text,
        };
        return;
      }
      case "text_end": {
        if (typeof delta.content === "string") {
          partial.content[contentIndex] = { type: "text", text: delta.content };
        }
        return;
      }
      case "thinking_start":
        partial.content[contentIndex] = { type: "thinking", thinking: "" };
        return;
      case "thinking_delta": {
        const block = partial.content[contentIndex];
        const text = typeof delta.delta === "string" ? delta.delta : "";
        partial.content[contentIndex] = {
          type: "thinking",
          thinking: (block?.type === "thinking" ? block.thinking : "") + text,
        };
        return;
      }
      case "thinking_end": {
        if (typeof delta.content === "string") {
          partial.content[contentIndex] = { type: "thinking", thinking: delta.content };
        }
        return;
      }
      case "toolcall_start": {
        this.#partialArgsRaw.delete(contentIndex);
        partial.content[contentIndex] = {
          type: "toolCall",
          id: typeof delta.id === "string" ? delta.id : "",
          name: typeof delta.toolName === "string" ? delta.toolName : "",
          arguments: {},
        };
        return;
      }
      case "toolcall_delta": {
        const raw = typeof delta.delta === "string" ? delta.delta : "";
        if (!raw) return;
        const accumulated = (this.#partialArgsRaw.get(contentIndex) ?? "") + raw;
        this.#partialArgsRaw.set(contentIndex, accumulated);
        const parsed = parseRecord(accumulated);
        const block = partial.content[contentIndex];
        if (block?.type === "toolCall" && parsed) block.arguments = parsed;
        return;
      }
      case "toolcall_end": {
        const toolCall = delta.toolCall as AssistantMessage["content"][number] | undefined;
        if (toolCall && typeof toolCall === "object") partial.content[contentIndex] = toolCall;
        this.#partialArgsRaw.delete(contentIndex);
        return;
      }
      default:
        return;
    }
  }

  #foldMessage(message: NativeAgentMessage): void {
    if (!message || typeof message !== "object" || typeof message.role !== "string") return;
    const key = messageKey(message);
    if (this.#streamed.has(key)) return;
    this.#streamed.set(key, message);
    this.#streamedOrder.push(key);
  }

  #buildSnapshot(): NativeConversationTranscript {
    const sessionWindow = this.#windows.get("session");
    const eventsWindow = this.#windows.get("events");
    const hasMore = (sessionWindow?.hasOlder ?? false) || (eventsWindow?.hasOlder ?? false);
    const hasNewer = !this.#followed &&
      ((sessionWindow !== undefined && sessionWindow.tail < sessionWindow.size) ||
        (eventsWindow !== undefined && eventsWindow.tail < eventsWindow.size));
    // The session file is authoritative for the leaf; event-folded entries
    // (entry_appended) only drive it when no session file exists (--no-session
    // retained runs keep their whole tree in the events stream).
    const leafId = this.#sessionLeafId ?? this.#eventLeafId ?? null;
    const pathComplete = leafId !== null && this.#pathReachesRoot(leafId);
    const historyComplete =
      !hasMore && pathComplete && (sessionWindow?.head ?? 0) === 0 && (eventsWindow?.head ?? 0) === 0;

    // Display projection identical to interactive-mode renderSessionItems:
    // compaction-applied active branch, each native entry projected with
    // sessionEntryToContextMessages (compaction → compactionSummary,
    // branch_summary → branchSummary, custom_message → CustomMessage).
    const sessionMessages = leafId !== null
      ? buildContextEntries(this.#entries, leafId, this.#byId).flatMap(sessionEntryToContextMessages)
      : [];
    // Persisted entries remain authoritative even when compaction or a fork
    // removes them from the active display. Never resurrect their RPC copies.
    const persisted = new Set(this.#entries.flatMap((entry) => entry.type === "message" ? [messageKey(entry.message)] : []));
    const streamed = this.#streamedOrder
      .filter((key) => !persisted.has(key))
      .map((key) => this.#streamed.get(key))
      .filter((message): message is NativeAgentMessage => message !== undefined);
    // Live tail messages append after the persisted branch sequence — arrival
    // order, exactly as the events were observed.
    const messages = [...sessionMessages, ...streamed];

    const entries = leafId !== null
      ? buildContextEntries(this.#entries, leafId, this.#byId).map((entry) => ({
        entryId: entry.id,
        parentId: entry.parentId,
        entryType: entry.type,
        timestamp: entry.timestamp,
        ...(entry.type === "message" ? { message: entry.message } : {}),
        entry,
      }))
      : [];

    const tools = [...this.#tools.values()].map((tool) => ({ ...tool }));
    const partialAssistant = this.#partial
      ? { ...this.#partial, content: [...this.#partial.content] }
      : undefined;
    const unavailable: { sessionFile?: boolean; eventsFile?: boolean } = {};
    if (sessionWindow?.unavailable) unavailable.sessionFile = true;
    if (eventsWindow?.unavailable) unavailable.eventsFile = true;
    return {
      messages,
      revision: this.#revision,
      entries,
      streaming: {
        active: partialAssistant !== undefined || tools.some((tool) => tool.status === "running"),
        ...(partialAssistant ? { partialAssistant } : {}),
        tools,
      },
      ...(this.#pendingMessages ? { pendingMessages: { steering: [...this.#pendingMessages.steering], followUp: [...this.#pendingMessages.followUp] } } : {}),
      leafId,
      sourceId: this.#sourceId,
      status: this.#status,
      ...(this.#sessionFile ? { sessionFile: this.#sessionFile } : {}),
      ...(this.#eventsFile ? { eventsFile: this.#eventsFile } : {}),
      ...(this.#sessionId ? { sessionId: this.#sessionId } : {}),
      historyComplete,
      hasMore,
      hasNewer,
      ...(Object.keys(unavailable).length > 0 ? { unavailable } : {}),
      ...(Object.keys(unavailable).length > 0 && this.#error ? { error: this.#error } : {}),
      updatedAt: Date.now(),
    };
  }

  #pathReachesRoot(leafId: string): boolean {
    let current = this.#byId.get(leafId);
    if (!current) return false;
    const guard = new Set<string>();
    while (current.parentId !== null) {
      if (guard.has(current.id)) return true;
      guard.add(current.id);
      const parent = this.#byId.get(current.parentId);
      if (!parent) return false;
      current = parent;
    }
    return true;
  }
}
