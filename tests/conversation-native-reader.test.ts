import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NativeConversationReader,
  type NativeAgentMessage,
  type NativeConversationSource,
} from "../src/ui/conversation-native-reader.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const makeWorkspace = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-reader-"));
  temporaryDirectories.push(directory);
  return directory;
};

const jsonl = (lines: unknown[]): string => lines.map((line) => `${JSON.stringify(line)}\n`).join("");

const writeSession = (directory: string, entries: unknown[]): string => {
  const file = path.join(directory, "session.jsonl");
  fs.writeFileSync(file, jsonl(entries), "utf8");
  return file;
};

const entryBase = (id: string, parentId: string | null, timestamp = "2026-01-01T00:00:00.000Z") => ({
  type: "",
  id,
  parentId,
  timestamp,
});

const sessionHeader = {
  type: "session",
  version: 3,
  id: "session-uuid-1",
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/tmp/project",
};

const assistantMessage = (text: string, timestamp: number, toolCallId?: string) => ({
  role: "assistant",
  content: [
    { type: "thinking", thinking: `thinking about ${text}` },
    { type: "text", text },
    ...(toolCallId
      ? [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: `run ${text}` } }]
      : []),
  ],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-test",
  usage: {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: toolCallId ? "toolUse" : "stop",
  timestamp,
});

const toolResultMessage = (toolCallId: string, text: string, timestamp: number, isError = false) => ({
  role: "toolResult",
  toolCallId,
  toolName: "bash",
  content: [{ type: "text", text }],
  details: { exitCode: isError ? 1 : 0, fullAudits: [{ nested: true }] },
  isError,
  timestamp,
});

const source = (overrides: Partial<NativeConversationSource> = {}): NativeConversationSource => ({
  id: "participant-1",
  status: "running",
  ...overrides,
});

