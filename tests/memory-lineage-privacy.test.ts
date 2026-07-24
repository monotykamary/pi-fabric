import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { FabricMemoryConfig } from "../src/config.js";
import { encodeCwdDir } from "../src/memory/discovery.js";
import { digestPathForSession, shardPathForSession } from "../src/memory/index.js";
import { MemoryProvider, type MemoryProviderContext } from "../src/providers/memory-provider.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import {
  assistantText,
  messageEntry,
  sessionHeader,
  toolResult,
  userMessage,
  writeSessionFile,
  type FixtureEntry,
} from "./fixtures/memory.js";

const temporaryDirectories: string[] = [];
const temporaryDirectory = (name: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fabric-memory-lineage-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const timestamp = (offset: number): string =>
  new Date(1_700_000_000_000 + offset * 1_000).toISOString();

const message = (
  id: string,
  parentId: string | null,
  text: string,
  offset: number,
): FixtureEntry => messageEntry(id, parentId, timestamp(offset), userMessage(text));

const invocation = (cwd: string): FabricInvocationContext => ({
  cwd,
  signal: undefined,
  parentToolCallId: "memory-lineage",
  nestedToolCallId: "memory-lineage-nested",
  extensionContext: {} as FabricInvocationContext["extensionContext"],
  update() {},
});

const memoryConfig = (
  indexDir: string,
  overrides: Partial<FabricMemoryConfig> = {},
): FabricMemoryConfig => ({
  enabled: true,
  indexDir,
  maxSessions: 500,
  maxEntryChars: 20_000,
  indexThinking: false,
  indexToolOutput: true,
  hotSessions: 50,
  ...overrides,
});

const branchDetails = (facts: Array<Record<string, unknown>>) => ({
  kind: "pi-fabric.branch-summary",
  version: 1,
  source: { firstEntryId: "abandoned-source", lastEntryId: "abandoned-source", entryCount: 1 },
  facts,
  omittedFacts: 0,
  sections: ["[Fabric Activity]"],
  request: { text: "", sourceBytes: 0, truncated: false },
});

describe("memory active lineage and privacy policy", () => {
  it("defaults to the latest persisted parent-linked branch and exposes siblings only in all mode", async () => {
    const agentDir = temporaryDirectory("tree-agent");
    const indexDir = temporaryDirectory("tree-index");
    const cwd = "/work/tree";
    const file = writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), "tree.jsonl", [
      sessionHeader("tree", cwd),
      message("root", null, "shared root", 0),
      message("abandoned", "root", "ABANDONED_SIBLING_DECOY_71", 1),
      message("abandoned-leaf", "abandoned", "abandoned continuation", 2),
      message("active-leaf", "root", "ACTIVE_LINEAGE_FACT_82", 3),
    ]);
    const provider = new MemoryProvider({
      agentDir,
      cwd,
      sessionFile: file,
      sessionId: "tree",
      config: memoryConfig(indexDir),
    });

    const active = await provider.invoke(
      "recall",
      { scope: "session", query: "ABANDONED_SIBLING_DECOY_71" },
      invocation(cwd),
    ) as { branches: string; matchedCount: number };
    expect(active).toEqual(expect.objectContaining({ branches: "active", matchedCount: 0 }));

    const all = await provider.invoke(
      "recall",
      { scope: "session", branches: "all", query: "ABANDONED_SIBLING_DECOY_71" },
      invocation(cwd),
    ) as { branches: string; matchedCount: number; segments: Array<{ branches: string }> };
    expect(all.matchedCount).toBe(1);
    expect(all.branches).toBe("all");
    expect(all.segments[0]!.branches).toBe("all");
  });

  it("uses the current live SessionManager branch getter after navigation without an append", async () => {
    const agentDir = temporaryDirectory("live-agent");
    const indexDir = temporaryDirectory("live-index");
    const cwd = "/work/live";
    const file = writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), "live.jsonl", [
      sessionHeader("live", cwd),
      message("root", null, "root", 0),
      message("navigated-leaf", "root", "LIVE_NAVIGATED_FACT_93", 1),
      message("last-appended-leaf", "root", "LAST_APPEND_DECOY_94", 2),
    ]);
    const manager = SessionManager.open(file);
    manager.branch("navigated-leaf");
    const provider = new MemoryProvider({
      agentDir,
      cwd,
      sessionFile: file,
      sessionId: "live",
      config: memoryConfig(indexDir),
      getLiveBranch: () => ({
        entries: manager.getBranch(),
        leafId: manager.getLeafId(),
      }),
    });

    const navigated = await provider.invoke(
      "recall",
      { query: "LIVE_NAVIGATED_FACT_93" },
      invocation(cwd),
    ) as { matchedCount: number };
    const decoy = await provider.invoke(
      "recall",
      { query: "LAST_APPEND_DECOY_94" },
      invocation(cwd),
    ) as { matchedCount: number };
    expect(navigated.matchedCount).toBe(1);
    expect(decoy.matchedCount).toBe(0);
  });

  it("keeps cold active and all vocabularies in separate non-contaminating caches", async () => {
    const agentDir = temporaryDirectory("cold-agent");
    const indexDir = temporaryDirectory("cold-index");
    const cwd = "/work/cold-lineage";
    const file = writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), "cold.jsonl", [
      sessionHeader("cold-tree", cwd),
      message("root", null, "root vocabulary", 0),
      message("sibling", "root", "COLD_SIBLING_VOCAB_15", 1),
      message("active", "root", "COLD_ACTIVE_VOCAB_16", 2),
    ]);
    const provider = new MemoryProvider({
      agentDir,
      cwd,
      config: memoryConfig(indexDir, { hotSessions: 0 }),
    });

    const active = await provider.invoke(
      "recall",
      { scope: "project", query: "COLD_SIBLING_VOCAB_15" },
      invocation(cwd),
    ) as { matchedCount: number };
    const all = await provider.invoke(
      "recall",
      { scope: "project", branches: "all", query: "COLD_SIBLING_VOCAB_15" },
      invocation(cwd),
    ) as { matchedCount: number };
    const activeAgain = await provider.invoke(
      "recall",
      { scope: "project", query: "COLD_SIBLING_VOCAB_15" },
      invocation(cwd),
    ) as { matchedCount: number };
    expect(active.matchedCount).toBe(0);
    expect(all.matchedCount).toBe(1);
    expect(activeAgain.matchedCount).toBe(0);

    const activeCache = JSON.parse(fs.readFileSync(digestPathForSession(file, indexDir), "utf8")) as {
      branches: string;
      vocabulary: string[];
    };
    const allCache = JSON.parse(fs.readFileSync(digestPathForSession(file, indexDir, "all"), "utf8")) as {
      branches: string;
      vocabulary: string[];
    };
    expect(activeCache.branches).toBe("active");
    expect(activeCache.vocabulary).not.toContain("cold_sibling_vocab_15");
    expect(allCache.branches).toBe("all");
    expect(allCache.vocabulary).toContain("cold_sibling_vocab_15");
  });

  it("refuses off-lineage addresses by default, expands them in all mode, and binds active pointers to lineage", async () => {
    const agentDir = temporaryDirectory("expand-agent");
    const indexDir = temporaryDirectory("expand-index");
    const cwd = "/work/expand-lineage";
    const file = writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), "expand.jsonl", [
      sessionHeader("expand-tree", cwd),
      message("root", null, "root", 0),
      message("off-lineage", "root", "OFF_LINEAGE_EXPAND_21", 1),
      message("active-leaf", "root", "ACTIVE_POINTER_FACT_22", 2),
    ]);
    let live = {
      entries: [{ id: "root" }, { id: "active-leaf" }],
      leafId: "active-leaf" as string | null,
    };
    const context: MemoryProviderContext = {
      agentDir,
      cwd,
      sessionFile: file,
      sessionId: "expand-tree",
      config: memoryConfig(indexDir),
      getLiveBranch: () => live,
    };
    const provider = new MemoryProvider(context);

    const hidden = await provider.invoke(
      "expand",
      { session: file, entryIds: ["off-lineage"] },
      invocation(cwd),
    ) as { error: { code: string }; expanded: unknown[] };
    expect(hidden.error.code).toBe("address_not_found");
    expect(hidden.expanded).toEqual([]);

    const visible = await provider.invoke(
      "expand",
      { session: file, branches: "all", entryIds: ["off-lineage"] },
      invocation(cwd),
    ) as { branches: string; expanded: Array<{ entryId: string }> };
    expect(visible.branches).toBe("all");
    expect(visible.expanded[0]!.entryId).toBe("off-lineage");

    const recalled = await provider.invoke(
      "recall",
      { scope: "session", query: "ACTIVE_POINTER_FACT_22" },
      invocation(cwd),
    ) as {
      segments: Array<{ sourceHash: string; lineageFingerprint: string }>;
    };
    const pointer = recalled.segments[0]!;
    live = {
      entries: [{ id: "root" }, { id: "off-lineage" }],
      leafId: "off-lineage",
    };
    const staleLineage = await provider.invoke(
      "expand",
      {
        session: file,
        expectedSourceHash: pointer.sourceHash,
        expectedLineageFingerprint: pointer.lineageFingerprint,
        entryIds: ["active-leaf"],
      },
      invocation(cwd),
    ) as { error: { code: string; actualLineageFingerprint: string } };
    expect(staleLineage.error.code).toBe("stale_pointer");
    expect(staleLineage.error.actualLineageFingerprint).not.toBe(pointer.lineageFingerprint);

    fs.appendFileSync(file, `${JSON.stringify(message("new-source", "off-lineage", "new", 3))}\n`);
    const staleSource = await provider.invoke(
      "expand",
      {
        session: file,
        branches: "all",
        expectedSourceHash: pointer.sourceHash,
        indices: [0],
      },
      invocation(cwd),
    ) as { error: { code: string } };
    expect(staleSource.error.code).toBe("stale_pointer");
  });

  it("keeps compaction and typed branch-summary carriers on the active path searchable and expandable", async () => {
    const agentDir = temporaryDirectory("summary-agent");
    const indexDir = temporaryDirectory("summary-index");
    const cwd = "/work/summary-lineage";
    const fact = {
      kind: "user",
      entryId: "abandoned-source",
      subordinal: "user",
      address: "abandoned-source/user",
      text: "ACTIVE_CARRIER_TYPED_FACT_31",
    };
    const carrier = {
      type: "branch_summary",
      id: "summary-carrier",
      parentId: "compaction-carrier",
      timestamp: timestamp(2),
      fromId: "abandoned-source",
      summary: "ignored summary prose",
      details: branchDetails([fact]),
    } as FixtureEntry;
    const file = writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), "summary.jsonl", [
      sessionHeader("summary", cwd),
      message("root", null, "root", 0),
      message("abandoned-source", "root", "off-lineage source", 1),
      {
        type: "compaction",
        id: "compaction-carrier",
        parentId: "root",
        timestamp: timestamp(2),
        summary: "ACTIVE_COMPACTION_CARRIER_30",
        firstKeptEntryId: "root",
        tokensBefore: 100,
      } as FixtureEntry,
      carrier,
    ]);
    const provider = new MemoryProvider({ agentDir, cwd, config: memoryConfig(indexDir) });

    const recalled = await provider.invoke(
      "recall",
      { scope: `session:${file}`, query: "ACTIVE_CARRIER_TYPED_FACT_31" },
      invocation(cwd),
    ) as { matchedCount: number };
    expect(recalled.matchedCount).toBe(1);
    const compacted = await provider.invoke(
      "recall",
      { scope: `session:${file}`, query: "ACTIVE_COMPACTION_CARRIER_30" },
      invocation(cwd),
    ) as { matchedCount: number };
    expect(compacted.matchedCount).toBe(1);
    const expanded = await provider.invoke(
      "expand",
      { session: file, entryIds: [fact.address] },
      invocation(cwd),
    ) as { expanded: Array<{ branchFact: { address: string }; carrierEntryId: string }> };
    expect(expanded.expanded[0]).toEqual(expect.objectContaining({
      carrierEntryId: "summary-carrier",
      branchFact: expect.objectContaining({ address: fact.address }),
    }));
  });

  it("applies thinking and tool-output indexing policy and rebuilds policy-bound caches", async () => {
    const agentDir = temporaryDirectory("privacy-agent");
    const indexDir = temporaryDirectory("privacy-index");
    const cwd = "/work/privacy";
    const assistant = messageEntry("assistant", null, timestamp(0), {
      ...assistantText("public response"),
      content: [
        { type: "thinking", thinking: "PRIVATE_THINKING_TOKEN_41" },
        { type: "text", text: "public response" },
        { type: "toolCall", id: "call", name: "read", arguments: { path: "src/privacy.ts" } },
      ],
    });
    const result = messageEntry(
      "result",
      "assistant",
      timestamp(1),
      toolResult("call", "read", "TOOL_OUTPUT_BODY_42", true),
    );
    const file = writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), "privacy.jsonl", [
      sessionHeader("privacy", cwd),
      assistant,
      result,
    ]);
    const provider = (overrides: Partial<FabricMemoryConfig> = {}) => new MemoryProvider({
      agentDir,
      cwd,
      config: memoryConfig(indexDir, overrides),
    });

    const thinkingDefault = await provider().invoke(
      "recall",
      { scope: "project", query: "PRIVATE_THINKING_TOKEN_41" },
      invocation(cwd),
    ) as { matchedCount: number };
    expect(thinkingDefault.matchedCount).toBe(0);
    const firstCache = JSON.parse(fs.readFileSync(shardPathForSession(file, indexDir), "utf8")) as {
      policy: string;
      entries: Array<{ text: string }>;
    };
    expect(firstCache.entries.every((entry) => !entry.text.includes("PRIVATE_THINKING_TOKEN_41"))).toBe(true);

    const thinkingOptIn = await provider({ indexThinking: true }).invoke(
      "recall",
      { scope: "project", query: "PRIVATE_THINKING_TOKEN_41" },
      invocation(cwd),
    ) as { matchedCount: number };
    expect(thinkingOptIn.matchedCount).toBe(1);
    const thinkingCache = JSON.parse(fs.readFileSync(shardPathForSession(file, indexDir), "utf8")) as {
      policy: string;
    };
    expect(thinkingCache.policy).not.toBe(firstCache.policy);

    const outputDefault = await provider().invoke(
      "recall",
      { scope: "project", query: "TOOL_OUTPUT_BODY_42" },
      invocation(cwd),
    ) as { matchedCount: number };
    expect(outputDefault.matchedCount).toBe(1);
    const outputOptOut = await provider({ indexToolOutput: false }).invoke(
      "recall",
      { scope: "project", query: "TOOL_OUTPUT_BODY_42" },
      invocation(cwd),
    ) as { matchedCount: number };
    expect(outputOptOut.matchedCount).toBe(0);
    const metadata = await provider({ indexToolOutput: false }).invoke(
      "recall",
      { scope: "project", query: "read privacy", tool: "read" },
      invocation(cwd),
    ) as { matchedCount: number };
    expect(metadata.matchedCount).toBeGreaterThan(0);
    const optOutCache = JSON.parse(fs.readFileSync(shardPathForSession(file, indexDir), "utf8")) as {
      policy: string;
      entries: Array<{ text: string }>;
    };
    expect(optOutCache.policy).not.toBe(thinkingCache.policy);
    expect(optOutCache.entries.some((entry) => entry.text.includes("toolResult(read) [error]"))).toBe(true);
    expect(optOutCache.entries.every((entry) => !entry.text.includes("TOOL_OUTPUT_BODY_42"))).toBe(true);
  });

  it("preserves project/global duplicate-session coverage and pagination in both branch modes", async () => {
    const agentDir = temporaryDirectory("scope-agent");
    const indexDir = temporaryDirectory("scope-index");
    const cwd = "/work/scope-a";
    const otherCwd = "/work/scope-b";
    const first = writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), "one.jsonl", [
      sessionHeader("duplicate-id", cwd),
      message("one", null, "SCOPE_COMMON_TOKEN_51", 0),
    ]);
    const second = writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(otherCwd)), "two.jsonl", [
      sessionHeader("duplicate-id", otherCwd),
      message("two", null, "SCOPE_COMMON_TOKEN_51", 0),
    ]);
    const provider = new MemoryProvider({ agentDir, cwd, config: memoryConfig(indexDir) });

    const project = await provider.invoke(
      "recall",
      { scope: "project", query: "SCOPE_COMMON_TOKEN_51" },
      invocation(cwd),
    ) as { coverage: { eligibleSessions: number }; totalItems: number };
    expect(project.coverage.eligibleSessions).toBe(1);
    expect(project.totalItems).toBe(1);

    for (const branches of ["active", "all"] as const) {
      const pageOne = await provider.invoke(
        "recall",
        { scope: "global", branches, query: "SCOPE_COMMON_TOKEN_51", page: 1, pageSize: 1 },
        invocation(cwd),
      ) as { coverage: { eligibleSessions: number }; totalItems: number; hasNext: boolean; items: unknown[] };
      const pageTwo = await provider.invoke(
        "recall",
        { scope: "global", branches, query: "SCOPE_COMMON_TOKEN_51", page: 2, pageSize: 1 },
        invocation(cwd),
      ) as { totalItems: number; hasNext: boolean; items: unknown[] };
      expect(pageOne.coverage.eligibleSessions).toBe(2);
      expect(pageOne).toEqual(expect.objectContaining({ totalItems: 2, hasNext: true }));
      expect(pageTwo).toEqual(expect.objectContaining({ totalItems: 2, hasNext: false }));
      expect(pageOne.items).toHaveLength(1);
      expect(pageTwo.items).toHaveLength(1);
    }

    expect(new Set([first, second]).size).toBe(2);
    const ambiguous = await provider.invoke(
      "expand",
      { session: "duplicate-id", indices: [0] },
      invocation(cwd),
    ) as { error: { code: string; candidates: string[] } };
    expect(ambiguous.error).toEqual(expect.objectContaining({
      code: "ambiguous_session",
      candidates: expect.arrayContaining([first, second]),
    }));
  });
});
