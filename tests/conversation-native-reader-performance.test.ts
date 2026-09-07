import "./fixtures/conversation-host.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildContextEntries, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { NativeConversationReader } from "../src/ui/conversation-native-reader.js";
import { NativeReaderEventReplay } from "../src/ui/conversation-native-reader-replay.js";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    buildContextEntries: vi.fn(actual.buildContextEntries),
    sessionEntryToContextMessages: vi.fn(actual.sessionEntryToContextMessages),
  };
});

const directories: string[] = [];
const workspace = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "reader-performance-"));
  directories.push(directory);
  return directory;
};
const jsonl = (records: unknown[]) => records.map((record) => JSON.stringify(record) + "\n").join("");
const user = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp });
const entry = (id: string, parentId: string | null, content: string) => ({
  type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message: user(content, Number(id.slice(1))),
});
const source = (file: string) => ({ id: "reader", status: "running", logFile: file });
const update = (text: string, toolCallId = "tool") => ({
  type: "tool_execution_update", toolCallId, partialResult: { content: [{ type: "text", text }], details: { text } },
});
const start = (toolCallId = "tool") => ({ type: "tool_execution_start", toolCallId, toolName: "bash", args: { command: "test" } });

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("native reader projection caching", () => {
  it("does no historical projection, serialization or content IO on unchanged and metadata-only reads", () => {
    const file = path.join(workspace(), "session.jsonl");
    fs.writeFileSync(file, jsonl([{ type: "session", id: "session" }, ...Array.from({ length: 1000 }, (_, i) => entry(`m${i}`, i ? `m${i - 1}` : null, `message ${i}`))]));
    const reader = new NativeConversationReader();
    const first = reader.read(source(file));
    vi.mocked(buildContextEntries).mockClear();
    vi.mocked(sessionEntryToContextMessages).mockClear();
    const stringify = vi.spyOn(JSON, "stringify");
    const read = vi.spyOn(fs, "readSync");
    for (let i = 0; i < 20; i++) expect(reader.read(source(file))).toBe(first);
    const status = reader.read({ ...source(file), status: "completed" }, false);
    expect(status.messages).toBe(first.messages);
    expect(status.entries).toBe(first.entries);
    expect(status.streaming).toBe(first.streaming);
    expect(status.status).toBe("completed");
    expect(status.revision).toBeGreaterThan(first.revision);
    expect(reader.last).toBe(status);
    expect(buildContextEntries).not.toHaveBeenCalled();
    expect(sessionEntryToContextMessages).not.toHaveBeenCalled();
    expect(stringify).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("projects a branch once per append and keeps historical native message/entry identities", () => {
    const file = path.join(workspace(), "session.jsonl");
    fs.writeFileSync(file, jsonl([{ type: "session", id: "session" }, entry("m0", null, "root"), {
      type: "compaction", id: "c", parentId: "m0", timestamp: "2026-01-01T00:00:00.000Z", summary: "summary", firstKeptEntryId: "m0", tokensBefore: 123,
    }]));
    const reader = new NativeConversationReader();
    const first = reader.read(source(file));
    vi.mocked(buildContextEntries).mockClear();
    vi.mocked(sessionEntryToContextMessages).mockClear();
    fs.appendFileSync(file, jsonl([entry("m3", "c", "append")]));
    const next = reader.read(source(file));
    expect(buildContextEntries).toHaveBeenCalledTimes(1);
    expect(sessionEntryToContextMessages).toHaveBeenCalledTimes(1);
    expect(next.messages[0]).toBe(first.messages[0]);
    expect(next.messages[1]).toBe(first.messages[1]);
    expect(next.entries[0]).toBe(first.entries[0]);
    expect(next.revision).toBeGreaterThan(first.revision);
  });

  it("reuses history and untouched tools during cumulative progress and queue changes", () => {
    const file = path.join(workspace(), "events.jsonl");
    fs.writeFileSync(file, jsonl([{ type: "message_end", message: user("history", 1) }, start(), start("other"), update("before")]));
    const reader = new NativeConversationReader();
    const first = reader.read(source(file));
    fs.appendFileSync(file, jsonl([update("after"), { type: "queue_update", steering: ["next"], followUp: [] }]));
    const second = reader.read(source(file));
    expect(second.messages).toBe(first.messages);
    expect(second.entries).toBe(first.entries);
    expect(second.streaming.tools[1]).toBe(first.streaming.tools[1]);
    expect(second.streaming.tools[0]).not.toBe(first.streaming.tools[0]);
    expect(first.streaming.tools[0]?.partial?.content).toEqual([{ type: "text", text: "before" }]);
    expect(second.pendingMessages?.steering).toEqual(["next"]);
    expect(reader.read(source(file))).toBe(second);
  });

  it("keeps cached logFile history unavailable, updates pinned flags and observes recovery", () => {
    const file = path.join(workspace(), "session.jsonl");
    const records = [{ type: "session", id: "session" }, entry("m0", null, "cached")];
    fs.writeFileSync(file, jsonl(records));
    const reader = new NativeConversationReader();
    const first = reader.read(source(file), false);
    fs.unlinkSync(file);
    const missing = reader.read(source(file), false);
    expect(missing.messages).toBe(first.messages);
    expect(missing.unavailable?.sessionFile).toBe(true);
    expect(missing.error).toBeDefined();
    expect(missing.revision).toBeGreaterThan(first.revision);
    expect(reader.read(source(file), false)).toBe(missing);
    fs.writeFileSync(file, jsonl([...records, entry("m1", "m0", "new")]));
    const pinned = reader.read(source(file), false);
    expect(pinned.messages).toBe(first.messages);
    expect(pinned.hasNewer).toBe(true);
    expect(pinned.unavailable).toBeUndefined();
    expect(pinned.error).toBeUndefined();
    expect(pinned.revision).toBeGreaterThan(missing.revision);
    const newer = reader.loadNewer()!;
    expect(newer.messages).toHaveLength(2);
    expect(newer.hasNewer).toBe(false);
    expect(newer.revision).toBeGreaterThan(pinned.revision);
    reader.clear();
    expect(reader.last).toBeUndefined();
    expect(reader.read(source(file)).revision).toBeGreaterThan(newer.revision);
  });
});

describe("native reader compact replay", () => {
  it("retains final-sized payload rather than 1000 obsolete cumulative snapshots", () => {
    const replay = new NativeReaderEventReplay([start()]);
    for (let i = 1; i <= 1000; i++) replay.append(update("x".repeat(i * 64)));
    replay.append({ type: "tool_execution_end", toolCallId: "tool", result: { content: [{ type: "text", text: "x".repeat(64000) }] } });
    const retained = [...replay.records()];
    expect(retained).toHaveLength(3);
    expect(JSON.stringify(retained).length).toBeLessThan(194000);
    expect(retained[1]).toEqual(update("x".repeat(64000)));
  });

  it("preserves exact prepend replay through absent starts, resets, malformed updates and large records", () => {
    const directory = workspace();
    const liveFile = path.join(directory, "live.events.jsonl");
    const pagedFile = path.join(directory, "paged.events.jsonl");
    const records = [
      { type: "message_end", message: user("old " + "u".repeat(300000), 1) },
      start(), update("obsolete"), start("other"),
      { type: "queue_update", steering: ["old"], followUp: [] },
      start(), update("x".repeat(300000)),
      { type: "message_end", message: user("new", 2) },
      update("latest"), { type: "tool_execution_update", toolCallId: "tool", partialResult: null },
      { type: "tool_execution_end", toolCallId: "tool", result: { content: [{ type: "image", data: "image", mimeType: "image/png" }], details: { final: true } }, isError: true },
      update("other partial", "other"),
      { type: "queue_update", steering: ["latest"], followUp: ["later"] },
    ];
    fs.writeFileSync(liveFile, "");
    const live = new NativeConversationReader();
    live.read(source(liveFile));
    for (const record of records) {
      fs.appendFileSync(liveFile, jsonl([record]));
      live.read(source(liveFile));
    }
    fs.writeFileSync(pagedFile, jsonl(records));
    const reader = new NativeConversationReader();
    let paged = reader.read(source(pagedFile));
    expect(paged.hasMore).toBe(true);
    for (let i = 0; paged.hasMore && i < 10; i++) paged = reader.loadOlder()!;
    expect(paged.hasMore).toBe(false);
    expect(paged.messages).toEqual(live.last!.messages);
    expect(paged.streaming).toEqual(live.last!.streaming);
    expect(paged.pendingMessages).toEqual(live.last!.pendingMessages);
  });

  it("replays no-session branches and compaction entries without resurrecting RPC copies", () => {
    const file = path.join(workspace(), "events.jsonl");
    const abandoned = entry("m1", "m0", "abandoned");
    fs.writeFileSync(file, jsonl([
      { type: "entry_appended", entry: entry("m0", null, "root " + "r".repeat(300000)) },
      { type: "entry_appended", entry: abandoned },
      { type: "message_end", message: abandoned.message },
      { type: "entry_appended", entry: { type: "compaction", id: "c", parentId: "m0", timestamp: "2026-01-01T00:00:00.000Z", summary: "checkpoint", firstKeptEntryId: "m0", tokensBefore: 100 } },
      { type: "entry_appended", entry: entry("m3", "c", "current") },
    ]));
    const reader = new NativeConversationReader();
    let result = reader.read(source(file));
    for (let i = 0; result.hasMore && i < 5; i++) result = reader.loadOlder()!;
    expect(result.historyComplete).toBe(true);
    expect(result.leafId).toBe("m3");
    expect(result.messages.map((message) => message.role)).toEqual(["compactionSummary", "user", "user"]);
    expect(JSON.stringify(result.messages)).not.toContain("abandoned");
  });

  it("does not consume an incomplete first record and preserves UTF-8/whole forward records", () => {
    const file = path.join(workspace(), "events.jsonl");
    fs.writeFileSync(file, '{"type":"message_end","message":');
    const reader = new NativeConversationReader();
    expect(reader.read(source(file)).messages).toEqual([]);
    const message = user("🙂\u2028".repeat(300000), 1);
    fs.appendFileSync(file, JSON.stringify(message) + "}\r\n");
    expect(reader.read(source(file)).messages).toEqual([message]);
  });
});
