import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeFabricConfig, type FabricMemoryConfig } from "../src/config.js";
import { foldSessionDigest } from "../src/memory/digest.js";
import { encodeCwdDir, resolveScope } from "../src/memory/discovery.js";
import {
  digestPathForSession,
  loadDigest,
  loadTieredIndex,
  shardPathForSession,
} from "../src/memory/index.js";
import { normalizeSession } from "../src/memory/normalize.js";
import { MemoryProvider } from "../src/providers/memory-provider.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import {
  assistantText,
  assistantToolCall,
  messageEntry,
  sessionHeader,
  toolResult,
  userMessage,
  writeSessionFile,
  type FixtureEntry,
} from "./fixtures/memory.js";

const temporaryDirectories: string[] = [];
const timestamp = (offset: number): string =>
  new Date(1_700_000_000_000 + offset * 1_000).toISOString();

const makeTempDir = (name: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fabric-decay-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
};

const message = (
  id: string,
  parentId: string | null,
  offset: number,
  body: Record<string, unknown>,
): FixtureEntry => messageEntry(id, parentId, timestamp(offset), body);

const setMtime = (file: string, seconds: number): void => {
  fs.utimesSync(file, seconds, seconds);
};

const invocationContext = (cwd: string): FabricInvocationContext => ({
  cwd,
  signal: undefined,
  parentToolCallId: "memory-decay-test",
  nestedToolCallId: "memory-decay-nested",
  extensionContext: {} as FabricInvocationContext["extensionContext"],
  update() {},
});

const memoryConfig = (indexDir: string, hotSessions = 1): FabricMemoryConfig => ({
  enabled: true,
  indexDir,
  maxSessions: 500,
  maxEntryChars: 2_000,
  hotSessions,
  digestTerms: 200,
});

