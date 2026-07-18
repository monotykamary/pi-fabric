import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FabricMemoryConfig } from "../src/config.js";
import { encodeCwdDir, resolveScope } from "../src/memory/discovery.js";
import {
  MEMORY_CACHE_VERSION,
  digestPathForSession,
  loadDigest,
  loadShard,
  loadTieredIndex,
  shardPathForSession,
} from "../src/memory/index.js";
import { formatSearchResult, searchMemoryIndex } from "../src/memory/search.js";
import { tokenizeLexical } from "../src/memory/tokenize.js";
import { MemoryProvider } from "../src/providers/memory-provider.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import {
  assistantText,
  messageEntry,
  sessionHeader,
  userMessage,
  writeSessionFile,
} from "./fixtures/memory.js";

const temporaryDirectories: string[] = [];

const temporaryDirectory = (name: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fabric-memory-v4-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
};

const invocationContext = (cwd: string): FabricInvocationContext => ({
  cwd,
  signal: undefined,
  parentToolCallId: "memory-v4",
  nestedToolCallId: "memory-v4-nested",
  extensionContext: {} as FabricInvocationContext["extensionContext"],
  update() {},
});

const message = (id: string, text: string, offset = 0) =>
  messageEntry(
    id,
    null,
    new Date(1_700_000_000_000 + offset * 1_000).toISOString(),
    userMessage(text),
  );

const directorySize = (directory: string): number =>
  fs.readdirSync(directory).reduce((total, name) => total + fs.statSync(path.join(directory, name)).size, 0);

