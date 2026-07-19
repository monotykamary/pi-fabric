import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FabricMemoryConfig } from "../src/config.js";
import { encodeCwdDir } from "../src/memory/discovery.js";
import { digestPathForSession } from "../src/memory/index.js";
import { planMemoryQuery } from "../src/memory/tokenize.js";
import { MemoryProvider } from "../src/providers/memory-provider.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import {
  messageEntry,
  sessionHeader,
  userMessage,
  writeSessionFile,
} from "./fixtures/memory.js";

const temporaryDirectories: string[] = [];
const temporaryDirectory = (name: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fabric-memory-hardening-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
};

const invocationContext = (cwd: string): FabricInvocationContext => ({
  cwd,
  signal: undefined,
  parentToolCallId: "memory-hardening",
  nestedToolCallId: "memory-hardening-nested",
  extensionContext: {} as FabricInvocationContext["extensionContext"],
  update() {},
});

const message = (id: string, text: string, second = 0) => messageEntry(
  id,
  null,
  new Date(1_700_000_000_000 + second * 1_000).toISOString(),
  userMessage(text),
);

describe("memory query and pointer hardening", () => {
  let agentDir: string;
  let indexDir: string;
  let cwd: string;

  beforeEach(() => {
    agentDir = temporaryDirectory("agent");
    indexDir = temporaryDirectory("index");
    cwd = "/work/memory-hardening";
  });

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  const config = (overrides: Partial<FabricMemoryConfig> = {}): FabricMemoryConfig => ({
    enabled: true,
    indexDir,
    maxSessions: 500,
    maxEntryChars: 100_000,
    indexThinking: false,
    indexToolOutput: true,
    hotSessions: 1,
    maxColdVocabularyBytes: 512 * 1024,
    maxColdCacheBytes: 1024 * 1024,
    maxSyncSessions: 10_000,
    maxSyncSourceBytes: 512 * 1024 * 1024,
    maxCacheCleanupFiles: 100_000,
    regexMaxPatternBytes: 1_024,
    regexMaxHaystackTerms: 20_000,
    regexMaxHaystackBytes: 2 * 1024 * 1024,
    regexTimeoutMs: 250,
    ...overrides,
  });

  const provider = (overrides: Partial<FabricMemoryConfig> = {}) =>
    new MemoryProvider({ agentDir, cwd, config: config(overrides) });

  const seed = (name: string, id: string, texts: string[], projectCwd = cwd): string =>
    writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(projectCwd)), name, [
      sessionHeader(id, projectCwd),
      ...texts.map((text, index) => message(`${id}-${index}`, text, index)),
    ]);

  it("never infers regex mode from dots or paths", async () => {
    expect(planMemoryQuery("src/foo.ts")).toEqual({ kind: "terms", terms: ["src", "foo", "ts"] });
    const file = seed("literal.jsonl", "literal", ["srcXfooYts only"]);
    const result = await provider().invoke(
      "recall",
      { scope: `session:${file}`, query: "src/foo.ts" },
      invocationContext(cwd),
    ) as { matchedCount: number; queryMode: string };
    expect(result.queryMode).toBe("literal");
    expect(result.matchedCount).toBe(0);
  });

  it("runs explicit regex in a bounded worker and terminates catastrophic patterns", async () => {
    const normal = seed("normal.jsonl", "normal", ["error code 42"]);
    const normalResult = await provider({ regexTimeoutMs: 1_000 }).invoke(
      "recall",
      { scope: `session:${normal}`, query: "code 4[0-9]", queryMode: "regex" },
      invocationContext(cwd),
    ) as { matchedCount: number; coverage: { complete: boolean } };
    expect(normalResult.matchedCount).toBe(1);
    expect(normalResult.coverage.complete).toBe(true);

    const oversized = await provider({ regexMaxPatternBytes: 4 }).invoke(
      "recall",
      { scope: `session:${normal}`, query: "12345", queryMode: "regex" },
      invocationContext(cwd),
    ) as { coverage: { complete: boolean; error: { code: string } } };
    expect(oversized.coverage.complete).toBe(false);
    expect(oversized.coverage.error.code).toBe("regex_pattern_too_large");

    const bounded = seed("bounded-regex.jsonl", "bounded-regex", ["first", "second"]);
    const boundedResult = await provider({ regexMaxHaystackTerms: 1 }).invoke(
      "recall",
      { scope: `session:${bounded}`, branches: "all", query: "absent", queryMode: "regex" },
      invocationContext(cwd),
    ) as { coverage: { complete: boolean; reasons: string[] } };
    expect(boundedResult.coverage.complete).toBe(false);
    expect(boundedResult.coverage.reasons).toContain("regex_max_haystack_terms");

    const catastrophic = seed("catastrophic.jsonl", "catastrophic", [`${"a".repeat(80_000)}!`]);
    const started = Date.now();
    const timedOut = await provider({ regexTimeoutMs: 50 }).invoke(
      "recall",
      { scope: `session:${catastrophic}`, query: "(a+)+$", queryMode: "regex" },
      invocationContext(cwd),
    ) as {
      coverage: { complete: boolean; error: { code: string }; reasons: string[] };
      matchedCount: number;
    };
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(timedOut.matchedCount).toBe(0);
    expect(timedOut.coverage.complete).toBe(false);
    expect(timedOut.coverage.error.code).toBe("regex_timeout");
    expect(timedOut.coverage.reasons).toContain("regex_timeout");
  });

  it("returns bounded cold session pointers without invented contiguous ranges", async () => {
    const base = Math.floor(Date.now() / 1_000) - 100;
    const cold = seed("cold.jsonl", "cold", ["needle first", "middle", "needle last"]);
    const hot = seed("hot.jsonl", "hot", ["unrelated"]);
    fs.utimesSync(cold, base, base);
    fs.utimesSync(hot, base + 1, base + 1);

    const pointer = await provider().invoke(
      "recall",
      { scope: "project", branches: "all", query: "needle" },
      invocationContext(cwd),
    ) as { digestHits: Array<Record<string, unknown>> };
    expect(pointer.digestHits).toHaveLength(1);
    expect(pointer.digestHits[0]).toEqual(expect.objectContaining({
      sessionFile: cold,
      sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(pointer.digestHits[0]).not.toHaveProperty("entryRange");
    expect(pointer.digestHits[0]).not.toHaveProperty("entryIds");

    const hit = pointer.digestHits[0] as { sessionFile: string; sourceHash: string };
    const hydrated = await provider().invoke(
      "recall",
      {
        scope: `session:${hit.sessionFile}`,
        expectedSourceHash: hit.sourceHash,
        branches: "all",
        query: "needle",
      },
      invocationContext(cwd),
    ) as { segments: Array<{ exactMatches: Array<{ index: number; entryId: string }> }> };
    expect(hydrated.segments.flatMap((segment) => segment.exactMatches).map((match) => match.index))
      .toEqual([0, 2]);
  });

  it("rejects stale pointers after a same-path source rewrite", async () => {
    const base = Math.floor(Date.now() / 1_000) - 100;
    const cold = seed("stale.jsonl", "stale", ["remember stale_token"]);
    const hot = seed("new.jsonl", "new", ["new work"]);
    fs.utimesSync(cold, base, base);
    fs.utimesSync(hot, base + 1, base + 1);
    const pointer = await provider().invoke(
      "recall",
      { scope: "project", query: "stale_token" },
      invocationContext(cwd),
    ) as { digestHits: Array<{ sessionFile: string; sourceHash: string }> };
    const hit = pointer.digestHits[0]!;
    fs.appendFileSync(cold, `${JSON.stringify(message("changed", "rewritten"))}\n`);

    const hydrated = await provider().invoke(
      "recall",
      {
        scope: `session:${hit.sessionFile}`,
        expectedSourceHash: hit.sourceHash,
        query: "stale_token",
      },
      invocationContext(cwd),
    ) as { error: { code: string } };
    expect(hydrated.error.code).toBe("stale_pointer");

    const expanded = await provider().invoke(
      "expand",
      { session: hit.sessionFile, expectedSourceHash: hit.sourceHash, indices: [0] },
      invocationContext(cwd),
    ) as { error: { code: string } };
    expect(expanded.error.code).toBe("stale_pointer");
  });

  it("refuses ambiguous duplicate session ids and accepts exact paths", async () => {
    const first = seed("one.jsonl", "duplicate", ["first"], "/work/one");
    seed("two.jsonl", "duplicate", ["second"], "/work/two");
    const ambiguous = await provider().invoke(
      "expand",
      { session: "duplicate", indices: [0] },
      invocationContext(cwd),
    ) as { error: { code: string; candidates: string[] } };
    expect(ambiguous.error.code).toBe("ambiguous_session");
    expect(ambiguous.error.candidates).toHaveLength(2);

    const exact = await provider().invoke(
      "expand",
      { session: first, indices: [0] },
      invocationContext(cwd),
    ) as { expanded: Array<{ text: string }> };
    expect(exact.expanded[0]!.text).toBe("first");
  });

  it("reports index bounds instead of silently dropping invalid addresses", async () => {
    const file = seed("bounds.jsonl", "bounds", ["zero", "one"]);
    const negative = await provider().invoke(
      "expand",
      { session: file, indices: [-1] },
      invocationContext(cwd),
    ) as { error: { code: string } };
    expect(negative.error.code).toBe("index_out_of_bounds");

    const beyond = await provider().invoke(
      "expand",
      { session: file, branches: "all", entryRange: { first: 0, last: 2 } },
      invocationContext(cwd),
    ) as { error: { code: string; entryCount: number } };
    expect(beyond.error).toEqual(expect.objectContaining({ code: "index_out_of_bounds", entryCount: 2 }));
  });

  it("marks oversized vocabulary and cache-sync budgets incomplete", async () => {
    seed("vocabulary.jsonl", "vocabulary", ["alpha beta gamma delta epsilon"]);
    const vocabulary = await provider({
      hotSessions: 0,
      maxColdVocabularyBytes: 10,
    }).invoke(
      "recall",
      { scope: "project", query: "epsilon" },
      invocationContext(cwd),
    ) as { coverage: { complete: boolean; reasons: string[]; incompleteSessions: number }; text: string };
    expect(vocabulary.coverage.complete).toBe(false);
    expect(vocabulary.coverage.incompleteSessions).toBe(1);
    expect(vocabulary.coverage.reasons).toContain("max_cold_vocabulary_bytes");
    expect(vocabulary.text).toContain("No indexed matches");

    seed("budget-2.jsonl", "budget-2", ["second"]);
    seed("budget-3.jsonl", "budget-3", ["third"]);
    const budget = await provider({ hotSessions: 0, maxSyncSessions: 1 }).invoke(
      "recall",
      { scope: "project", query: "absent" },
      invocationContext(cwd),
    ) as { coverage: { complete: boolean; indexedSessions: number; eligibleSessions: number; reasons: string[] } };
    expect(budget.coverage).toEqual(expect.objectContaining({
      complete: false,
      indexedSessions: 1,
      eligibleSessions: 3,
    }));
    expect(budget.coverage.reasons).toContain("max_sync_sessions");
  });

  it("keeps unique-token cold caches within source ratio and configured hard bounds", async () => {
    const tokens = Array.from({ length: 2_000 }, (_, index) => `unique_${String(index).padStart(5, "0")}`);
    const file = seed("ratio.jsonl", "ratio", tokens.map((token) => `${token} context payload`));
    const hardBound = 128 * 1024;
    const result = await provider({
      hotSessions: 0,
      maxColdVocabularyBytes: hardBound,
      maxColdCacheBytes: hardBound,
    }).invoke(
      "recall",
      { scope: "project", query: "unique_01999" },
      invocationContext(cwd),
    ) as { digestHits: unknown[] };
    expect(result.digestHits).toHaveLength(1);
    const cache = digestPathForSession(file, indexDir);
    const cacheBytes = fs.statSync(cache).size;
    const sourceBytes = fs.statSync(file).size;
    const ratio = cacheBytes / sourceBytes;
    expect(cacheBytes).toBeLessThanOrEqual(hardBound);
    expect(ratio).toBeLessThanOrEqual(1);
    const persisted = JSON.parse(fs.readFileSync(cache, "utf8")) as {
      vocabulary: unknown[];
      cacheBytes: number;
      cacheSourceRatio: number;
    };
    expect(persisted.vocabulary.every((term) => typeof term === "string")).toBe(true);
    expect(persisted.cacheBytes).toBeGreaterThan(0);
    expect(persisted.cacheBytes).toBeLessThanOrEqual(hardBound);
    expect(persisted.cacheSourceRatio).toBeCloseTo(persisted.cacheBytes / sourceBytes, 5);
  });

  it("quarantines malformed, orphaned, and deleted-source caches during refresh", async () => {
    const file = seed("cleanup.jsonl", "cleanup", ["cleanup token"]);
    await provider({ hotSessions: 0 }).invoke(
      "recall",
      { scope: "project", query: "cleanup" },
      invocationContext(cwd),
    );
    const derived = digestPathForSession(file, indexDir);
    expect(fs.existsSync(derived)).toBe(true);
    const malformed = path.join(indexDir, "malformed.json");
    const orphan = path.join(indexDir, "orphan.digest.json");
    fs.writeFileSync(malformed, "{broken", "utf8");
    fs.writeFileSync(orphan, JSON.stringify({
      cacheVersion: 5,
      kind: "digest",
      file: path.join(agentDir, "missing.jsonl"),
    }), "utf8");
    fs.rmSync(file);

    await provider({ hotSessions: 0 }).invoke(
      "recall",
      { scope: "project", query: "cleanup" },
      invocationContext(cwd),
    );
    expect(fs.existsSync(malformed)).toBe(false);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(derived)).toBe(false);
  });
});
