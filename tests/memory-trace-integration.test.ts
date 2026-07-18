import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeSession, expandSessionEntries } from "../src/memory/normalize.js";
import { loadDigest, loadShard } from "../src/memory/index.js";
import { searchShards } from "../src/memory/search.js";
import { MemoryProvider } from "../src/providers/memory-provider.js";
import { encodeCwdDir } from "../src/memory/discovery.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import type { FabricMemoryConfig } from "../src/config.js";
import {
  assistantToolCall,
  messageEntry,
  sessionHeader,
  toolResult,
  writeSessionFile,
} from "./fixtures/memory.js";
import { recordedIntegrationTrace } from "./fixtures/fabric-execution-trace.js";

const temporary: string[] = [];
const temp = (name: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fabric-${name}-`));
  temporary.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const timestamp = (second: number): string => `2025-02-01T00:00:${String(second).padStart(2, "0")}.000Z`;

const traceToolResult = (details: unknown): Record<string, unknown> => ({
  ...toolResult("fabric-call", "fabric_exec", "fake prose pi.write path=prose-only.ts Error", false),
  details,
});

const fixture = (agentDir: string, cwd: string, details: unknown): string =>
  writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), "trace.jsonl", [
    sessionHeader("trace-session", cwd),
    messageEntry("e1", null, timestamp(1), assistantToolCall(
      "fabric-call",
      "fabric_exec",
      { code: "pi.edit({path:'source-only.ts'}); throw new Error('source prose')" },
    )),
    messageEntry("e2", "e1", timestamp(2), traceToolResult(details)),
    {
      type: "branch_summary",
      id: "e3",
      parentId: "e2",
      timestamp: timestamp(3),
      fromId: "sibling",
      summary: "BRANCH_SUMMARY_PROSE_POISON",
    },
  ]);

const invocation = (cwd: string): FabricInvocationContext => ({
  cwd,
  signal: undefined,
  parentToolCallId: "parent",
  nestedToolCallId: "nested",
  extensionContext: {} as FabricInvocationContext["extensionContext"],
  update() {},
});

describe("memory Fabric trace records", () => {
  it("emits independently searchable children after the outer entry with exact structural fields", () => {
    const agentDir = temp("memory-trace-agent");
    const cwd = "/project/trace";
    const file = fixture(agentDir, cwd, { trace: recordedIntegrationTrace() });
    const { entries } = normalizeSession(file, 200_000);
    const outer = entries.find((entry) => entry.entryId === "e2");
    const children = entries.filter((entry) => entry.type === "fabric_operation");
    expect(outer).toBeDefined();
    expect(children).toHaveLength(13);
    expect(children[0]!.index).toBe(outer!.index + 1);
    expect(children.map((entry) => entry.operationAddress)).toEqual(
      Array.from({ length: 13 }, (_, sequence) => `e2/${sequence}`),
    );
    expect(children[0]).toMatchObject({
      entryId: "e2/0",
      parentEntryId: "e2",
      toolName: "read",
      ref: "pi.read",
      provider: "pi",
      action: "read",
      outcome: "succeeded",
      filesTouched: ["src/read.ts"],
    });
    expect(children[5]).toMatchObject({ toolName: "bash", outcome: "failed", isError: true });
    expect(children[7]).toMatchObject({ toolName: "run", ref: "agents.run", provider: "agents" });
    expect(entries.find((entry) => entry.entryId === "e3")?.text).toBe("");
  });

  it("supports tool filters, operation-address expansion, and cold vocabulary", async () => {
    const agentDir = temp("memory-trace-search");
    const indexDir = temp("memory-trace-index");
    const cwd = "/project/search";
    const file = fixture(agentDir, cwd, { trace: recordedIntegrationTrace() });
    const ref = { id: "trace-session", file, cwd, mtime: fs.statSync(file).mtimeMs };
    const options = { indexDir, maxEntryChars: 2_000, hotSessions: 1, digestTerms: 2 };
    const shard = loadShard(ref, options);

    const reads = await searchShards([shard], { query: "read", filters: { tool: "read" } });
    expect(reads.matchedCount).toBeGreaterThan(0);
    expect(reads.segments.flatMap((segment) => segment.entries)
      .filter((item) => item.matched)
      .every((item) => item.entry.toolName === "read")).toBe(true);
    const bash = await searchShards([shard], { query: "pnpm", filters: { tool: "bash" } });
    expect(bash.matchedCount).toBe(2);
    expect(bash.segments.flatMap((segment) => segment.exactMatches)
      .map((match) => match.operationAddress)
      .filter(Boolean)).toEqual(["e2/5", "e2/6"]);
    for (const query of ["agents", "state", "mesh"]) {
      expect((await searchShards([shard], { query })).matchedCount).toBeGreaterThan(0);
    }
    expect((await searchShards([shard], { query: "source-only" })).matchedCount).toBeGreaterThan(0);
    expect((await searchShards([shard], { query: "BRANCH_SUMMARY_PROSE_POISON" })).matchedCount).toBe(0);

    const expanded = expandSessionEntries(file, { operationAddresses: ["e2/5"] });
    expect(expanded).toHaveLength(1);
    expect(expanded[0]).toMatchObject({
      entryId: "e2/5",
      operationAddress: "e2/5",
      parentEntryId: "e2",
      ref: "pi.bash",
      outcome: "failed",
    });
    expect(expanded[0]!.operation?.args).toEqual({ command: "pnpm test", timeout: 30 });
    expect(expanded[0]!.operation?.error).toBe("typed test failure");

    const digest = loadDigest(ref, { ...options, hotSessions: 0 });
    const vocabulary = new Set(digest.vocabulary);
    for (const term of ["agents", "state", "mesh", "bash", "read"]) expect(vocabulary.has(term)).toBe(true);
    expect(digest.toolHistogram).toMatchObject({ read: 1, bash: 2, run: 1, get: 1, query: 1 });

    const config: FabricMemoryConfig = {
      enabled: true,
      indexDir,
      maxSessions: 100,
      maxEntryChars: 2_000,
      hotSessions: 1,
      digestTerms: 2,
    };
    const provider = new MemoryProvider({ agentDir, cwd, config, sessionId: "trace-session", sessionFile: file });
    const providerExpanded = await provider.invoke(
      "expand",
      { session: file, operationAddresses: ["e2/7"] },
      invocation(cwd),
    ) as { expanded: Array<{ operationAddress?: string; ref?: string }> };
    expect(providerExpanded.expanded).toMatchObject([{ operationAddress: "e2/7", ref: "agents.run" }]);
  });

  it("ignores malformed and unknown trace versions instead of adapting audits", () => {
    const agentDir = temp("memory-trace-invalid");
    const cwd = "/project/invalid";
    const file = fixture(agentDir, cwd, {
      trace: { ...recordedIntegrationTrace(), version: 9 },
      audits: [{ ref: "pi.read", args: { path: "legacy-must-not-appear.ts" }, success: true }],
    });
    expect(normalizeSession(file, 2_000).entries.filter((entry) => entry.type === "fabric_operation")).toEqual([]);
  });
});