describe("native conversation reader — session file history", () => {
  it("loads the full native message union with branch and compaction semantics", () => {
    const directory = makeWorkspace();
    const file = writeSession(directory, [
      sessionHeader,
      { ...entryBase("m1", null), type: "message", message: { role: "user", content: "hello", timestamp: 1 } },
      { ...entryBase("m2", "m1"), type: "message", message: assistantMessage("hi", 2) },
      // Abandoned branch off m2.
      { ...entryBase("m3a", "m2"), type: "message", message: { role: "user", content: "branch A", timestamp: 3 } },
      // Active branch with a compaction checkpoint.
      {
        ...entryBase("m3", "m2"),
        type: "compaction",
        summary: "earlier talk summarized",
        firstKeptEntryId: "m2",
        tokensBefore: 1234,
      },
      {
        ...entryBase("m4", "m3"),
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "with image" }, { type: "image", data: "base64", mimeType: "image/png" }], timestamp: 4 },
      },
      {
        ...entryBase("m5", "m4"),
        type: "custom_message",
        customType: "my-ext",
        content: "injected context",
        display: true,
      },
      {
        ...entryBase("m6", "m5"),
        type: "message",
        message: assistantMessage("done", 6, "call_1"),
      },
      {
        ...entryBase("m7", "m6"),
        type: "message",
        message: toolResultMessage("call_1", "output", 7),
      },
      { ...entryBase("m8", "m7"), type: "custom", customType: "tps", data: { tokens: 42 } },
    ]);

    const transcript = new NativeConversationReader().read(source({ logFile: file }));

    expect(transcript.leafId).toBe("m8");
    expect(transcript.sessionId).toBe("session-uuid-1");
    expect(transcript.historyComplete).toBe(true);
    expect(transcript.hasMore).toBe(false);

    // Active branch only, native buildContextEntries projection: the
    // compaction summary leads, kept entries (from firstKeptEntryId) and
    // everything after the compaction follow; the abandoned m3a path and the
    // summarized-away m1 are excluded.
    const roles = transcript.messages.map((message) => message.role);
    expect(roles).toEqual([
      "compactionSummary",
      "assistant",
      "user",
      "custom",
      "assistant",
      "toolResult",
    ]);

    const compaction = transcript.messages.find((message) => message.role === "compactionSummary");
    expect(compaction).toMatchObject({ summary: "earlier talk summarized", tokensBefore: 1234 });

    const user = transcript.messages.find((message) => message.role === "user" && message.timestamp === 4) as
      | Extract<NativeAgentMessage, { role: "user" }>
      | undefined;
    expect(user?.content).toEqual([
      { type: "text", text: "with image" },
      { type: "image", data: "base64", mimeType: "image/png" },
    ]);

    const assistant = transcript.messages.at(-2);
    expect(assistant).toMatchObject({ role: "assistant", model: "claude-test", stopReason: "toolUse" });
    expect(JSON.stringify(assistant)).toContain('"command":"run done"');

    const result = transcript.messages.at(-1);
    expect(result).toMatchObject({ role: "toolResult", toolCallId: "call_1", isError: false });
    expect(JSON.stringify(result)).toContain('"fullAudits"');

    // Native entries view keeps whole entries (compaction-applied active path,
    // custom state entry included; summarized-away entries excluded).
    expect(transcript.entries.map((view) => view.entryType)).toEqual([
      "compaction",
      "message",
      "message",
      "custom_message",
      "message",
      "message",
      "custom",
    ]);
  });

  it("follows the active leaf after a branch, honoring branch summaries", () => {
    const directory = makeWorkspace();
    const file = writeSession(directory, [
      sessionHeader,
      { ...entryBase("a1", null), type: "message", message: { role: "user", content: "root", timestamp: 1 } },
      { ...entryBase("a2", "a1"), type: "message", message: assistantMessage("old", 2) },
      { ...entryBase("a3", "a2"), type: "message", message: { role: "user", content: "abandoned", timestamp: 3 } },
      {
        ...entryBase("b1", "a1"),
        type: "branch_summary",
        fromId: "a3",
        summary: "came back from a branch",
      },
      { ...entryBase("b2", "b1"), type: "message", message: { role: "user", content: "fresh", timestamp: 5 } },
    ]);

    const transcript = new NativeConversationReader().read(source({ logFile: file }));
    expect(transcript.leafId).toBe("b2");
    const roles = transcript.messages.map((message) => message.role);
    expect(roles).toEqual(["user", "branchSummary", "user"]);
    expect(transcript.messages[1]).toMatchObject({ summary: "came back from a branch", fromId: "a3" });
  });

  it("reports a session file passed as logFile (retained actor fallback)", () => {
    const directory = makeWorkspace();
    const file = writeSession(directory, [
      sessionHeader,
      { ...entryBase("x1", null), type: "message", message: { role: "user", content: "retained", timestamp: 1 } },
    ]);
    const transcript = new NativeConversationReader().read(source({ logFile: file }));
    expect(transcript.sessionFile).toBe(file);
    expect(transcript.messages).toHaveLength(1);
    expect(transcript.messages[0]).toMatchObject({ role: "user", content: "retained" });
  });
});

