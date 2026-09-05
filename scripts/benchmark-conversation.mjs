import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { NativeConversationReader } from "../dist/ui/conversation-native-reader.js";
import { FabricConversationState, FabricConversationView } from "../dist/ui/conversation.js";
import { conversationTargets } from "../dist/ui/conversation-targets.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv[2] ?? "all";
assert(["all", "latency", "append", "retention"].includes(mode), "Mode must be all, latency, append, or retention");
if (mode === "all" || mode === "retention") assert(global.gc, "Run with node --expose-gc");
initTheme("dark", false);
const theme = Object.fromEntries(["fg", "bg"].map((key) => [key, (_color, text) => text]));
for (const key of ["bold", "italic", "underline", "strikethrough"]) theme[key] = (text) => text;
const tui = { mode: "fullscreen", requestRender() {}, terminal: { columns: 100, rows: 30, write() {} } };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (text, timestamp) => ({ role: "assistant", content: [{ type: "text", text }], timestamp, api: "openai-responses", provider: "openai", model: "fixture", stopReason: "stop", usage });
const messagesFor = (count) => Array.from({ length: count }, (_, index) => index % 2 === 0
  ? { role: "user", content: `Question ${index}: explain this implementation and check the important details.`, timestamp: index + 1 }
  : assistant(`## Update ${index}\n\nThe **implementation** follows the expected contract.\n\n- Validate the input and preserve the current state.\n- Check rendering, cleanup, and regression coverage.\n\nPlease inspect the next step.`, index + 1));
