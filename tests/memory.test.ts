import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assistantText,
  assistantToolCall,
  bashExecution,
  messageEntry,
  sessionHeader,
  toolResult,
  userMessage,
  writeSessionFile,
  type FixtureEntry,
} from "./fixtures/memory.js";
import { normalizeSession, extractFullText, expandSessionEntry } from "../src/memory/normalize.js";
import { encodeCwdDir, resolveScope, enumerateAllSessions } from "../src/memory/discovery.js";
import { bm25Score, loadShard, loadShards, recentEntries } from "../src/memory/index.js";
import { searchShards, formatSearchResult } from "../src/memory/search.js";
import { MemoryProvider } from "../src/providers/memory-provider.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import type { FabricMemoryConfig } from "../src/config.js";

const tempDirs: string[] = [];

const makeTempDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fabric-memory-${prefix}-`));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const buildSession = (cwd: string, id: string): { entries: FixtureEntry[]; push: (e: FixtureEntry) => void } => {
  const entries: FixtureEntry[] = [sessionHeader(id, cwd)];
  let parent: string | null = null;
  let counter = 0;
  const push = (entry: FixtureEntry) => {
    entries.push(entry);
    parent = entry.id;
    void counter++;
  };
  void parent;
  return { entries, push };
};

const ts = (n: number): string => new Date(1_700_000_000_000 + n * 1_000).toISOString();

const sessionId = (file: string): string => file;

const msg = (
  id: string,
  parentId: string | null,
  timestamp: string,
  message: Record<string, unknown>,
): FixtureEntry => ({ type: "message", id, parentId, timestamp, message });

const makeMemoryConfig = (indexDir: string): FabricMemoryConfig => ({
  enabled: true,
  indexDir,
  maxSessions: 500,
  maxEntryChars: 2_000,
});

const invocationContext = (cwd: string): FabricInvocationContext => ({
  cwd,
  signal: undefined,
  parentToolCallId: "test",
  nestedToolCallId: "nested",
  extensionContext: {} as FabricInvocationContext["extensionContext"],
  update() {},
});

describe("memory normalize", () => {
  let agentDir: string;
  let indexDir: string;

  beforeEach(() => {
    agentDir = makeTempDir("agent");
    indexDir = makeTempDir("index");
  });

  it("extracts typed entries from a session JSONL", () => {
    const cwd = "/home/user/project";
    const file = writeSessionFile(
      path.join(agentDir, "sessions", encodeCwdDir(cwd)),
      "1_session-a.jsonl",
      [
        sessionHeader("a", cwd),
        msg("e1", null, ts(0), userMessage("fix the auth bug")),
        msg("e2", "e1", ts(1), assistantText("I will inspect the auth module.")),
        msg("e3", "e2", ts(2), assistantToolCall("c1", "read", { path: "src/auth.ts" })),
        msg("e4", "e3", ts(3), toolResult("c1", "read", "export function auth() {}")),
        msg("e5", "e4", ts(4), bashExecution("pnpm test", "all tests passed", 0)),
        msg("e6", "e5", ts(5), toolResult("c2", "bash", "command failed", true)),
      ],
    );
    const { entries, header } = normalizeSession(file, 2_000);
    expect(header?.sessionId).toBe("a");
    expect(header?.cwd).toBe(cwd);
    expect(entries.map((e) => e.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "toolResult",
      "bashExecution",
      "toolResult",
    ]);
    expect(entries.map((e) => e.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(entries[2]!.toolName).toBe("read");
    expect(entries[2]!.text).toContain("Tool: read(");
    expect(entries[3]!.toolName).toBe("read");
    expect(entries[3]!.text).toContain("toolResult(read):");
    expect(entries[4]!.role).toBe("bashExecution");
    expect(entries[4]!.text).toContain("bash$ pnpm test");
    expect(entries[4]!.text).toContain("all tests passed");
    expect(entries[5]!.isError).toBe(true);
    expect(entries.map((e) => e.sessionId)).toEqual(Array(6).fill("a"));
  });

  it("truncates long text but expand returns the full text", () => {
    const cwd = "/home/user/long";
    const longText = "x".repeat(3_000);
    const file = writeSessionFile(
      path.join(agentDir, "sessions", encodeCwdDir(cwd)),
      "1_long.jsonl",
      [
        sessionHeader("long", cwd),
        msg("e1", null, ts(0), userMessage(longText)),
      ],
    );
    const { entries } = normalizeSession(file, 100);
    expect(entries[0]!.text.length).toBe(100);
    expect(entries[0]!.truncated).toBe(true);
    const full = expandSessionEntry(file, 0);
    expect(full).toBe(longText);
  });

  it("skips structural-only entries (model_change, label, custom)", () => {
    const cwd = "/home/user/skip";
    const file = writeSessionFile(
      path.join(agentDir, "sessions", encodeCwdDir(cwd)),
      "1_skip.jsonl",
      [
        sessionHeader("skip", cwd),
        msg("e1", null, ts(0), userMessage("hello")),
        { type: "model_change", id: "m1", parentId: "e1", timestamp: ts(1), provider: "anthropic", modelId: "x" },
        { type: "label", id: "l1", parentId: "m1", timestamp: ts(2), targetId: "e1", label: "checkpoint" },
        msg("e2", "e1", ts(3), assistantText("hi")),
        { type: "custom", id: "c1", parentId: "e2", timestamp: ts(4), customType: "ext", data: { x: 1 } },
      ],
    );
    const { entries } = normalizeSession(file, 2_000);
    expect(entries.map((e) => e.role)).toEqual(["user", "assistant"]);
    expect(entries.map((e) => e.index)).toEqual([0, 1]);
  });

  it("extractFullText handles assistant with thinking and toolCall blocks", () => {
    const text = extractFullText({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning here" },
          { type: "text", text: "response" },
          { type: "toolCall", id: "c1", name: "grep", arguments: { pattern: "TODO" } },
        ],
      },
    });
    expect(text).toContain("reasoning here");
    expect(text).toContain("response");
    expect(text).toContain("Tool: grep(");
  });
});

describe("memory discovery", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = makeTempDir("agent");
  });

  const seed = (cwd: string, name: string, id: string): string => {
    // mtime ordering: write with small delays via utimes
    const file = writeSessionFile(
      path.join(agentDir, "sessions", encodeCwdDir(cwd)),
      name,
      [sessionHeader(id, cwd), msg("e1", null, ts(0), userMessage(`session ${id}`))],
    );
    return file;
  };

  it("encodeCwdDir matches pi's encoding shape", () => {
    expect(encodeCwdDir("/home/user/project")).toBe("--home-user-project--");
  });

  it("project scope lists all sessions for the cwd dir", () => {
    const cwd = "/home/user/proj-a";
    seed(cwd, "1_a.jsonl", "a");
    seed(cwd, "2_b.jsonl", "b");
    const refs = resolveScope({
      agentDir,
      cwd,
      scope: "project",
      maxSessions: 500,
    });
    expect(refs.map((r) => r.id).sort()).toEqual(["a", "b"]);
    for (const ref of refs) {
      expect(ref.cwd).toBe(cwd);
    }
  });

  it("global scope lists sessions across all cwd dirs, newest first", () => {
    const cwdA = "/home/user/g-a";
    const cwdB = "/home/user/g-b";
    const fileA = seed(cwdA, "1_a.jsonl", "a");
    const fileB = seed(cwdB, "1_b.jsonl", "b");
    // make fileB newer than fileA
    const older = Date.now() / 1_000 - 60;
    const newer = Date.now() / 1_000;
    fs.utimesSync(fileA, older, older);
    fs.utimesSync(fileB, newer, newer);
    const refs = enumerateAllSessions(agentDir, 500);
    expect(refs.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("global scope respects maxSessions bound", () => {
    seed("/home/user/c1", "1_x.jsonl", "x");
    seed("/home/user/c2", "1_y.jsonl", "y");
    seed("/home/user/c3", "1_z.jsonl", "z");
    const refs = enumerateAllSessions(agentDir, 2);
    expect(refs.length).toBe(2);
  });

  it("session:<id> resolves a specific session by id", () => {
    const cwd = "/home/user/spec";
    seed(cwd, "1_target.jsonl", "target-id");
    const refs = resolveScope({ agentDir, cwd, scope: "session:target-id", maxSessions: 500 });
    expect(refs.length).toBe(1);
    expect(refs[0]!.id).toBe("target-id");
  });

  it("session:<path> resolves a specific session by file path", () => {
    const cwd = "/home/user/specpath";
    const file = seed(cwd, "1_p.jsonl", "p");
    const refs = resolveScope({ agentDir, cwd, scope: `session:${file}`, maxSessions: 500 });
    expect(refs.length).toBe(1);
    expect(refs[0]!.file).toBe(file);
  });

  it("session scope defaults to newest session for cwd when no sessionFile", () => {
    const cwd = "/home/user/def";
    const fileA = seed(cwd, "1_a.jsonl", "a");
    const fileB = seed(cwd, "2_b.jsonl", "b");
    fs.utimesSync(fileA, Date.now() / 1_000 - 10, Date.now() / 1_000 - 10);
    fs.utimesSync(fileB, Date.now() / 1_000, Date.now() / 1_000);
    const refs = resolveScope({ agentDir, cwd, scope: "session", maxSessions: 500 });
    expect(refs.length).toBe(1);
    expect(refs[0]!.id).toBe("b");
  });
});

describe("memory shard index", () => {
  let agentDir: string;
  let indexDir: string;

  beforeEach(() => {
    agentDir = makeTempDir("agent");
    indexDir = makeTempDir("index");
  });

  const seedSession = (cwd: string, name: string, id: string, messages: FixtureEntry[]): string =>
    writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), name, [
      sessionHeader(id, cwd),
      ...messages,
    ]);

  it("persists a shard and reuses it when mtime + size are unchanged", () => {
    const file = seedSession("/home/user/cache", "1.jsonl", "c", [
      msg("e1", null, ts(0), userMessage("index me please")),
    ]);
    const options = { indexDir, maxEntryChars: 2_000 };
    const ref = { id: "c", file, cwd: "/home/user/cache", mtime: fs.statSync(file).mtimeMs };
    const first = loadShard(ref, options);
    expect(first.entries.length).toBe(1);
    const shardFiles = fs.readdirSync(indexDir);
    expect(shardFiles.length).toBe(1);
    const second = loadShard(ref, options);
    expect(second).toEqual(first);
  });

  it("invalidates and re-parses the shard when mtime changes", () => {
    const file = seedSession("/home/user/inval", "1.jsonl", "i", [
      msg("e1", null, ts(0), userMessage("original content")),
    ]);
    const options = { indexDir, maxEntryChars: 2_000 };
    const stat = fs.statSync(file);
    const ref = { id: "i", file, cwd: "/home/user/inval", mtime: stat.mtimeMs };
    const first = loadShard(ref, options);
    expect(first.entries[0]!.text).toContain("original content");
    // append a new line, changing mtime + size
    const later = Date.now() / 1_000 + 5;
    fs.appendFileSync(file, `${JSON.stringify(msg("e2", "e1", ts(1), userMessage("appended")))}\n`);
    fs.utimesSync(file, later, later);
    const newStat = fs.statSync(file);
    const refreshed = loadShard(
      { id: "i", file, cwd: "/home/user/inval", mtime: newStat.mtimeMs },
      options,
    );
    expect(refreshed.entries.length).toBe(2);
    expect(refreshed.entries[1]!.text).toContain("appended");
  });

  it("BM25 ranking is deterministic: same query twice yields identical ordering", () => {
    const file = seedSession("/home/user/det", "1.jsonl", "d", [
      msg("e1", null, ts(0), userMessage("auth login bug in the auth module")),
      msg("e2", "e1", ts(1), assistantText("the auth module handles login")),
      msg("e3", "e2", ts(2), userMessage("deployment pipeline config")),
      msg("e4", "e3", ts(3), assistantText("the config lives in config.yaml")),
    ]);
    const options = { indexDir, maxEntryChars: 2_000 };
    const { shards } = loadShards(
      [{ id: "d", file, cwd: "/home/user/det", mtime: fs.statSync(file).mtimeMs }],
      options,
    );
    const run = () =>
      bm25Score(shards, ["auth", "module"], {})
        .map((s) => s.entry.index);
    const first = run();
    const second = run();
    expect(second).toEqual(first);
    // only the two entries mentioning both terms match
    expect([...first].sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it("BM25 tie-break is deterministic by mtime desc then index asc", () => {
    const fileA = seedSession("/home/user/tie-a", "1.jsonl", "a", [
      msg("e1", null, ts(0), userMessage("deploy deploy deploy")),
    ]);
    const fileB = seedSession("/home/user/tie-b", "1.jsonl", "b", [
      msg("e1", null, ts(0), userMessage("deploy deploy deploy")),
    ]);
    fs.utimesSync(fileA, Date.now() / 1_000 - 5, Date.now() / 1_000 - 5);
    fs.utimesSync(fileB, Date.now() / 1_000, Date.now() / 1_000);
    const options = { indexDir, maxEntryChars: 2_000 };
    const { shards } = loadShards(
      [
        { id: "a", file: fileA, cwd: "/home/user/tie-a", mtime: fs.statSync(fileA).mtimeMs },
        { id: "b", file: fileB, cwd: "/home/user/tie-b", mtime: fs.statSync(fileB).mtimeMs },
      ],
      options,
    );
    const indices = bm25Score(shards, ["deploy"], {}).map((s) => s.entry.sessionFile);
    // both same score; newer session (b) should come first
    expect(indices[0]).toBe(fileB);
    expect(indices[1]).toBe(fileA);
  });

  it("recentEntries returns newest-mtime-first without a query", () => {
    const fileA = seedSession("/home/user/rec-a", "1.jsonl", "a", [
      msg("e1", null, ts(0), userMessage("older session")),
    ]);
    const fileB = seedSession("/home/user/rec-b", "1.jsonl", "b", [
      msg("e1", null, ts(0), userMessage("newer session")),
    ]);
    fs.utimesSync(fileA, Date.now() / 1_000 - 5, Date.now() / 1_000 - 5);
    fs.utimesSync(fileB, Date.now() / 1_000, Date.now() / 1_000);
    const options = { indexDir, maxEntryChars: 2_000 };
    const { shards } = loadShards(
      [
        { id: "a", file: fileA, cwd: "/home/user/rec-a", mtime: fs.statSync(fileA).mtimeMs },
        { id: "b", file: fileB, cwd: "/home/user/rec-b", mtime: fs.statSync(fileB).mtimeMs },
      ],
      options,
    );
    const recent = recentEntries(shards, {}, 25);
    expect(recent[0]!.entry.sessionFile).toBe(fileB);
    expect(recent[1]!.entry.sessionFile).toBe(fileA);
  });
});

describe("memory search pipeline", () => {
  let agentDir: string;
  let indexDir: string;

  beforeEach(() => {
    agentDir = makeTempDir("agent");
    indexDir = makeTempDir("index");
  });

  const seedSession = (cwd: string, name: string, id: string, messages: FixtureEntry[]): string =>
    writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), name, [
      sessionHeader(id, cwd),
      ...messages,
    ]);

  const load = (files: { file: string; id: string; cwd: string }[]) => {
    const options = { indexDir, maxEntryChars: 2_000 };
    return loadShards(
      files.map((f) => ({ id: f.id, file: f.file, cwd: f.cwd, mtime: fs.statSync(f.file).mtimeMs })),
      options,
    ).shards;
  };

  it("groups hits into segments bounded by user messages, with context entries", async () => {
    const file = seedSession("/home/user/seg", "1.jsonl", "s", [
      msg("e1", null, ts(0), userMessage("investigate the auth login flow")),
      msg("e2", "e1", ts(1), assistantText("looking at auth.ts")),
      msg("e3", "e2", ts(2), userMessage("now check the deployment scripts")),
      msg("e4", "e3", ts(3), assistantText("checking deploy.sh")),
      msg("e5", "e4", ts(4), assistantText("auth also appears here in a comment")),
    ]);
    const shards = load([{ file, id: "s", cwd: "/home/user/seg" }]);
    const result = await searchShards(shards, { query: "auth", limit: 50 });
    // matches at e1, e2, e5; segment 1 = e1+e2 (both match), segment 2 = e3,e4,e5 (e5 matches, e3/e4 context)
    expect(result.matchedCount).toBe(3);
    const segment2 = result.segments.find((s) => s.entries.some((e) => e.entry.index === 4));
    expect(segment2).toBeDefined();
    const e4 = segment2!.entries.find((e) => e.entry.index === 3);
    const e5 = segment2!.entries.find((e) => e.entry.index === 4);
    expect(e4?.matched).toBe(false);
    expect(e4?.marker).toBe(" ");
    expect(e5?.matched).toBe(true);
    expect(e5?.marker).toBe(">");
  });

  it("uses regex only in explicit regex mode", async () => {
    const file = seedSession("/home/user/re", "1.jsonl", "r", [
      msg("e1", null, ts(0), userMessage("error code 42 in module alpha")),
      msg("e2", "e1", ts(1), assistantText("error code 99 in module beta")),
    ]);
    const shards = load([{ file, id: "r", cwd: "/home/user/re" }]);
    const literal = await searchShards(shards, { query: "code 4[0-9]", limit: 50 });
    expect(literal.matchedCount).toBe(2);
    const result = await searchShards(shards, {
      query: "code 4[0-9]",
      queryMode: "regex",
      limit: 50,
    });
    expect(result.matchedCount).toBe(1);
    expect(result.segments[0]!.entries[0]!.entry.text).toContain("code 42");
  });

  it("applies role and tool filters structurally", async () => {
    const file = seedSession("/home/user/filt", "1.jsonl", "f", [
      msg("e1", null, ts(0), userMessage("grep for TODO")),
      msg("e2", "e1", ts(1), assistantToolCall("c1", "grep", { pattern: "TODO" })),
      msg("e3", "e2", ts(2), toolResult("c1", "grep", "TODO: fix auth")),
      msg("e4", "e3", ts(3), assistantText("found a TODO")),
    ]);
    const shards = load([{ file, id: "f", cwd: "/home/user/filt" }]);
    const toolFiltered = await searchShards(shards, { query: "TODO", filters: { tool: "grep" } });
    // grep toolCall + grep toolResult both match (2); user/assistant text do not
    expect(toolFiltered.matchedCount).toBe(2);
    const matchedTools = toolFiltered.segments
      .flatMap((s) => s.entries)
      .filter((e) => e.matched)
      .map((e) => e.entry.toolName);
    expect(matchedTools.every((t) => t === "grep")).toBe(true);
    const roleFiltered = await searchShards(shards, { query: "TODO", filters: { role: "user" } });
    expect(roleFiltered.matchedCount).toBe(1);
    expect(roleFiltered.segments[0]!.entries.find((e) => e.matched)!.entry.role).toBe("user");
  });

  it("browse mode (no query) returns 25 most recent entries with > markers", async () => {
    const messages: FixtureEntry[] = [];
    let parent: string | null = null;
    for (let i = 0; i < 30; i += 1) {
      const entry = msg(`u${i}`, parent, ts(i), userMessage(`entry number ${i}`));
      messages.push(entry);
      parent = `u${i}`;
    }
    const file = seedSession("/home/user/browse", "1.jsonl", "b", messages);
    const shards = load([{ file, id: "b", cwd: "/home/user/browse" }]);
    const result = await searchShards(shards, {});
    expect(result.matchedCount).toBe(25);
    expect(result.segments.length).toBeGreaterThan(0);
    expect(result.segments[0]!.entries[0]!.marker).toBe(">");
  });

  it("formatSearchResult emits deterministic text with segment headers", async () => {
    const file = seedSession("/home/user/fmt", "1.jsonl", "f", [
      msg("e1", null, ts(0), userMessage("auth bug")),
      msg("e2", "e1", ts(1), assistantText("auth fix applied")),
    ]);
    const shards = load([{ file, id: "f", cwd: "/home/user/fmt" }]);
    const result = await searchShards(shards, { query: "auth", limit: 50 });
    const text = formatSearchResult(result, "auth");
    expect(text).toContain('matches across');
    expect(text).toContain("--- #0-#1");
    expect(text).toContain("> #0 [user] auth bug");
  });
});

describe("MemoryProvider", () => {
  let agentDir: string;
  let indexDir: string;
  let cwd: string;

  beforeEach(() => {
    agentDir = makeTempDir("agent");
    indexDir = makeTempDir("index");
    cwd = "/home/user/provider-proj";
    writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), "1_main.jsonl", [
      sessionHeader("main", cwd),
      msg("e1", null, ts(0), userMessage("remember the auth refactor")),
      msg("e2", "e1", ts(1), assistantText("the auth refactor touched login.ts")),
      msg("e3", "e2", ts(2), userMessage("ship the deploy pipeline")),
      msg("e4", "e3", ts(3), assistantText("deploy pipeline configured")),
    ]);
  });

  const provider = (scope?: { sessionFile?: string }) =>
    new MemoryProvider({
      agentDir,
      cwd,
      config: makeMemoryConfig(indexDir),
      sessionId: "main",
      ...(scope?.sessionFile ? { sessionFile: scope.sessionFile } : {}),
    });

  it("recall with no query browses recent entries in session scope", async () => {
    const result = (await provider().invoke(
      "recall",
      { scope: "session" },
      invocationContext(cwd),
    )) as { matchedCount: number; text: string; segments: unknown[] };
    expect(result.matchedCount).toBeGreaterThan(0);
    expect(result.text).toContain("most recent entries");
  });

  it("recall with a query returns BM25 matches and deterministic text", async () => {
    const first = (await provider().invoke("recall", { scope: "session", query: "auth" }, invocationContext(cwd))) as {
      text: string;
    };
    const second = (await provider().invoke("recall", { scope: "session", query: "auth" }, invocationContext(cwd))) as {
      text: string;
    };
    expect(first.text).toEqual(second.text);
    expect(first.text).toContain("auth");
  });

  it("project scope searches all sessions for the cwd", async () => {
    const otherCwd = cwd; // same project dir
    writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(otherCwd)), "2_other.jsonl", [
      sessionHeader("other", otherCwd),
      msg("e1", null, ts(0), userMessage("auth pipeline note in another session")),
    ]);
    const result = (await provider().invoke(
      "recall",
      { scope: "project", query: "auth" },
      invocationContext(cwd),
    )) as { matchedCount: number; segments: { sessionId: string }[] };
    const sessionIds = new Set(result.segments.map((s) => s.sessionId));
    expect(sessionIds.has("main")).toBe(true);
    expect(sessionIds.has("other")).toBe(true);
  });

  it("expand returns full untruncated text for indices", async () => {
    const longText = "y".repeat(3_000);
    const file = writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), "3_long.jsonl", [
      sessionHeader("long", cwd),
      msg("e1", null, ts(0), userMessage(longText)),
    ]);
    const result = (await provider().invoke("expand", { session: file, indices: [0] }, invocationContext(cwd))) as {
      expanded: { index: number; text: string | null }[];
    };
    expect(result.expanded[0]!.text).toBe(longText);
  });

  it("expand resolves a session by id", async () => {
    const result = (await provider().invoke("expand", { session: "main", indices: [0] }, invocationContext(cwd))) as {
      expanded: { index: number; text: string | null }[];
    };
    expect(result.expanded[0]!.text).toContain("remember the auth refactor");
  });

  it("sessions lists known sessions with entry counts", async () => {
    const result = (await provider().invoke("sessions", { scope: "project" }, invocationContext(cwd))) as {
      sessions: { id: string; entryCount: number; cwd: string }[];
    };
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0]!.id).toBe("main");
    expect(result.sessions[0]!.entryCount).toBe(4);
    expect(result.sessions[0]!.cwd).toBe(cwd);
  });

  it("lists and describes its actions", async () => {
    const ctx = invocationContext(cwd);
    const list = await provider().list({}, ctx);
    expect(list.map((d) => d.name).sort()).toEqual(["expand", "recall", "sessions"]);
    const described = await provider().describe("recall", ctx);
    expect(described?.risk).toBe("read");
  });
});