describe("native conversation reader — RPC event streaming", () => {
  it("reconstructs messages and tool lifecycle from events alone with full details", () => {
    const directory = makeWorkspace();
    const events = path.join(directory, "events.jsonl");
    fs.writeFileSync(
      events,
      jsonl([
        { type: "agent_start" },
        { type: "message_start", message: { role: "user", content: "go", timestamp: 10 } },
        { type: "message_end", message: { role: "user", content: "go", timestamp: 10 } },
        { type: "message_start", message: { role: "assistant", content: [], api: "anthropic-messages", provider: "anthropic", model: "m", usage: {}, stopReason: "pending", timestamp: 11 } },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" } },
        {
          type: "tool_execution_start",
          toolCallId: "call_9",
          toolName: "fabric_exec",
          args: { code: "await pi.read()" },
        },
        {
          type: "tool_execution_update",
          toolCallId: "call_9",
          partialResult: { content: [{ type: "text", text: "partial" }], details: { progress: "running", audits: [{ nestedToolCallId: "fabric_1", args: { path: "x" } }] } },
        },
        {
          type: "tool_execution_end",
          toolCallId: "call_9",
          result: { content: [{ type: "text", text: "full output" }], details: { audits: [{ nestedToolCallId: "fabric_1" }] } },
          isError: false,
        },
        {
          type: "message_end",
          message: assistantMessage("hello", 12, "call_9"),
        },
        {
          type: "message_end",
          message: toolResultMessage("call_9", "full output", 13),
        },
        { type: "agent_end", messages: [{ role: "bashExecution", command: "ls", output: "files", exitCode: 0, cancelled: false, truncated: false, timestamp: 14 }] },
      ]),
      "utf8",
    );

    const reader = new NativeConversationReader();
    const transcript = reader.read(source({ logFile: events }));

    expect(transcript.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "bashExecution",
    ]);
    expect(transcript.messages.find((message) => message.role === "assistant")).toMatchObject({
      stopReason: "toolUse",
    });
    expect(JSON.stringify(transcript.messages)).toContain('"command":"run hello"');

    const tool = transcript.streaming.tools.find((entry) => entry.toolCallId === "call_9");
    expect(tool).toMatchObject({
      toolName: "fabric_exec",
      status: "completed",
      executionStarted: true,
      argsComplete: true,
      isError: false,
    });
    expect(tool?.args).toEqual({ code: "await pi.read()" });
    expect(JSON.stringify(tool?.result)).toContain("fabric_1");
    expect(JSON.stringify(tool?.partial)).toContain("nestedToolCallId");
    expect(transcript.streaming.active).toBe(false);
  });

  it("assembles a live partial assistant from streaming deltas", () => {
    const directory = makeWorkspace();
    const events = path.join(directory, "events.jsonl");
    fs.writeFileSync(
      events,
      jsonl([
        { type: "agent_start" },
        {
          type: "message_start",
          message: { role: "assistant", content: [], api: "anthropic-messages", provider: "anthropic", model: "m", usage: {}, stopReason: "pending", timestamp: 20 },
        },
        { type: "message_update", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm" } },
        { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "we" } },
        { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "ll" } },
        { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, id: "call_live", toolName: "read" } },
        { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: '{"pa' } },
        { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: 'th":"a.ts"}' } },
      ]),
      "utf8",
    );

    const transcript = new NativeConversationReader().read(source({ logFile: events }));
    expect(transcript.streaming.active).toBe(true);
    const partial = transcript.streaming.partialAssistant;
    expect(partial?.stopReason).toBe("pending");
    expect(partial?.content[0]).toMatchObject({ type: "thinking", thinking: "hmm" });
    expect(partial?.content[1]).toMatchObject({ type: "text", text: "well" });
    expect(partial?.content[2]).toMatchObject({
      type: "toolCall",
      id: "call_live",
      name: "read",
      arguments: { path: "a.ts" },
    });
  });

  it("deduplicates streamed messages once the session file persists them", () => {
    const directory = makeWorkspace();
    const events = path.join(directory, "events.jsonl");
    const session = writeSession(directory, [
      sessionHeader,
      { ...entryBase("s1", null), type: "message", message: { role: "user", content: "go", timestamp: 10 } },
      { ...entryBase("s2", "s1"), type: "message", message: assistantMessage("hello", 12, "call_9") },
    ]);
    fs.writeFileSync(
      events,
      jsonl([
        { type: "message_end", message: { role: "user", content: "go", timestamp: 10 } },
        { type: "message_end", message: assistantMessage("hello", 12, "call_9") },
        { type: "message_end", message: { role: "user", content: "go", timestamp: 10 } },
      ]),
      "utf8",
    );

    const transcript = new NativeConversationReader().read(
      source({ sessionFile: session, eventsFile: events, logFile: events }),
    );
    const userMessages = transcript.messages.filter((message) => message.role === "user");
    const assistantMessages = transcript.messages.filter((message) => message.role === "assistant");
    expect(userMessages).toHaveLength(1);
    expect(assistantMessages).toHaveLength(1);
  });
});

