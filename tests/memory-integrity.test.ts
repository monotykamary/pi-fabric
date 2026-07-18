import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FabricMemoryConfig } from "../src/config.js";
import { encodeCwdDir } from "../src/memory/discovery.js";
import { loadShard } from "../src/memory/index.js";
import { normalizeSession } from "../src/memory/normalize.js";
import { searchShards } from "../src/memory/search.js";
import { MemoryProvider } from "../src/providers/memory-provider.js";
import type { FabricInvocationContext } from "../src/protocol.js";
import {
  assistantText,
  messageEntry,
  sessionHeader,
  userMessage,
  toolResult,
  writeSessionFile,
  type FixtureEntry,
} from "./fixtures/memory.js";
import { recordedIntegrationTrace } from "./fixtures/fabric-execution-trace.js";

const temporary: string[] = [];
const temp = (name: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fabric-memory-integrity-${name}-`));
  temporary.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const timestamp = (offset: number): string =>
  new Date(1_700_000_000_000 + offset * 1_000).toISOString();

const invocation = (cwd: string): FabricInvocationContext => ({
  cwd,
  signal: undefined,
  parentToolCallId: "memory-integrity",
  nestedToolCallId: "memory-integrity-nested",
  extensionContext: {} as FabricInvocationContext["extensionContext"],
  update() {},
});

const config = (indexDir: string, overrides: Partial<FabricMemoryConfig> = {}): FabricMemoryConfig => ({
  enabled: true,
  indexDir,
  maxSessions: 500,
  maxEntryChars: 2_000,
  hotSessions: 50,
  ...overrides,
});

const message = (id: string, text: string, offset = 0): FixtureEntry =>
  messageEntry(id, null, timestamp(offset), userMessage(text));

const branchDetails = (facts: Array<Record<string, unknown>>) => ({
  kind: "pi-fabric.branch-summary",
  version: 1,
  source: { firstEntryId: "source-first", lastEntryId: "source-last", entryCount: 2 },
  facts,
  omittedFacts: 0,
  sections: ["[Fabric Activity]"],
  request: { text: "", sourceBytes: 0, truncated: false },
});

describe("memory final integrity guarantees", () => {
  it("truncates only at Unicode scalar boundaries and marks hot-tail lexical coverage incomplete", async () => {
    const agentDir = temp("unicode-agent");
    const indexDir = temp("unicode-index");
    const cwd = "/work/unicode";
    const unicodeFile = writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), "unicode.jsonl", [
      sessionHeader("unicode", cwd),
      message("unicode-entry", "a😀b"),
    ]);
    const normalized = normalizeSession(unicodeFile, 2);
    expect(normalized.entries[0]!.text).toBe("a😀");
    expect(Buffer.from(normalized.entries[0]!.text, "utf8").toString("utf8")).toBe("a😀");
    expect(normalized.indexCoverage).toEqual({ complete: false, reasons: ["max_entry_chars"] });

    const tailFile = writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), "tail.jsonl", [
      sessionHeader("tail", cwd),
      message("tail-entry", "prefix payload rare_tail_token"),
    ]);
    fs.utimesSync(tailFile, Date.now() / 1_000 + 1, Date.now() / 1_000 + 1);
    const provider = new MemoryProvider({
      agentDir,
      cwd,
      config: config(indexDir, { maxEntryChars: 8, hotSessions: 50 }),
    });
    const result = await provider.invoke(
      "recall",
      { scope: `session:${tailFile}`, query: "rare_tail_token" },
      invocation(cwd),
    ) as { coverage: { complete: boolean; reasons: string[] }; matchedCount: number; text: string };
    expect(result.matchedCount).toBe(0);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.reasons).toContain("max_entry_chars");
    expect(result.text).toContain("No indexed matches");
  });

  it("marks duplicate identities and refuses missing or ambiguous expansion addresses", async () => {
    const agentDir = temp("duplicate-agent");
    const indexDir = temp("duplicate-index");
    const cwd = "/work/duplicates";
    const file = writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), "duplicates.jsonl", [
      sessionHeader("duplicates", cwd),
      message("same-entry", "first"),
      message("same-entry", "second", 1),
    ]);
    const ref = { id: "duplicates", file, cwd, mtime: fs.statSync(file).mtimeMs };
    expect(loadShard(ref, { indexDir, maxEntryChars: 2_000 }).indexCoverage)
      .toEqual({ complete: false, reasons: ["duplicate_entry_id"] });

    const provider = new MemoryProvider({ agentDir, cwd, config: config(indexDir) });
    const ambiguous = await provider.invoke(
      "expand",
      { session: file, entryIds: ["same-entry"] },
      invocation(cwd),
    ) as { error: { code: string; matches: number }; expanded: unknown[] };
    expect(ambiguous.error).toEqual(expect.objectContaining({ code: "ambiguous_address", matches: 2 }));
    expect(ambiguous.expanded).toEqual([]);

    const missing = await provider.invoke(
      "expand",
      { session: file, entryIds: ["absent-entry"] },
      invocation(cwd),
    ) as { error: { code: string; matches: number }; expanded: unknown[] };
    expect(missing.error).toEqual(expect.objectContaining({ code: "address_not_found", matches: 0 }));
    expect(missing.expanded).toEqual([]);
  });

  it("detects duplicate direct operation addresses and refuses ambiguous operation expansion", async () => {
    const agentDir = temp("duplicate-operation-agent");
    const indexDir = temp("duplicate-operation-index");
    const cwd = "/work/duplicate-operation";
    const duplicateResult = (offset: number): FixtureEntry => messageEntry(
      "same-carrier",
      null,
      timestamp(offset),
      { ...toolResult("fabric-call", "fabric_exec", "ignored"), details: { trace: recordedIntegrationTrace() } },
    );
    const file = writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), "operations.jsonl", [
      sessionHeader("operations", cwd),
      duplicateResult(0),
      duplicateResult(1),
    ]);
    const normalized = normalizeSession(file, 200_000);
    expect(normalized.indexCoverage.reasons).toEqual([
      "duplicate_entry_id",
      "duplicate_operation_address",
    ]);

    const provider = new MemoryProvider({ agentDir, cwd, config: config(indexDir, { maxEntryChars: 200_000 }) });
    const expanded = await provider.invoke(
      "expand",
      { session: file, operationAddresses: ["same-carrier/0"] },
      invocation(cwd),
    ) as { error: { code: string; matches: number }; expanded: unknown[] };
    expect(expanded.error).toEqual(expect.objectContaining({ code: "ambiguous_address", matches: 2 }));
    expect(expanded.expanded).toEqual([]);
  });

  it("normalizes typed branch facts, preserves carrier identity and paths, and deduplicates nested carriers", async () => {
    const agentDir = temp("branch-agent");
    const indexDir = temp("branch-index");
    const cwd = "/work/branch";
    const operation = {
      kind: "operation",
      entryId: "abandoned-result",
      subordinal: "call:write-1",
      address: "abandoned-result/call:write-1",
      ref: "pi.write",
      provider: "pi",
      action: "write",
      tool: "write",
      args: { path: "src/abandoned.ts", content: "typed" },
      outcome: "succeeded",
      result: { bytes: 5 },
    };
    const direct = {
      type: "branch_summary",
      id: "carrier-original",
      parentId: null,
      timestamp: timestamp(1),
      fromId: "abandoned-result",
      summary: "prose must not be parsed",
      details: branchDetails([operation]),
    } as FixtureEntry;
    const nested = {
      ...direct,
      id: "carrier-fork",
      parentId: "carrier-original",
      timestamp: timestamp(2),
      fromId: "nested-source",
      summary: "nested prose must not be parsed",
    } as FixtureEntry;
    const file = writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), "branch.jsonl", [
      sessionHeader("branch", cwd),
      direct,
      nested,
    ]);
    const normalized = normalizeSession(file, 20_000);
    const facts = normalized.entries.filter((entry) => entry.type === "fabric_branch_fact");
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      entryId: operation.address,
      operationAddress: operation.address,
      factAddress: operation.address,
      carrierEntryId: "carrier-original",
      carrierFromId: "abandoned-result",
      ref: "pi.write",
      provider: "pi",
      toolName: "write",
      outcome: "succeeded",
      filesTouched: ["src/abandoned.ts"],
    });

    const provider = new MemoryProvider({ agentDir, cwd, config: config(indexDir) });
    const expanded = await provider.invoke(
      "expand",
      { session: file, operationAddresses: [operation.address] },
      invocation(cwd),
    ) as { expanded: Array<Record<string, unknown>> };
    expect(expanded.expanded).toHaveLength(1);
    expect(expanded.expanded[0]).toEqual(expect.objectContaining({
      operationAddress: operation.address,
      carrierEntryId: "carrier-original",
      filesTouched: ["src/abandoned.ts"],
      branchFact: expect.objectContaining({ address: operation.address, tool: "write" }),
    }));
  });

  it("requires unique addresses inside branch details and reports duplicate operations", () => {
    const agentDir = temp("branch-duplicate-agent");
    const cwd = "/work/branch-duplicate";
    const operation = {
      kind: "operation",
      entryId: "source",
      subordinal: "0",
      address: "source/0",
      ref: "pi.read",
      provider: "pi",
      action: "read",
      tool: "read",
      args: { path: "src/file.ts" },
      outcome: "succeeded",
    };
    const file = writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), "duplicate-facts.jsonl", [
      sessionHeader("duplicate-facts", cwd),
      {
        type: "branch_summary",
        id: "carrier",
        parentId: null,
        timestamp: timestamp(1),
        fromId: "source",
        summary: "ignored",
        details: branchDetails([operation, operation]),
      } as FixtureEntry,
    ]);
    const normalized = normalizeSession(file, 20_000);
    expect(normalized.entries.filter((entry) => entry.type === "fabric_branch_fact")).toEqual([]);
    expect(normalized.indexCoverage.reasons).toEqual([
      "duplicate_branch_fact_address",
      "duplicate_operation_address",
    ]);
  });

  it("paginates the globally ranked mixed item stream once and browses beyond the first page", async () => {
    const agentDir = temp("pagination-agent");
    const indexDir = temp("pagination-index");
    const cwd = "/work/pagination";
    const directory = path.join(agentDir, "sessions", encodeCwdDir(cwd));
    const cold = writeSessionFile(directory, "cold.jsonl", [
      sessionHeader("cold", cwd),
      message("cold-entry", "shared pagination token"),
    ]);
    const hot = writeSessionFile(directory, "hot.jsonl", [
      sessionHeader("hot", cwd),
      messageEntry("hot-user", null, timestamp(0), userMessage("shared pagination token")),
      messageEntry("hot-assistant", "hot-user", timestamp(1), assistantText("shared pagination token")),
    ]);
    const base = Math.floor(Date.now() / 1_000) - 100;
    fs.utimesSync(cold, base, base);
    fs.utimesSync(hot, base + 1, base + 1);
    const provider = new MemoryProvider({ agentDir, cwd, config: config(indexDir, { hotSessions: 1 }) });

    const first = await provider.invoke(
      "recall",
      { scope: "project", query: "shared pagination token", page: 1, pageSize: 1 },
      invocation(cwd),
    ) as { items: Array<{ kind: string }>; totalItems: number; totalMatches: number; hasNext: boolean };
    const second = await provider.invoke(
      "recall",
      { scope: "project", query: "shared pagination token", page: 2, pageSize: 1 },
      invocation(cwd),
    ) as { items: Array<{ kind: string }>; totalItems: number; totalMatches: number; hasNext: boolean };
    expect(first.totalItems).toBe(2);
    expect(first.totalMatches).toBe(3);
    expect(second).toEqual(expect.objectContaining({ totalItems: 2, totalMatches: 3, hasNext: false }));
    expect(new Set([first.items[0]!.kind, second.items[0]!.kind])).toEqual(new Set(["entry", "digest"]));
    expect(first.hasNext).toBe(true);

    const browseFile = writeSessionFile(directory, "browse.jsonl", [
      sessionHeader("browse", cwd),
      ...Array.from({ length: 5 }, (_, index) => message(`browse-${index}`, `browse ${index}`, index)),
    ]);
    fs.utimesSync(browseFile, base + 2, base + 2);
    const browse = await provider.invoke(
      "recall",
      { scope: `session:${browseFile}`, page: 2, pageSize: 2 },
      invocation(cwd),
    ) as { items: unknown[]; totalItems: number; totalMatches: number; hasNext: boolean };
    expect(browse).toEqual(expect.objectContaining({ totalItems: 5, totalMatches: 5, hasNext: true }));
    expect(browse.items).toHaveLength(2);
  });

  it("marks explicit candidate budget exhaustion incomplete", async () => {
    const agentDir = temp("budget-agent");
    const indexDir = temp("budget-index");
    const cwd = "/work/candidate-budget";
    const file = writeSessionFile(path.join(agentDir, "sessions", encodeCwdDir(cwd)), "budget.jsonl", [
      sessionHeader("budget", cwd),
      message("one", "token one"),
      message("two", "token two", 1),
      message("three", "token three", 2),
    ]);
    const shard = loadShard(
      { id: "budget", file, cwd, mtime: fs.statSync(file).mtimeMs },
      { indexDir, maxEntryChars: 2_000 },
    );
    const result = await searchShards([shard], {
      query: "token",
      candidateLimits: { maxEntries: 2, maxDigests: 2, maxItems: 2 },
    });
    expect(result.queryCoverage.complete).toBe(false);
    expect(result.queryCoverage.reasons).toContain("candidate_entry_budget");
  });
});