describe("memory sleep cycle", () => {
  let agentDir: string;
  let indexDir: string;
  let cwd: string;

  beforeEach(() => {
    agentDir = makeTempDir("agent");
    indexDir = makeTempDir("index");
    cwd = "/home/user/sleep-cycle";
  });

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  const seed = (name: string, id: string, entries: FixtureEntry[], mtime: number): string => {
    const file = writeSessionFile(
      path.join(agentDir, "sessions", encodeCwdDir(cwd)),
      name,
      [sessionHeader(id, cwd), ...entries],
    );
    setMtime(file, mtime);
    return file;
  };

  const projectRefs = () =>
    resolveScope({ agentDir, cwd, scope: "project", maxSessions: 500 });

  it("demotes the oldest session at the hot boundary and drops its shard", () => {
    const base = Math.floor(Date.now() / 1_000) - 100;
    const oldest = seed("1-old.jsonl", "old", [
      message("old-user", null, 0, userMessage("old session detail")),
    ], base);
    const middle = seed("2-middle.jsonl", "middle", [
      message("middle-user", null, 1, userMessage("middle session detail")),
    ], base + 1);
    const options = { indexDir, maxEntryChars: 2_000, hotSessions: 2, digestTerms: 200 };
    loadTieredIndex(projectRefs(), projectRefs(), options);
    expect(fs.existsSync(shardPathForSession(oldest, indexDir))).toBe(true);

    const newest = seed("3-new.jsonl", "new", [
      message("new-user", null, 2, userMessage("new session detail")),
    ], base + 2);
    loadTieredIndex(projectRefs(), projectRefs(), options);

    expect(fs.existsSync(shardPathForSession(newest, indexDir))).toBe(true);
    expect(fs.existsSync(shardPathForSession(middle, indexDir))).toBe(true);
    expect(fs.existsSync(shardPathForSession(oldest, indexDir))).toBe(false);
    expect(fs.existsSync(digestPathForSession(oldest, indexDir))).toBe(true);
  });

  it("folds goal, files, errors, tools, timestamps, and DF-weighted terms", () => {
    const file = seed("digest.jsonl", "digest", [
      message("u1", null, 0, userMessage("Ship auth cleanup\nwith a second line")),
      message("a1", "u1", 1, assistantToolCall("call-1", "read", { path: "src/auth.ts" })),
      message("r1", "a1", 2, toolResult("call-1", "read", "auth auth implementation")),
      message("r2", "r1", 3, toolResult("call-2", "bash", "auth failed", true)),
      message("a2", "r2", 4, assistantText("auth cleanup complete")),
    ], Math.floor(Date.now() / 1_000));
    const normalized = normalizeSession(file, 2_000);
    const digest = foldSessionDigest({
      sessionId: "digest",
      file,
      cwd,
      entries: normalized.entries,
      digestTerms: 10,
    });

    expect(digest.goalLine).toBe("Ship auth cleanup");
    expect(digest.filesTouched).toEqual(["src/auth.ts"]);
    expect(digest.entryCount).toBe(5);
    expect(digest.errorCount).toBe(1);
    expect(digest.toolHistogram).toEqual({ bash: 1, read: 2 });
    expect(digest.firstTs).toBe(Date.parse(timestamp(0)));
    expect(digest.lastTs).toBe(Date.parse(timestamp(4)));
    expect(digest.terms[0]).toBe("auth");
    expect(new Set(digest.terms).size).toBe(digest.terms.length);
  });

  it("returns a cold session pointer instead of entry matches", async () => {
    const base = Math.floor(Date.now() / 1_000) - 100;
    seed("1-cold.jsonl", "cold", [
      message("u1", null, 0, userMessage("remember the narwhal migration")),
      message("a1", "u1", 1, assistantText("narwhal lives in src/narwhal.ts")),
    ], base);
    seed("2-hot.jsonl", "hot", [
      message("u1", null, 2, userMessage("recent unrelated work")),
    ], base + 1);
    const provider = new MemoryProvider({ agentDir, cwd, config: memoryConfig(indexDir) });

    const result = await provider.invoke(
      "recall",
      { scope: "project", query: "narwhal" },
      invocationContext(cwd),
    ) as {
      segments: unknown[];
      digestHits: { sessionId: string; tier: string }[];
      text: string;
    };

    expect(result.segments).toEqual([]);
    expect(result.digestHits).toEqual([expect.objectContaining({ sessionId: "cold", tier: "cold" })]);
    expect(result.text).toContain("session cold (cold,");
    expect(result.text).toContain('scope "session:cold"');
    expect(result.text).not.toContain("#0 [user]");
  });

  it("hydrates an explicitly scoped cold session at entry granularity without persisting a shard", async () => {
    const base = Math.floor(Date.now() / 1_000) - 100;
    const cold = seed("1-cold.jsonl", "cold", [
      message("u1", null, 0, userMessage("the quasar migration plan")),
      message("a1", "u1", 1, assistantText("implement quasar in src/quasar.ts")),
    ], base);
    seed("2-hot.jsonl", "hot", [message("u1", null, 2, userMessage("recent work"))], base + 1);
    const provider = new MemoryProvider({ agentDir, cwd, config: memoryConfig(indexDir) });

    const result = await provider.invoke(
      "recall",
      { scope: "session:cold", query: "quasar" },
      invocationContext(cwd),
    ) as { segments: { sessionId: string; tier: string }[]; digestHits: unknown[]; text: string };

    expect(result.digestHits).toEqual([]);
    expect(result.segments[0]).toEqual(expect.objectContaining({ sessionId: "cold", tier: "cold" }));
    expect(result.text).toContain("#0 [user]");
    expect(fs.existsSync(shardPathForSession(cold, indexDir))).toBe(false);
    expect(fs.existsSync(digestPathForSession(cold, indexDir))).toBe(true);
  });

  it("invalidates a digest when source mtime and size change", () => {
    const base = Math.floor(Date.now() / 1_000) - 100;
    const file = seed("cold.jsonl", "cold", [
      message("u1", null, 0, userMessage("original comet plan")),
    ], base);
    const ref = projectRefs()[0]!;
    const options = { indexDir, maxEntryChars: 2_000, hotSessions: 0, digestTerms: 200 };
    const first = loadDigest(ref, options);

    fs.appendFileSync(
      file,
      `${JSON.stringify(message("u2", "u1", 1, userMessage("appended meteor detail")))}\n`,
    );
    setMtime(file, base + 10);
    const refreshedRef = projectRefs()[0]!;
    const second = loadDigest(refreshedRef, options);

    expect(second.mtime).not.toBe(first.mtime);
    expect(second.size).toBeGreaterThan(first.size);
    expect(second.entryCount).toBe(2);
    expect(second.terms).toContain("meteor");
  });

  it("reports hot and cold tiers from sessions()", async () => {
    const base = Math.floor(Date.now() / 1_000) - 100;
    seed("1-cold.jsonl", "cold", [message("u1", null, 0, userMessage("cold"))], base);
    seed("2-hot.jsonl", "hot", [message("u1", null, 1, userMessage("hot"))], base + 1);
    const provider = new MemoryProvider({ agentDir, cwd, config: memoryConfig(indexDir) });

    const result = await provider.invoke("sessions", { scope: "project" }, invocationContext(cwd)) as {
      sessions: { id: string; tier: string; entryCount: number }[];
    };
    expect(result.sessions.map(({ id, tier }) => ({ id, tier }))).toEqual([
      { id: "hot", tier: "hot" },
      { id: "cold", tier: "cold" },
    ]);
    expect(result.sessions.every((session) => session.entryCount === 1)).toBe(true);
  });

  it("produces identical mixed-tier recall across repeated runs", async () => {
    const base = Math.floor(Date.now() / 1_000) - 100;
    seed("1-cold.jsonl", "cold", [message("u1", null, 0, userMessage("saturn release"))], base);
    seed("2-hot.jsonl", "hot", [message("u1", null, 1, userMessage("saturn release"))], base + 1);
    const provider = new MemoryProvider({ agentDir, cwd, config: memoryConfig(indexDir) });
    const run = async () => provider.invoke(
      "recall",
      { scope: "project", query: "saturn" },
      invocationContext(cwd),
    );

    expect(await run()).toEqual(await run());
  });

  it("normalizes tier policy defaults and bounds", () => {
    expect(normalizeFabricConfig({}).memory).toEqual(expect.objectContaining({
      hotSessions: 50,
      digestTerms: 200,
    }));
    expect(normalizeFabricConfig({ memory: { hotSessions: -1, digestTerms: 0 } }).memory)
      .toEqual(expect.objectContaining({ hotSessions: 0, digestTerms: 1 }));
  });
});