describe("native conversation reader — paging and rollover", () => {
  it("pages whole records backward via loadOlder until history is complete", () => {
    const directory = makeWorkspace();
    const entries: unknown[] = [sessionHeader];
    for (let index = 0; index < 500; index++) {
      entries.push({
        ...entryBase(`p${index}`, index === 0 ? null : `p${index - 1}`),
        type: "message",
        message: { role: "user", content: `message ${index} ${"x".repeat(500)}`, timestamp: index },
      });
    }
    const file = writeSession(directory, entries);

    const reader = new NativeConversationReader();
    const first = reader.read(source({ sessionFile: file }));
    expect(first.messages.length).toBeLessThan(500);
    expect(first.hasMore).toBe(true);
    expect(first.historyComplete).toBe(false);
    // Newest visible message must be intact (whole records, no clipping).
    expect(JSON.stringify(first.messages.at(-1))).toContain("message 499");

    let transcript = first;
    let rounds = 0;
    while (transcript.hasMore && rounds < 50) {
      const older = reader.loadOlder();
      if (!older) break;
      transcript = older;
      rounds += 1;
    }
    expect(transcript.historyComplete).toBe(true);
    expect(transcript.messages).toHaveLength(500);
    expect(transcript.messages[0]).toMatchObject({ role: "user" });
    expect(JSON.stringify(transcript.messages[0])).toContain("message 0 ");
    expect(JSON.stringify(transcript.messages.at(-1))).toContain("message 499");
  });

  it("loads giant single records whole without clipping fields", () => {
    const directory = makeWorkspace();
    const huge = "y".repeat(1024 * 1024);
    const file = writeSession(directory, [
      sessionHeader,
      {
        ...entryBase("g1", null),
        type: "message",
        message: { role: "user", content: `huge ${huge}`, timestamp: 1 },
      },
    ]);
    const transcript = new NativeConversationReader().read(source({ sessionFile: file }));
    expect(JSON.stringify(transcript.messages[0])).toContain(huge);
  });

  it("grows forward when the session file appends and preserves pinned history on events rollover", async () => {
    const directory = makeWorkspace();
    const session = path.join(directory, "session.jsonl");
    fs.writeFileSync(
      session,
      jsonl([
        sessionHeader,
        { ...entryBase("r1", null), type: "message", message: { role: "user", content: "root", timestamp: 1 } },
      ]),
      "utf8",
    );
    const runOne = path.join(directory, "run-1.events.jsonl");
    fs.writeFileSync(
      runOne,
      jsonl([{ type: "message_end", message: { role: "user", content: "go", timestamp: 10 } }]),
      "utf8",
    );

    const reader = new NativeConversationReader();
    const first = reader.read(source({ sessionFile: session, logFile: runOne }));
    expect(first.messages.map((message) => message.role)).toEqual(["user", "user"]);
    expect(first.eventsFile).toBe(runOne);

    // Next activation: new run events file, same stable participant + session.
    const runTwo = path.join(directory, "run-2.events.jsonl");
    fs.writeFileSync(
      runTwo,
      jsonl([
        { type: "message_end", message: { role: "user", content: "second run", timestamp: 20 } },
        { type: "entry_appended", entry: { type: "custom", id: "c1", parentId: "r1", timestamp: "2026-01-01T00:00:01.000Z", customType: "tps", data: { ok: true } } },
      ]),
      "utf8",
    );

    const second = reader.read(source({ sessionFile: session, logFile: runTwo }));
    expect(second.eventsFile).toBe(runTwo);
    expect(second.messages.some((message) => message.role === "user" && message.content === "root")).toBe(true);
    expect(second.messages.some((message) => message.role === "user" && message.content === "go")).toBe(false);
    expect(second.messages.some((message) => message.role === "user" && message.content === "second run")).toBe(true);

    // Session file growth is picked up on later reads.
    fs.appendFileSync(
      session,
      jsonl([{ ...entryBase("r2", "r1"), type: "message", message: assistantMessage("reply", 30) }]),
      "utf8",
    );
    const third = reader.read(source({ sessionFile: session, logFile: runTwo }));
    expect(third.messages.some((message) => message.role === "assistant")).toBe(true);
    expect(third.leafId).toBe("r2");
    expect(third.revision).toBeGreaterThan(second.revision);
  });
});

describe("native conversation reader — unavailable files", () => {
  it("reports unreadable sources through bounded fields without throwing", () => {
    const reader = new NativeConversationReader();
    const missing = path.join(makeWorkspace(), "does-not-exist.jsonl");
    const transcript = reader.read(source({ logFile: missing }));
    expect(transcript.messages).toEqual([]);
    expect(transcript.unavailable?.eventsFile).toBe(true);
    expect(transcript.error).toBeDefined();
    expect(transcript.error?.length).toBeLessThanOrEqual(201);

    const directory = makeWorkspace();
    const directorySource = source({ logFile: directory });
    const second = reader.read(directorySource);
    expect(second.unavailable).toBeDefined();
    expect(second.messages).toEqual([]);
  });
});