describe("memory cache V4", () => {
  let agentDir: string;
  let indexDir: string;
  let cwd: string;

  beforeEach(() => {
    agentDir = temporaryDirectory("agent");
    indexDir = temporaryDirectory("index");
    cwd = "/work/cache-v4";
  });

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  const config = (overrides: Partial<FabricMemoryConfig> = {}): FabricMemoryConfig => ({
    enabled: true,
    indexDir,
    maxSessions: 10,
    maxEntryChars: 2_000,
    hotSessions: 50,
    digestTerms: 5,
    ...overrides,
  });

  const provider = (overrides: Partial<FabricMemoryConfig> = {}) =>
    new MemoryProvider({ agentDir, cwd, config: config(overrides) });

  it("searches every eligible session despite maxSessions and ranks the oldest rare fact first", async () => {
    const sessionDirectory = path.join(agentDir, "sessions", encodeCwdDir(cwd));
    const base = Math.floor(Date.now() / 1_000) - 10_000;
    let oldest = "";
    for (let index = 0; index < 1_001; index += 1) {
      const rare = index === 0 ? " rarelexeme_000 Ωmega雪" : "";
      const file = writeSessionFile(sessionDirectory, `${String(index).padStart(4, "0")}.jsonl`, [
        sessionHeader(`session-${index}`, cwd),
        message(`entry-${index}`, `common distractor_${index}${rare}`, index),
      ]);
      fs.utimesSync(file, base + index, base + index);
      if (index === 0) oldest = file;
    }

    for (const scope of ["project", "global"]) {
      const result = await provider().invoke(
        "recall",
        { scope, query: "common rarelexeme_000", pageSize: 10 },
        invocationContext(cwd),
      ) as {
        items: { kind: string; digest?: { sessionId: string } }[];
        digestHits: { sessionId: string }[];
        coverage: { complete: boolean; indexedSessions: number; eligibleSessions: number; staleSessions: number };
      };
      expect(result.coverage).toEqual({
        complete: true,
        indexedSessions: 1_001,
        eligibleSessions: 1_001,
        staleSessions: 0,
        incompleteSessions: 0,
        reasons: [],
      });
      expect(result.items[0]).toEqual(expect.objectContaining({
        kind: "digest",
        digest: expect.objectContaining({ sessionId: "session-0" }),
      }));
      expect(result.digestHits[0]!.sessionId).toBe("session-0");
    }

    const regexResult = await provider().invoke(
      "recall",
      { scope: "project", query: "^rarelexeme_[0-9]{3}$", queryMode: "regex" },
      invocationContext(cwd),
    ) as { digestHits: { sessionId: string }[]; coverage: { complete: boolean } };
    expect(regexResult.digestHits.map((hit) => hit.sessionId)).toEqual(["session-0"]);
    expect(regexResult.coverage.complete).toBe(true);

    const unicodeResult = await provider().invoke(
      "recall",
      { scope: "project", query: "ΩMEGA雪" },
      invocationContext(cwd),
    ) as { digestHits: { sessionId: string }[] };
    expect(unicodeResult.digestHits[0]!.sessionId).toBe("session-0");

    const digest = JSON.parse(
      fs.readFileSync(digestPathForSession(oldest, indexDir), "utf8"),
    ) as Record<string, unknown>;
    expect(digest.cacheVersion).toBe(MEMORY_CACHE_VERSION);
    expect(digest.kind).toBe("digest");
    expect(digest).not.toHaveProperty("entries");
    expect(digest).not.toHaveProperty("goalLine");
    expect(digest.vocabulary as string[]).toContain("rarelexeme_000");
    expect(directorySize(indexDir)).toBeLessThan(10 * 1024 * 1024);
    expect(fs.statSync(indexDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(digestPathForSession(oldest, indexDir)).mode & 0o777).toBe(0o600);
  }, 30_000);

  it("keeps no-query browsing bounded while query coverage is complete", async () => {
    const sessionDirectory = path.join(agentDir, "sessions", encodeCwdDir(cwd));
    const base = Math.floor(Date.now() / 1_000) - 100;
    for (let index = 0; index < 20; index += 1) {
      const file = writeSessionFile(sessionDirectory, `${index}.jsonl`, [
        sessionHeader(`browse-${index}`, cwd),
        message(`e-${index}`, `browse token_${index}`),
      ]);
      fs.utimesSync(file, base + index, base + index);
    }
    const browse = await provider().invoke("recall", { scope: "project" }, invocationContext(cwd)) as {
      matchedCount: number;
      coverage: { eligibleSessions: number };
    };
    expect(browse.coverage.eligibleSessions).toBe(10);
    expect(browse.matchedCount).toBe(10);

    const search = await provider({ hotSessions: 1 }).invoke(
      "recall",
      { scope: "project", query: "token_0" },
      invocationContext(cwd),
    ) as { coverage: { complete: boolean; eligibleSessions: number }; digestHits: { sessionId: string }[] };
    expect(search.coverage).toEqual(expect.objectContaining({ complete: true, eligibleSessions: 20 }));
    expect(search.digestHits[0]!.sessionId).toBe("browse-0");
  });

  it("rebuilds rewritten and V1 caches and removes caches for deleted sources", async () => {
    const sessionDirectory = path.join(agentDir, "sessions", encodeCwdDir(cwd));
    const file = writeSessionFile(sessionDirectory, "rewrite.jsonl", [
      sessionHeader("rewrite", cwd),
      message("same-id", "originalword"),
    ]);
    const oldTime = Math.floor(Date.now() / 1_000) - 100;
    fs.utimesSync(file, oldTime, oldTime);
    const ref = resolveScope({ agentDir, cwd, scope: "project", maxSessions: 100 })[0]!;
    const options = { indexDir, maxEntryChars: 2_000, hotSessions: 0, digestTerms: 2 };
    const first = loadDigest(ref, options);
    const v1 = { ...first, cacheVersion: 1, vocabulary: undefined, addresses: undefined };
    fs.writeFileSync(digestPathForSession(file, indexDir), JSON.stringify(v1), "utf8");
    const rebuilt = loadDigest(ref, options);
    expect(rebuilt.cacheVersion).toBe(MEMORY_CACHE_VERSION);
    expect(rebuilt.vocabulary).toContain("originalword");

    const shard = loadShard(ref, { ...options, hotSessions: 1 });
    fs.writeFileSync(
      shardPathForSession(file, indexDir),
      JSON.stringify({ ...shard, cacheVersion: 1, entries: [] }),
      "utf8",
    );
    const rebuiltShard = loadShard(ref, { ...options, hotSessions: 1 });
    expect(rebuiltShard.cacheVersion).toBe(MEMORY_CACHE_VERSION);
    expect(rebuiltShard.entries[0]!.text).toBe("originalword");

    const original = fs.readFileSync(file, "utf8");
    const rewritten = original.replace("originalword", "rewrittenxyz");
    expect(rewritten.length).toBe(original.length);
    fs.writeFileSync(file, rewritten, "utf8");
    fs.utimesSync(file, oldTime, oldTime);
    const rewrittenRef = resolveScope({ agentDir, cwd, scope: "project", maxSessions: 100 })[0]!;
    const refreshed = loadDigest(rewrittenRef, options);
    expect(refreshed.sourceHash).not.toBe(first.sourceHash);
    expect(refreshed.vocabulary).toContain("rewrittenxyz");
    expect(refreshed.vocabulary).not.toContain("originalword");

    const refsBeforeDelete = [rewrittenRef];
    fs.rmSync(file);
    const stale = loadTieredIndex(refsBeforeDelete, refsBeforeDelete, options);
    expect(stale.coverage).toEqual({
      complete: false,
      indexedSessions: 0,
      eligibleSessions: 1,
      staleSessions: 1,
      incompleteSessions: 0,
      reasons: ["source_unavailable"],
    });
    const empty = await searchMemoryIndex(stale.shards, stale.digests, { query: "rewrittenxyz" });
    expect(formatSearchResult(empty, "rewrittenxyz", stale.coverage)).toContain(
      "No indexed matches",
    );
    expect(fs.existsSync(digestPathForSession(file, indexDir))).toBe(false);
  });

  it("hydrates bounded ranges explicitly and expands by stable entry id", async () => {
    const sessionDirectory = path.join(agentDir, "sessions", encodeCwdDir(cwd));
    const old = writeSessionFile(sessionDirectory, "old.jsonl", [
      sessionHeader("old", cwd),
      message("entry-a", "alpha fact", 0),
      messageEntry("entry-b", "entry-a", new Date(1_700_000_001_000).toISOString(), assistantText("rare bounded fact")),
      message("entry-c", "omega fact", 2),
    ]);
    const recent = writeSessionFile(sessionDirectory, "recent.jsonl", [
      sessionHeader("recent", cwd),
      message("recent-entry", "recent fact"),
    ]);
    const base = Math.floor(Date.now() / 1_000) - 100;
    fs.utimesSync(old, base, base);
    fs.utimesSync(recent, base + 1, base + 1);

    const pointer = await provider({ hotSessions: 1 }).invoke(
      "recall",
      { scope: "project", query: "bounded" },
      invocationContext(cwd),
    ) as { digestHits: { sessionFile: string; sourceHash: string }[] };
    expect(pointer.digestHits[0]).toEqual(expect.objectContaining({
      sessionFile: old,
      sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));

    const hydrated = await provider({ hotSessions: 1 }).invoke(
      "recall",
      {
        scope: `session:${pointer.digestHits[0]!.sessionFile}`,
        expectedSourceHash: pointer.digestHits[0]!.sourceHash,
        query: "bounded",
        entryRange: { first: 1, last: 1 },
      },
      invocationContext(cwd),
    ) as { segments: { entries: { entry: { index: number } }[] }[] };
    expect(hydrated.segments.flatMap((segment) => segment.entries).map((entry) => entry.entry.index))
      .toEqual([1]);
    expect(fs.existsSync(shardPathForSession(old, indexDir))).toBe(false);

    const expanded = await provider({ hotSessions: 1 }).invoke(
      "expand",
      { session: "old", entryIds: ["entry-b"] },
      invocationContext(cwd),
    ) as { expanded: { index: number; entryId: string; text: string }[] };
    expect(expanded.expanded).toEqual([{
      index: 1,
      entryId: "entry-b",
      text: "rare bounded fact",
    }]);
  });

  it("uses one Unicode-aware tokenizer for exact lexical terms", () => {
    expect(tokenizeLexical("CAFÉ café Ωmega雪 snake_case 42")).toEqual([
      "café",
      "café",
      "ωmega雪",
      "snake_case",
      "42",
    ]);
  });
});
