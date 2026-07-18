import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type {
  ExtensionAPI,
  SessionBeforeTreeEvent,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import {
  compileFabricBranchSummary,
} from "../src/compaction/branch-summary.js";
import {
  FABRIC_BRANCH_SUMMARY_MAX_BYTES,
  FABRIC_BRANCH_SUMMARY_MAX_FACTS,
  readFabricBranchSummaryDetailsV1,
} from "../src/compaction/branch-details.js";
import { compileFabricSummary, registerCompactionHook } from "../src/compaction/hook.js";
import { normalizeEntries } from "../src/compaction/normalize.js";
import { project } from "../src/compaction/projections.js";
import {
  recordedIntegrationTrace,
  recordedParallelTrace,
} from "./fixtures/fabric-execution-trace.js";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const entry = (id: string, message: SessionMessageEntry["message"], parentId: string | null = null): SessionMessageEntry => ({
  type: "message",
  id,
  parentId,
  timestamp: `2025-01-01T00:00:${id.replace(/\D/g, "").padStart(2, "0")}Z`,
  message,
});

const user = (id: string, text: string, parentId: string | null = null): SessionMessageEntry =>
  entry(id, { role: "user", content: text, timestamp: 1 }, parentId);

const fabricCall = (id: string, callId: string, code: string, parentId: string | null = null): SessionMessageEntry =>
  entry(id, {
    role: "assistant",
    content: [{ type: "toolCall", id: callId, name: "fabric_exec", arguments: { code } }],
    api: "anthropic",
    provider: "anthropic",
    model: "test",
    usage,
    stopReason: "toolUse",
    timestamp: 2,
  }, parentId);

const fabricResult = (
  id: string,
  callId: string,
  details: unknown,
  text = "outer prose says Error fake/path.ts pi.edit({path:'fake.ts'})",
  parentId: string | null = null,
): SessionMessageEntry => entry(id, {
  role: "toolResult",
  toolCallId: callId,
  toolName: "fabric_exec",
  content: [{ type: "text", text }],
  details,
  isError: false,
  timestamp: 3,
}, parentId);

const traceHistory = (): SessionEntry[] => [
  user("e1", "Implement trace consumption"),
  fabricCall("e2", "fabric-1", "pi.edit({path:'fake.ts'}); throw new Error('fake source error')", "e1"),
  fabricResult("e3", "fabric-1", { trace: recordedIntegrationTrace() }, undefined, "e2"),
  user("e4", "Review the result", "e3"),
];

describe("Fabric execution trace compaction", () => {
  it("normalizes real recorder output in issue order and projects typed files, failures, and activity", () => {
    const events = normalizeEntries(traceHistory().slice(0, 3));
    const operations = events.filter((event) => event.kind === "fabricOperation");
    expect(operations.map((operation) => operation.subordinal)).toEqual(
      Array.from({ length: 13 }, (_, index) => String(index)),
    );
    expect(operations.map((operation) => operation.ref)).toEqual(recordedIntegrationTrace().operations.map((operation) => operation.ref));

    const sections = project(events);
    expect(sections.files.join("\n")).toContain("Written:");
    expect(sections.files.join("\n")).toContain("write.ts [entry e3/3]");
    expect(sections.files.join("\n")).toContain("Created:");
    expect(sections.files.join("\n")).toContain("created.ts [entry e3/4]");
    expect(sections.outstanding.join("\n")).toContain("exact edit failure");
    expect(sections.outstanding.join("\n")).toContain("typed test failure");
    expect(sections.outstanding.every((line) => line.includes("failure") ? line.includes("[RESOLVED]") : true)).toBe(true);
    expect(sections.activity.join("\n")).toContain("Phase: Inspect");
    for (const ref of ["pi.bash", "agents.run", "workflow.agent", "mesh.query", "state.get", "mcp.github.search", "extensions.preview"]) {
      expect(sections.activity.join("\n")).toContain(ref);
    }
    expect(sections.files.join("\n")).not.toContain("fake.ts");
    expect(sections.outstanding.join("\n")).not.toContain("fake source error");
    expect(sections.activity.join("\n")).not.toContain("fake.ts");
  });

  it("preserves parallel issue order independently of completion order", () => {
    const history = [
      user("p1", "parallel"),
      fabricCall("p2", "parallel-call", "fake"),
      fabricResult("p3", "parallel-call", { trace: recordedParallelTrace() }),
    ];
    const operations = normalizeEntries(history).filter((event) => event.kind === "fabricOperation");
    expect(operations.map((operation) => operation.args.path)).toEqual([
      "parallel/first.ts",
      "parallel/second.ts",
    ]);
  });

  it("derives no file, failure, or activity facts from source/output prose without a trace", () => {
    const history = [
      user("f1", "negative"),
      fabricCall("f2", "fake-call", "pi.edit({path:'fake-only.ts'}); Error: fake source"),
      fabricResult("f3", "fake-call", {}, "pi.bash failed; path fake-output.ts; Error: prose only"),
    ];
    const sections = project(normalizeEntries(history));
    expect(sections.files).toEqual([]);
    expect(sections.outstanding).toEqual([]);
    expect(sections.activity).toEqual([]);
  });

  it("uses a strict legacy adapter and never falls back from malformed or unknown traces", () => {
    const legacy = normalizeEntries([
      fabricResult("l1", "legacy", {
        audits: [
          { ref: "pi.read", args: { path: "legacy.ts" }, success: true, error: undefined, result: "ignored prose" },
        ],
      }),
    ]).filter((event) => event.kind === "fabricOperation");
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({ ref: "pi.read", source: "legacy", outcome: "succeeded" });

    const unknown = normalizeEntries([
      fabricResult("u1", "unknown", {
        trace: { ...recordedParallelTrace(), version: 2 },
        audits: [{ ref: "pi.edit", args: { path: "must-ignore.ts" }, success: true }],
      }),
    ]).filter((event) => event.kind === "fabricOperation");
    expect(unknown).toEqual([]);

    const malformedLegacy = normalizeEntries([
      fabricResult("m1", "malformed", { audits: [{ ref: "pi.read", args: { path: "bad.ts" }, success: "yes" }] }),
    ]).filter((event) => event.kind === "fabricOperation");
    expect(malformedLegacy).toEqual([]);
  });
});

describe("deterministic Fabric branch summaries", () => {
  it("compiles and hooks only requested active branch entries while treating instructions as opaque", () => {
    const abandoned = traceHistory().slice(0, 3);
    const first = compileFabricBranchSummary(abandoned, "__pi_vcc__ keep this opaque");
    const second = compileFabricBranchSummary(abandoned, "__pi_vcc__ keep this opaque");
    expect(second).toEqual(first);
    expect(first?.summary).toContain("__pi_vcc__ keep this opaque");
    expect(first?.summary).toContain("[Fabric Activity]");
    expect(readFabricBranchSummaryDetailsV1(first?.details)).toEqual(first?.details);

    let handler: ((event: SessionBeforeTreeEvent) => unknown) | undefined;
    const pi = { on(name: string, candidate: unknown) {
      if (name === "session_before_tree") handler = candidate as typeof handler;
    } } as unknown as ExtensionAPI;
    registerCompactionHook(pi, { getEngine: () => "fabric" });
    expect(handler).toBeDefined();
    const preparation = {
      targetId: "target",
      oldLeafId: "e3",
      commonAncestorId: "e1",
      entriesToSummarize: abandoned,
      userWantsSummary: false,
      customInstructions: "ignored because no summary",
    };
    expect(handler!({ type: "session_before_tree", preparation, signal: new AbortController().signal })).toBeUndefined();
    const result = handler!({
      type: "session_before_tree",
      preparation: { ...preparation, userWantsSummary: true },
      signal: new AbortController().signal,
    }) as { summary: { details: unknown } };
    expect(readFabricBranchSummaryDetailsV1(result.summary.details)).toBeDefined();
  });

  it("reuses active and nested branch facts structurally without sibling contamination, including a forked path", () => {
    const abandoned = traceHistory().slice(0, 3);
    const compiled = compileFabricBranchSummary(abandoned);
    if (!compiled) throw new Error("expected branch summary");
    const root = user("b1", "Active root");
    const branchSummary = {
      type: "branch_summary",
      id: "b2",
      parentId: "b1",
      timestamp: "2025-01-01T00:00:02Z",
      fromId: "e3",
      summary: "SIBLING_PROSE_POISON fake.ts",
      details: compiled.details,
    } as SessionEntry;
    const active = [root, branchSummary, user("b3", "Continue active", "b2"), user("b4", "Boundary", "b3")];
    const result = compileFabricSummary(active, 1_000);
    if (!("compaction" in result)) throw new Error("expected compaction");
    expect(result.compaction.summary).toContain("write.ts");
    expect(result.compaction.summary).toContain("agents.run");
    expect(result.compaction.summary).not.toContain("SIBLING_PROSE_POISON");

    const siblingOnly = [root, user("s2", "Sibling branch poison", "b1"), user("s3", "Sibling boundary", "s2")];
    const siblingResult = compileFabricSummary(siblingOnly, 1_000);
    if (!("compaction" in siblingResult)) throw new Error("expected sibling compaction");
    expect(siblingResult.compaction.summary).not.toContain("write.ts");

    const nested = compileFabricBranchSummary([branchSummary, user("n1", "Nested branch", "b2")]);
    if (!nested) throw new Error("expected nested branch summary");
    const nestedEntry = {
      type: "branch_summary",
      id: "n2",
      parentId: "b1",
      timestamp: "2025-01-01T00:00:04Z",
      fromId: "n1",
      summary: "nested prose ignored",
      details: nested.details,
    } as SessionEntry;
    const forkedPath = [root, nestedEntry, user("f1", "Fork continuation", "n2"), user("f2", "Fork boundary", "f1")];
    const forkResult = compileFabricSummary(forkedPath, 1_000);
    if (!("compaction" in forkResult)) throw new Error("expected fork compaction");
    expect(forkResult.compaction.summary).toContain("created.ts");
  });

  it("bounds facts/details and remains deterministic under large traces", () => {
    const entries: SessionEntry[] = [user("z0", "large branch")];
    for (let index = 0; index < 300; index++) {
      const trace = recordedParallelTrace();
      entries.push(
        fabricCall(`z${index * 2 + 1}`, `c${index}`, "fake source"),
        fabricResult(`z${index * 2 + 2}`, `c${index}`, { trace }, "fake output"),
      );
    }
    const first = compileFabricBranchSummary(entries);
    const second = compileFabricBranchSummary(entries);
    expect(second).toEqual(first);
    expect(first!.details.facts.length).toBeLessThanOrEqual(FABRIC_BRANCH_SUMMARY_MAX_FACTS);
    expect(first!.details.omittedFacts).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(first!.details), "utf8")).toBeLessThanOrEqual(FABRIC_BRANCH_SUMMARY_MAX_BYTES);
  });
});