describe("native conversation reader — replay authority", () => {
  it("shows user starts immediately and exposes authoritative queue_update data", () => {
    const file = path.join(makeWorkspace(), "events.jsonl");
    const message = { role: "user", content: "delivered", timestamp: 1 };
    fs.writeFileSync(file, jsonl([{ type: "message_start", message }, { type: "queue_update", steering: ["next"], followUp: ["later"] }]));
    const reader = new NativeConversationReader();
    const first = reader.read(source({ logFile: file }));
    expect(first.messages).toEqual([message]);
    expect(first.pendingMessages).toEqual({ steering: ["next"], followUp: ["later"] });
    fs.appendFileSync(file, jsonl([{ type: "message_end", message }, { type: "queue_update", steering: [], followUp: [] }]));
    const second = reader.read(source({ logFile: file }));
    expect(second.messages).toEqual([message]);
    expect(second.pendingMessages).toEqual({ steering: [], followUp: [] });
  });

  it("prepends older RPC pages in order without replacing the latest queue", () => {
    const file = path.join(makeWorkspace(), "events.jsonl");
    const messages = Array.from({ length: 100 }, (_, index) => ({ role: "user", content: `${index}: ${"x".repeat(5000)}`, timestamp: index + 1 }));
    fs.writeFileSync(file, jsonl([{ type: "queue_update", steering: ["old"], followUp: [] }, ...messages.map((message) => ({ type: "message_end", message })), { type: "queue_update", steering: ["current"], followUp: [] }]));
    const reader = new NativeConversationReader();
    let snapshot = reader.read(source({ logFile: file }));
    expect(snapshot.hasMore).toBe(true);
    for (let page = 0; snapshot.hasMore && page < 5; page++) snapshot = reader.loadOlder()!;
    expect(snapshot.messages).toEqual(messages);
    expect(snapshot.pendingMessages?.steering).toEqual(["current"]);
  });

  it("does not resurrect an abandoned branch from overlapping RPC messages", () => {
    const directory = makeWorkspace();
    const old = assistantMessage("abandoned branch", 2);
    const session = writeSession(directory, [sessionHeader,
      { ...entryBase("root", null), type: "message", message: { role: "user", content: "root", timestamp: 1 } },
      { ...entryBase("old", "root"), type: "message", message: old },
      { ...entryBase("new", "root"), type: "message", message: assistantMessage("active branch", 3) },
    ]);
    const events = path.join(directory, "events.jsonl");
    fs.writeFileSync(events, jsonl([{ type: "message_end", message: old }]));
    const snapshot = new NativeConversationReader().read(source({ sessionFile: session, logFile: events }));
    expect(JSON.stringify(snapshot.messages)).not.toContain("abandoned branch");
    expect(JSON.stringify(snapshot.messages)).toContain("active branch");
  });
});

describe("native conversation reader — lifecycle", () => {
  it("clear() resets all state and re-reads cleanly", () => {
    const directory = makeWorkspace();
    const file = writeSession(directory, [
      sessionHeader,
      { ...entryBase("z1", null), type: "message", message: { role: "user", content: "clear-me", timestamp: 1 } },
    ]);
    const reader = new NativeConversationReader();
    expect(reader.read(source({ sessionFile: file })).messages).toHaveLength(1);
    reader.clear();
    expect(reader.last).toBeUndefined();
    const transcript = reader.read(source({ sessionFile: file }));
    expect(transcript.messages).toHaveLength(1);
    expect(transcript.revision).toBe(0);
  });

  it("pinned reads report hasNewer and loadNewer consumes them", () => {
    const directory = makeWorkspace();
    const file = writeSession(directory, [
      sessionHeader,
      { ...entryBase("w1", null), type: "message", message: { role: "user", content: "first", timestamp: 1 } },
    ]);
    const reader = new NativeConversationReader();
    const pinned = reader.read(source({ sessionFile: file }), false);
    expect(pinned.hasNewer).toBe(false);

    fs.appendFileSync(
      file,
      jsonl([{ ...entryBase("w2", "w1"), type: "message", message: { role: "user", content: "second", timestamp: 2 } }]),
      "utf8",
    );
    const stale = reader.read(source({ sessionFile: file }), false);
    expect(stale.hasNewer).toBe(true);
    expect(stale.messages).toHaveLength(1);

    const newer = reader.loadNewer();
    expect(newer?.hasNewer).toBe(false);
    expect(newer?.messages).toHaveLength(2);
  });
});