const transcriptFor = (messages) => ({ messages, entries: [], streaming: { active: false, tools: [] }, revision: 1, leafId: null, sourceId: "child-0", status: "running", historyComplete: true, hasMore: false, hasNewer: false, updatedAt: 1 });
const snapshotFor = (count) => ({ main: { id: "main", name: "Main", status: "idle", cwd: root }, actors: [], peers: [], participants: [], agents: Array.from({ length: count }, (_, index) => ({ id: `child-${index}`, name: `Child ${index}`, status: "running", runner: "pi", transport: "process", cwd: root, startedAt: index, updatedAt: 1 })) });
const target = conversationTargets(snapshotFor(1))[1];
const cleanups = new Set();
function makeView(transcript, targets = () => [target]) {
  const state = new FabricConversationState();
  const view = new FabricConversationView(tui, theme, { state, initialTargetId: target.id, targets, transcript, send: async () => ({ queued: true }), stop: async () => {}, close() {} });
  const dispose = () => { view.dispose(); state.clear(); cleanups.delete(dispose); };
  cleanups.add(dispose);
  return { view, state, dispose };
}
function makeReader() {
  const reader = new NativeConversationReader();
  const dispose = () => { reader.clear(); cleanups.delete(dispose); };
  cleanups.add(dispose);
  return { reader, dispose };
}
const round = (value) => Math.round(value * 1000) / 1000;
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { medianMs: round(sorted[Math.floor(sorted.length / 2)]), p95Ms: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]), samples: sorted.length };
}
function bench(run, iterations = 15) {
  for (let index = 0; index < 3; index++) run();
  const times = [];
  for (let index = 0; index < iterations; index++) { const start = performance.now(); run(); times.push(performance.now() - start); }
  return stats(times);
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fabric-performance-fixtures-"));
function sessionFixture(count) {
  const file = path.join(directory, `session-${count}.jsonl`);
  const records = [{ type: "session", version: 3, id: `session-${count}`, timestamp: new Date(0).toISOString(), cwd: directory },
    ...messagesFor(count).map((message, index) => ({ type: "message", id: `m-${index}`, parentId: index === 0 ? null : `m-${index - 1}`, timestamp: new Date(index + 1).toISOString(), message }))];
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n", { mode: 0o600 });
  return { id: "child-0", status: "running", sessionFile: file };
}
function loadAll(reader) {
  let pages = 0;
  while (reader.last.hasMore) { reader.loadOlder(); assert(++pages < 1000, "Reader stopped making paging progress"); }
  return pages;
}
function countAssistantUpdates(run) {
  const original = AssistantMessageComponent.prototype.updateContent;
  let count = 0;
  AssistantMessageComponent.prototype.updateContent = function (...args) { count++; return original.apply(this, args); };
  try { run(); return count; } finally { AssistantMessageComponent.prototype.updateContent = original; }
}
function countFileCalls(run) {
  const calls = { openSync: 0, fstatSync: 0, readSync: 0, closeSync: 0 };
  const originals = {};
  for (const key of Object.keys(calls)) {
    originals[key] = fs[key];
    fs[key] = (...args) => { calls[key]++; return originals[key](...args); };
  }
  try { run(); return calls; } finally { for (const key of Object.keys(calls)) fs[key] = originals[key]; }
}
const results = { version: JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version, node: process.version, arch: process.arch, mode, viewport: "100x30", synthetic: true };
try {
  if (mode === "all" || mode === "latency") {
    results.frames = [];
    results.readers = [];
    results.targets = [];
    for (const count of [20, 200, 1000, 2000]) {
      const transcript = transcriptFor(messagesFor(count));
      const { view, state, dispose } = makeView(() => transcript);
      const fullFrame = bench(() => view.render(100), 9);
      const typingFrame = bench(() => { view.handleInput("a"); view.render(100); }, 9);
      const unchangedFrameAssistantUpdates = countAssistantUpdates(() => view.render(100));
      const queueSync = bench(() => state.queues.sync(target.id, transcript), 25);
      results.frames.push({ messages: count, fullFrame, typingFrame, queueSync, unchangedFrameAssistantUpdates });
      dispose();
    }
    for (const count of [200, 1000, 5000]) {
      const source = sessionFixture(count);
      const { reader, dispose: disposeReader } = makeReader();
      const initialTailMessages = reader.read(source).messages.length;
      const pagesLoaded = loadAll(reader);
      assert.equal(reader.last.messages.length, count);
      const before = reader.last;
      const warmUnchanged = bench(() => reader.read(source), 31);
      const after = reader.last;
      const { view, dispose } = makeView(() => reader.read(source));
      const fullFrameWithIO = bench(() => view.render(100), 7);
      const fsCalls = countFileCalls(() => reader.read(source));
      results.readers.push({ messages: count, bytes: fs.statSync(source.sessionFile).size, initialTailMessages, pagesLoaded, warmUnchanged, unchangedRevision: before.revision === after.revision, sameSnapshot: before === after, fsCalls, fullFrameWithIO });
      dispose(); disposeReader();
    }
    for (const count of [1, 10, 100, 1000]) {
      const snapshot = snapshotFor(count);
      const transcript = transcriptFor([]);
      let calls = 0;
      const { view, dispose } = makeView(() => transcript, () => { calls++; return conversationTargets(snapshot); });
      const fullFrame = bench(() => view.render(100), 25);
      calls = 0; view.render(100);
      results.targets.push({ targets: count, fullFrame, projectionsPerFrame: calls });
      dispose();
    }
  }
  if (mode === "all" || mode === "append") {
    results.append = [];
    for (const count of [1000, 5000]) {
      const source = sessionFixture(count);
      const { reader, dispose: disposeReader } = makeReader();
      const initialTailMessages = reader.read(source).messages.length;
      const tail = makeView(() => reader.read(source));
      const initialTailFrame = bench(() => tail.view.render(100), 11);
      tail.dispose(); loadAll(reader);
      const { view, dispose } = makeView(() => reader.last);
      // Report the first loaded-history draw separately from incremental frames.
      const firstLoadedStart = performance.now();
      view.render(100);
      const firstLoadedFrameMs = Number((performance.now() - firstLoadedStart).toFixed(3));
      const reads = [], frames = [];
      for (let index = 0; index < 15; index++) {
        const id = count + index;
        const message = assistant("One newly completed response.", id + 1);
        fs.appendFileSync(source.sessionFile, JSON.stringify({ type: "message", id: `m-${id}`, parentId: `m-${id - 1}`, timestamp: new Date(id + 1).toISOString(), message }) + "\n");
        let start = performance.now(); reader.read(source); reads.push(performance.now() - start);
        assert.equal(reader.last.messages.length, count + index + 1);
        start = performance.now(); view.render(100); frames.push(performance.now() - start);
      }
      results.append.push({ loadedMessages: count, initialTailMessages, initialTailFrame, firstLoadedFrameMs, oneRecordAppendRead: stats(reads), oneRecordChangedFrame: stats(frames) });
      dispose(); disposeReader();
    }
  }
  if (mode === "all" || mode === "retention") {
    results.retention = [];
    for (const count of [250, 500, 1000]) {
      const { reader, dispose } = makeReader();
      const file = path.join(directory, `progress-${count}.jsonl`);
      const source = { id: "child-0", status: "running", logFile: file };
      fs.writeFileSync(file, JSON.stringify({ type: "tool_execution_start", toolCallId: "t1", toolName: "progress", args: {} }) + "\n", { mode: 0o600 });
      reader.read(source); global.gc();
      const baseline = process.memoryUsage().heapUsed;
      // Native RPC strips assistant snapshots, but cumulative tool progress
      // results are retained in full. Exercise that exact event shape.
      function emitUpdates() {
        let text = "";
        for (let index = 0; index < count; index++) {
          text += "x".repeat(64);
          fs.appendFileSync(file, JSON.stringify({ type: "tool_execution_update", toolCallId: "t1", toolName: "progress", partialResult: { content: [{ type: "text", text }] } }) + "\n");
          reader.read(source);
        }
        fs.appendFileSync(file, JSON.stringify({ type: "tool_execution_end", toolCallId: "t1", toolName: "progress", result: { content: [{ type: "text", text }] }, isError: false }) + "\n");
        reader.read(source);
        return text.length;
      }
      const finalTextBytes = emitUpdates(); global.gc();
      const retained = process.memoryUsage().heapUsed;
      assert.equal(reader.last.streaming.tools.length, 1);
      assert.equal(reader.last.streaming.active, false);
      assert.equal(reader.last.messages.length, 0);
      const fileBytes = fs.statSync(file).size;
      dispose(); global.gc();
      results.retention.push({ updates: count, finalTextBytes, fileBytes, retainedHeapDeltaBytes: retained - baseline, heapReleasedByClearBytes: retained - process.memoryUsage().heapUsed });
    }
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  for (const dispose of [...cleanups]) dispose();
  fs.rmSync(directory, { recursive: true, force: true });
}
