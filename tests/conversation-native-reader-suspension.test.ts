import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeConversationReader, type NativeConversationTranscript } from "../src/ui/conversation-native-reader.js";
import { NativeReaderCheckpoint } from "../src/ui/conversation-native-reader-checkpoint.js";

const directories: string[] = [];
const workspace = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "reader-suspension-"));
  directories.push(directory);
  return directory;
};
const jsonl = (records: unknown[]) => records.map((record) => JSON.stringify(record) + "\n").join("");
const entry = (i: number, length = 5000) => ({
  type: "message", id: `m${i}`, parentId: i ? `m${i - 1}` : null,
  timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: `${i}:` + "x".repeat(length), timestamp: i },
});
const header = { type: "session", id: "session" };
const source = (file: string) => ({ id: "reader", status: "running", logFile: file });
const content = (snapshot: NativeConversationTranscript) => ({ messages: snapshot.messages, entries: snapshot.entries, streaming: snapshot.streaming, pendingMessages: snapshot.pendingMessages, leafId: snapshot.leafId, hasMore: snapshot.hasMore, hasNewer: snapshot.hasNewer, historyComplete: snapshot.historyComplete });
const trackCheckpoints = () => {
  const original = fs.mkdtempSync.bind(fs);
  return vi.spyOn(fs, "mkdtempSync").mockImplementation(((prefix: string) => {
    const directory = original(prefix);
    directories.push(directory);
    return directory;
  }) as typeof fs.mkdtempSync);
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("native reader disk suspension", () => {
  it("checkpoints only final-sized live tool state and replays older pages exactly after resume", () => {
    const file = path.join(workspace(), "events.jsonl");
    const oldMessage = { role: "user", content: "old" + "o".repeat(300000), timestamp: 1 };
    fs.writeFileSync(file, jsonl([
      { type: "message_end", message: oldMessage },
      { type: "tool_execution_start", toolCallId: "tool", toolName: "bash", args: { command: "test" } },
    ]));
    const reader = new NativeConversationReader();
    expect(reader.read(source(file)).hasMore).toBe(true);
    for (let i = 1; i <= 1000; i++) {
      fs.appendFileSync(file, jsonl([{ type: "tool_execution_update", toolCallId: "tool", partialResult: { content: [{ type: "text", text: "x".repeat(i * 64) }] } }]));
      reader.read(source(file));
    }
    fs.appendFileSync(file, jsonl([{ type: "tool_execution_end", toolCallId: "tool", result: { content: [{ type: "text", text: "x".repeat(64000) }] } }]));
    const completed = reader.read(source(file));
    const temporary = trackCheckpoints();
    reader.suspend();
    const checkpoint = path.join(temporary.mock.results[0]!.value as string, "checkpoint");
    expect(fs.statSync(file).size).toBeGreaterThan(32000000);
    expect(fs.statSync(checkpoint).size).toBeLessThan(140000);
    const older = reader.loadOlder()!;
    expect(older.messages).toEqual([oldMessage]);
    expect(older.streaming).toEqual(completed.streaming);
    expect(older.hasMore).toBe(false);
  });

  it("offloads to one private file and restores loaded/pinned history without original files", () => {
    const file = path.join(workspace(), "session.jsonl");
    const records = [header, ...Array.from({ length: 150 }, (_, i) => entry(i))];
    fs.writeFileSync(file, jsonl(records));
    const reader = new NativeConversationReader();
    reader.read(source(file), false);
    reader.loadOlder();
    fs.appendFileSync(file, jsonl([entry(150)]));
    const pinned = reader.read(source(file), false);
    expect(pinned.hasMore).toBe(true);
    expect(pinned.hasNewer).toBe(true);
    const temporary = trackCheckpoints();
    const restore = vi.spyOn(NativeReaderCheckpoint.prototype, "restore");
    expect(reader.suspend()).toBe(true);
    expect(reader.suspended).toBe(true);
    expect(reader.suspend()).toBe(true);
    expect(restore).not.toHaveBeenCalled();
    const directory = temporary.mock.results[0]!.value as string;
    expect(fs.readdirSync(directory)).toEqual(["checkpoint"]);
    const checkpoint = path.join(directory, "checkpoint");
    // Windows accepts chmod/mode options but does not expose POSIX permission bits.
    if (process.platform !== "win32") {
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
      expect(fs.statSync(checkpoint).mode & 0o777).toBe(0o600);
    }
    expect(fs.statSync(checkpoint).size).toBeGreaterThan(256000);
    fs.unlinkSync(file);
    const resumed = reader.last!;
    expect(content(resumed)).toEqual(content(pinned));
    expect(resumed.revision).toBeGreaterThan(pinned.revision);
    expect(reader.suspended).toBe(false);
    expect(fs.existsSync(directory)).toBe(false);
    const unavailable = reader.read(source(file), false);
    expect(unavailable.messages).toBe(resumed.messages);
    expect(unavailable.unavailable?.sessionFile).toBe(true);
    expect(reader.suspend()).toBe(true);
    expect(content(reader.last!)).toEqual(content(unavailable));
    fs.writeFileSync(file, jsonl([...records, entry(150)]));
    expect(reader.read(source(file), false).messages).toHaveLength(pinned.messages.length);
    expect(reader.loadNewer()!.messages).toHaveLength(pinned.messages.length + 1);
    expect(reader.suspend()).toBe(true);
    expect(reader.loadOlder()!.historyComplete).toBe(true);
    reader.clear();
  });

  it.each(["missing", "corrupt"])("recovers a %s checkpoint from exact loaded byte ranges, not the latest tail", (failure) => {
    const file = path.join(workspace(), "session.jsonl");
    fs.writeFileSync(file, jsonl([header, ...Array.from({ length: 200 }, (_, i) => entry(i))]));
    const reader = new NativeConversationReader();
    reader.read(source(file), false);
    reader.loadOlder();
    fs.appendFileSync(file, jsonl([entry(200)]));
    const before = reader.read(source(file), false);
    const temporary = trackCheckpoints();
    expect(reader.suspend()).toBe(true);
    const checkpoint = path.join(temporary.mock.results[0]!.value as string, "checkpoint");
    if (failure === "missing") fs.unlinkSync(checkpoint);
    else fs.writeFileSync(checkpoint, "corrupt");
    const restored = reader.last!;
    expect(content(restored)).toEqual(content(before));
    expect(restored.error).toBeUndefined();
    expect(reader.suspended).toBe(false);
    expect(reader.loadNewer()!.messages).toHaveLength(before.messages.length + 1);
  });

  it("reports lost backing data without dropping bookmarks and retries the same pinned range", () => {
    const file = path.join(workspace(), "session.jsonl");
    const records = [header, ...Array.from({ length: 100 }, (_, i) => entry(i))];
    fs.writeFileSync(file, jsonl(records));
    const reader = new NativeConversationReader();
    const before = reader.read(source(file), false);
    const temporary = trackCheckpoints();
    expect(reader.suspend()).toBe(true);
    const checkpoint = path.join(temporary.mock.results[0]!.value as string, "checkpoint");
    fs.unlinkSync(checkpoint);
    fs.unlinkSync(file);
    const failed = reader.read(source(file), false);
    expect(failed.error).toContain("Unable to restore reader history");
    expect(failed.error!.length).toBeLessThanOrEqual(201);
    expect(failed.unavailable?.sessionFile).toBe(true);
    expect(reader.suspended).toBe(true);
    expect(reader.last).toBe(failed);
    const settled = reader.read({ ...source(file), status: "completed" }, false);
    expect(settled.status).toBe("completed");
    expect(settled.revision).toBeGreaterThan(failed.revision);
    expect(settled.error).toBe(failed.error);
    fs.writeFileSync(file, jsonl([...records, entry(100)]));
    const restored = reader.last!;
    expect(content(restored)).toEqual(content(before));
    expect(reader.suspended).toBe(false);
    expect(restored.revision).toBeGreaterThan(failed.revision);
    expect(reader.read(source(file), false).hasNewer).toBe(true);
  });

  it("retains usable live state on checkpoint write or publish failure", () => {
    const file = path.join(workspace(), "session.jsonl");
    fs.writeFileSync(file, jsonl([header, entry(0)]));
    const reader = new NativeConversationReader();
    const before = reader.read(source(file));
    const temporary = trackCheckpoints();
    const write = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => { throw new Error("full disk"); });
    expect(reader.suspend()).toBe(false);
    expect(reader.suspended).toBe(false);
    expect(reader.last).toBe(before);
    expect(fs.existsSync(temporary.mock.results[0]!.value as string)).toBe(false);
    write.mockRestore();
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("publish failed"); });
    expect(reader.suspend()).toBe(false);
    expect(reader.last).toBe(before);
    expect(fs.existsSync(temporary.mock.results[1]!.value as string)).toBe(false);
  });

  it("cleans up without resuming on clear/source replacement and tolerates cleanup errors", () => {
    const file = path.join(workspace(), "session.jsonl");
    fs.writeFileSync(file, jsonl([header, entry(0)]));
    const reader = new NativeConversationReader();
    reader.read(source(file));
    const temporary = trackCheckpoints();
    const restore = vi.spyOn(NativeReaderCheckpoint.prototype, "restore");
    expect(reader.suspend()).toBe(true);
    reader.clear();
    expect(reader.last).toBeUndefined();
    expect(restore).not.toHaveBeenCalled();
    expect(fs.existsSync(temporary.mock.results[0]!.value as string)).toBe(false);
    reader.read(source(file));
    reader.suspend();
    reader.read({ ...source(file), id: "other" });
    expect(restore).not.toHaveBeenCalled();
    expect(fs.existsSync(temporary.mock.results[1]!.value as string)).toBe(false);
    reader.suspend();
    vi.spyOn(fs, "rmSync").mockImplementationOnce(() => { throw new Error("cleanup denied"); });
    expect(reader.last!.messages).toHaveLength(1);
    expect(reader.suspended).toBe(false);
  });

  it("preserves no-session streaming state and incomplete arguments through repeated suspension", () => {
    const file = path.join(workspace(), "events.jsonl");
    fs.writeFileSync(file, jsonl([
      { type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "tool", toolName: "read" } },
      { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"path":' } },
      { type: "tool_execution_start", toolCallId: "tool", toolName: "read", args: { path: "x" } },
      { type: "tool_execution_update", toolCallId: "tool", partialResult: { content: [{ type: "text", text: "partial" }], details: { full: true } } },
      { type: "queue_update", steering: ["next"], followUp: ["later"] },
    ]));
    const reader = new NativeConversationReader();
    const before = reader.read(source(file), false);
    trackCheckpoints();
    reader.suspend();
    expect(content(reader.last!)).toEqual(content(before));
    reader.suspend();
    fs.appendFileSync(file, jsonl([{ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '"x"}' } }]));
    const newer = reader.loadNewer()!;
    expect(newer.streaming.partialAssistant?.content[0]).toMatchObject({ arguments: { path: "x" } });
    expect(newer.streaming.tools[0]?.partial).toEqual(before.streaming.tools[0]?.partial);
    expect(newer.pendingMessages).toEqual(before.pendingMessages);
    reader.suspend();
    expect(reader.loadLatest()!.pendingMessages).toEqual(before.pendingMessages);
    reader.clear();
  });

  it("preserves loaded stable session pages across actor activation rollover while suspended", () => {
    const directory = workspace();
    const session = path.join(directory, "session.jsonl");
    const firstRun = path.join(directory, "run1.events.jsonl");
    const nextRun = path.join(directory, "run2.events.jsonl");
    fs.writeFileSync(session, jsonl([header, ...Array.from({ length: 100 }, (_, i) => entry(i))]));
    fs.writeFileSync(firstRun, jsonl([{ type: "message_end", message: { role: "user", content: "old run", timestamp: 500 } }]));
    fs.writeFileSync(nextRun, jsonl([{ type: "message_end", message: { role: "user", content: "new run", timestamp: 501 } }]));
    const reader = new NativeConversationReader();
    reader.read({ ...source(firstRun), sessionFile: session }, false);
    const loaded = reader.loadOlder()!;
    expect(loaded.messages).toHaveLength(101);
    trackCheckpoints();
    reader.suspend();
    fs.unlinkSync(session);
    fs.unlinkSync(firstRun);
    const next = reader.read({ ...source(nextRun), sessionFile: session }, false);
    expect(next.messages).toHaveLength(101);
    expect(next.messages.at(-1)).toMatchObject({ content: "new run" });
    expect(next.messages.slice(0, 100)).toEqual(loaded.messages.slice(0, 100));
    expect(next.unavailable?.sessionFile).toBe(true);
    expect(next.revision).toBeGreaterThan(loaded.revision);
  });
});
