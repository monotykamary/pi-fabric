import { performance } from "node:perf_hooks";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { normalizeFabricConfig, DEFAULT_FABRIC_CONFIG } from "../src/config.js";
import {
  computeCut,
  compileFabricSummary,
  type FabricCompactionBudgetDetails,
  fabricCompactionVersion,
  registerCompactionHook,
} from "../src/compaction/hook.js";
import {
  decodeCompactionInstructions,
  encodeCompactionRequest,
  FABRIC_COMPACTION_REQUEST_PREFIX,
  MAX_PRESERVE_ITEM_CHARS,
  MAX_PRESERVE_ITEMS,
  MAX_TYPED_COMPACTION_SOURCE_BYTES,
} from "../src/compaction/instructions.js";
import { normalizeEntries } from "../src/compaction/normalize.js";
import { project, projectOutstanding } from "../src/compaction/projections.js";
import {
  buildSessionContext,
  estimateTokens,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type {
  CompactionEntry,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

// Fixture builders. Ids are deterministic so the golden-determinism test can
// build a fixture once and recompile it for byte-identical comparison.
let idCounter = 0;
const resetIds = (): void => {
  idCounter = 0;
};
const nextId = (): string => `e${++idCounter}`;
const iso = (n: number): string => `2024-01-0${1 + Math.floor(n / 86400)}T00:00:${String(n % 60).padStart(2, "0")}Z`;
let clock = 0;
const resetClock = (): void => {
  clock = 0;
};
const tick = (): number => ++clock;

const user = (text: string): SessionMessageEntry => ({
  type: "message",
  id: nextId(),
  parentId: null,
  timestamp: iso(clock),
  message: { role: "user", content: text, timestamp: tick() },
});

const textPart = (text: string): { type: "text"; text: string } => ({ type: "text", text });
const toolCallPart = (id: string, name: string, args: Record<string, unknown>): {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
} => ({ type: "toolCall", id, name, arguments: args });

const assistant = (...parts: ({ type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> })[]): SessionMessageEntry => ({
  type: "message",
  id: nextId(),
  parentId: null,
  timestamp: iso(clock),
  message: {
    role: "assistant",
    content: parts,
    api: "anthropic",
    provider: "anthropic",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: tick(),
  },
});

const toolResult = (toolCallId: string, toolName: string, text: string, isError = false): SessionMessageEntry => ({
  type: "message",
  id: nextId(),
  parentId: null,
  timestamp: iso(clock),
  message: {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [textPart(text)],
    isError,
    timestamp: tick(),
  },
});

const customMessage = (
  customType: string,
  content: string | Array<{ type: "text"; text: string }>,
  display: boolean,
  details?: unknown,
): SessionEntry => ({
  type: "custom_message",
  id: nextId(),
  parentId: null,
  timestamp: iso(clock),
  customType,
  content,
  display,
  ...(details === undefined ? {} : { details }),
}) as SessionEntry;

const plainCustom = (customType: string, data: unknown): SessionEntry => ({
  type: "custom",
  id: nextId(),
  parentId: null,
  timestamp: iso(clock),
  customType,
  data,
}) as SessionEntry;

const bashExec = (command: string, exitCode: number | undefined, output: string): SessionMessageEntry => ({
  type: "message",
  id: nextId(),
  parentId: null,
  timestamp: iso(clock),
  message: {
    role: "bashExecution",
    command,
    output,
    exitCode,
    cancelled: false,
    truncated: false,
    timestamp: tick(),
  } as SessionMessageEntry["message"],
});

const compactionEntry = (
  firstKeptEntryId: string,
  summary = "(prior)",
  details?: unknown,
): CompactionEntry => ({
  type: "compaction",
  id: nextId(),
  parentId: null,
  timestamp: iso(clock),
  summary,
  firstKeptEntryId,
  tokensBefore: 1000,
  ...(details === undefined ? {} : { details }),
} as CompactionEntry);

const appendLinked = (branch: SessionEntry[], ...entries: SessionEntry[]): void => {
  for (const entry of entries) {
    branch.push({ ...entry, parentId: branch.at(-1)?.id ?? null } as SessionEntry);
  }
};

const callId = (n: number): string => `call_${n}`;
let callCounter = 0;
const resetCallIds = (): void => {
  callCounter = 0;
};
const nextCallId = (): string => callId(++callCounter);

const buildSession = (...entries: SessionEntry[]): SessionEntry[] => entries;

describe("compaction config", () => {
  it("defaults to the fabric engine and a 65% post-compaction target", () => {
    expect(DEFAULT_FABRIC_CONFIG.compaction.engine).toBe("fabric");
    expect(DEFAULT_FABRIC_CONFIG.compaction.targetContextRatio).toBe(0.65);
  });

  it("normalizes the engine escape hatch and bounded occupancy target", () => {
    const configured = normalizeFabricConfig({
      compaction: { engine: "pi", targetContextRatio: 0.7 },
    }).compaction;
    expect(configured).toEqual({ engine: "pi", targetContextRatio: 0.7 });
    expect(normalizeFabricConfig({ compaction: { engine: "bogus", targetContextRatio: 2 } }).compaction)
      .toEqual({ engine: "fabric", targetContextRatio: 0.85 });
    expect(normalizeFabricConfig({ compaction: { targetContextRatio: 0.1 } }).compaction.targetContextRatio)
      .toBe(0.25);
    expect(normalizeFabricConfig({ compaction: { targetContextRatio: "large" } }).compaction.targetContextRatio)
      .toBe(0.65);
  });
});

type InteropCompactionEvent = SessionBeforeCompactEvent & {
  _fabricCompaction?: boolean;
  _piVccOverriding?: boolean;
};

const compactionHandler = (
  engine: "pi" | "fabric",
): ((event: SessionBeforeCompactEvent) => unknown) => {
  let handler: ((event: SessionBeforeCompactEvent) => unknown) | undefined;
  const pi = {
    on(name: string, candidate: unknown) {
      if (name === "session_before_compact") {
        handler = candidate as (event: SessionBeforeCompactEvent) => unknown;
      }
    },
  } as unknown as ExtensionAPI;
  registerCompactionHook(pi, { getEngine: () => engine });
  if (!handler) throw new Error("compaction hook was not registered");
  return handler;
};

const compactionEvent = (
  branchEntries: SessionEntry[],
  customInstructions?: string,
): InteropCompactionEvent => ({
  preparation: { tokensBefore: 1000 },
  branchEntries,
  ...(customInstructions === undefined ? {} : { customInstructions }),
}) as unknown as InteropCompactionEvent;

describe("compaction pi-vcc interop", () => {
  it("defers to an explicit /pi-vcc sentinel", () => {
    resetIds();
    resetClock();
    const event = compactionEvent(
      buildSession(user("compact this"), assistant(textPart("done"))),
      "__pi_vcc__",
    );

    expect(compactionHandler("fabric")(event)).toBeUndefined();
    expect(event._fabricCompaction).toBeUndefined();
  });

  it("marks the mutable event when fabric claims compaction", () => {
    resetIds();
    resetClock();
    const event = compactionEvent(
      buildSession(user("compact this"), assistant(textPart("done"))),
    );

    expect(compactionHandler("fabric")(event)).toHaveProperty("compaction");
    expect(event._fabricCompaction).toBe(true);
  });

  it("does not cancel a pi-vcc summary when there is nothing to compact", () => {
    const event = compactionEvent([]);
    event._piVccOverriding = true;

    expect(compactionHandler("fabric")(event)).toBeUndefined();
    expect(event._fabricCompaction).toBeUndefined();
  });

  it("cancels empty compaction when pi-vcc has not produced a summary", () => {
    const event = compactionEvent([]);

    expect(compactionHandler("fabric")(event)).toEqual({ cancel: true });
    expect(event._fabricCompaction).toBeUndefined();
  });

  it("allows an unrelated later Pi before hook to replace Fabric's result", () => {
    resetIds();
    resetClock();
    const handlers: Array<(event: SessionBeforeCompactEvent) => unknown> = [];
    const pi = {
      on(name: string, handler: unknown) {
        if (name === "session_before_compact") handlers.push(handler as (event: SessionBeforeCompactEvent) => unknown);
      },
    } as unknown as ExtensionAPI;
    registerCompactionHook(pi, { getEngine: () => "fabric" });
    handlers.push(() => ({ compaction: { summary: "later extension", firstKeptEntryId: "", tokensBefore: 1 } }));
    const event = compactionEvent(buildSession(user("source"), assistant(textPart("done"))));
    let result: unknown;
    for (const handler of handlers) result = handler(event) ?? result;
    expect(result).toMatchObject({ compaction: { summary: "later extension" } });
    expect(event._fabricCompaction).toBe(true);
  });

  it("leaves the pi engine passthrough unchanged", () => {
    resetIds();
    resetClock();
    const event = compactionEvent(
      buildSession(user("use pi core"), assistant(textPart("done"))),
    );

    expect(compactionHandler("pi")(event)).toBeUndefined();
    expect(event._fabricCompaction).toBeUndefined();
  });
});

describe("compaction instruction parity", () => {
  const summaryFor = (instructions: string): { summary: string; details: { instructionPolicy: { mode: string; truncated: boolean } } } => {
    resetIds();
    resetClock();
    const result = compileFabricSummary(
      buildSession(user("Keep the original goal"), assistant(textPart("done"))),
      1000,
      [],
      instructions,
    );
    if (!("compaction" in result)) throw new Error("expected compaction");
    return result.compaction as unknown as ReturnType<typeof summaryFor>;
  };

  it("preserves canonicalized manual free text without semantic parsing", () => {
    const result = summaryFor("  Keep   EXACT_fact\n and scope  ");
    expect(result.summary).toContain("[Compaction Request]");
    expect(result.summary).toContain("Keep EXACT_fact and scope");
    expect(result.details.instructionPolicy.mode).toBe("plain");
  });

  it("decodes typed compact.request instructions and preserve items", () => {
    const encoded = encodeCompactionRequest({
      instructions: "Keep the plan",
      preserve: ["rare pinned fact", "src/critical.ts"],
    });
    const result = summaryFor(encoded);
    expect(result.summary).toContain("Keep the plan");
    expect(result.summary).toContain("rare pinned fact");
    expect(result.summary).toContain("src/critical.ts");
    expect(result.details.instructionPolicy.mode).toBe("typed-v1");
  });

  it("bounds long instructions and records truncation", () => {
    const result = summaryFor(`keep ${"x".repeat(50_000)}`);
    expect(Buffer.byteLength(result.summary, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(result.details.instructionPolicy.truncated).toBe(true);
  });

  it.each([
    ["malformed-json", `${FABRIC_COMPACTION_REQUEST_PREFIX}{not-json}`],
    ["unsupported-version", `${FABRIC_COMPACTION_REQUEST_PREFIX}${JSON.stringify({ version: 2, instructions: "fake goal" })}`],
    ["unknown-field", `${FABRIC_COMPACTION_REQUEST_PREFIX}${JSON.stringify({ version: 1, goal: "fake goal" })}`],
    ["invalid-type", `${FABRIC_COMPACTION_REQUEST_PREFIX}${JSON.stringify({ version: 1, preserve: ["ok", 7] })}`],
  ])("fails closed for %s typed requests", (code, source) => {
    const decoded = decodeCompactionInstructions(source);
    expect(decoded).toMatchObject({ ok: false, error: { code } });
    const result = compileFabricSummary(
      buildSession(user("real goal"), assistant(textPart("done"))),
      1000,
      [],
      source,
    );
    expect(result).toMatchObject({ cancel: true, instructionError: { code } });
    expect("compaction" in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain("fake goal");
  });

  it.each([
    ["duplicate version", '{"version":1,"version":1}', "duplicate-field"],
    ["escaped duplicate preserve", '{"version":1,"preser\\u0076e":[],"preserve":[]}', "duplicate-field"],
    ["duplicate instructions", '{"version":1,"instructions":"a","instructions":"b"}', "duplicate-field"],
    ["non-finite number", '{"version":1,"instructions":1e400}', "malformed-json"],
    ["leading-zero number", '{"version":01}', "malformed-json"],
    ["unpaired escaped high surrogate", '{"version":1,"instructions":"\\ud800"}', "invalid-unicode"],
    ["unpaired escaped low surrogate", '{"version":1,"preserve":["\\udc00"]}', "invalid-unicode"],
  ])("strictly rejects %s", (_name, json, code) => {
    expect(decodeCompactionInstructions(`${FABRIC_COMPACTION_REQUEST_PREFIX}${json}`)).toMatchObject({
      ok: false,
      error: { code },
    });
  });

  it("accepts paired supplementary characters and rejects raw unpaired values before canonicalization", () => {
    const paired = `${FABRIC_COMPACTION_REQUEST_PREFIX}{"version":1,"instructions":"\\ud83d\\ude80"}`;
    expect(decodeCompactionInstructions(paired)).toMatchObject({ ok: true });
    const rawUnpaired = `${FABRIC_COMPACTION_REQUEST_PREFIX}{"version":1,"instructions":"${String.fromCharCode(0xd800)}"}`;
    expect(decodeCompactionInstructions(rawUnpaired)).toMatchObject({
      ok: false,
      error: { code: "invalid-unicode" },
    });
    expect(() => encodeCompactionRequest({ preserve: [String.fromCharCode(0xdfff)] })).toThrow(/unpaired UTF-16 surrogate/);
  });

  it("rejects typed source bytes before JSON parsing", () => {
    const source = `${FABRIC_COMPACTION_REQUEST_PREFIX}${" ".repeat(MAX_TYPED_COMPACTION_SOURCE_BYTES)}`;
    expect(decodeCompactionInstructions(source)).toMatchObject({
      ok: false,
      error: { code: "encoded-source-too-large" },
    });
  });

  it("rejects instruction bytes plus preserve count and item bounds before canonicalization", () => {
    const multibyteInstructions = `${FABRIC_COMPACTION_REQUEST_PREFIX}${JSON.stringify({
      version: 1,
      instructions: "界".repeat(3000),
    })}`;
    const tooMany = `${FABRIC_COMPACTION_REQUEST_PREFIX}${JSON.stringify({
      version: 1,
      preserve: Array.from({ length: MAX_PRESERVE_ITEMS + 1 }, () => "x"),
    })}`;
    const hugeItem = `${FABRIC_COMPACTION_REQUEST_PREFIX}${JSON.stringify({
      version: 1,
      preserve: ["x".repeat(MAX_PRESERVE_ITEM_CHARS + 1)],
    })}`;
    expect(decodeCompactionInstructions(multibyteInstructions)).toMatchObject({
      ok: false,
      error: { code: "instructions-too-large" },
    });
    expect(decodeCompactionInstructions(tooMany)).toMatchObject({
      ok: false,
      error: { code: "preserve-too-many" },
    });
    expect(decodeCompactionInstructions(hugeItem)).toMatchObject({
      ok: false,
      error: { code: "preserve-item-too-large" },
    });
  });

  it("rejects aggregate encoded payloads and never renders embedded fake facts", () => {
    const source = `${FABRIC_COMPACTION_REQUEST_PREFIX}${JSON.stringify({
      version: 1,
      instructions: "fake goal",
      preserve: Array.from({ length: MAX_PRESERVE_ITEMS }, (_, index) =>
        `fake/path-${index}.ts ${"x".repeat(1100)}`),
    })}`;
    const decoded = decodeCompactionInstructions(source);
    expect(decoded).toMatchObject({ ok: false, error: { code: "encoded-source-too-large" } });
    expect(decoded.requestLines).toEqual([]);
  });

  it("cancels and emits a bounded notification for a reserved typed decoding error", () => {
    let handler: ((event: SessionBeforeCompactEvent, context: unknown) => unknown) | undefined;
    const notifications: string[] = [];
    const pi = { on(name: string, candidate: unknown) {
      if (name === "session_before_compact") handler = candidate as typeof handler;
    } } as unknown as ExtensionAPI;
    registerCompactionHook(pi, { getEngine: () => "fabric" });
    const event = compactionEvent(
      buildSession(user("real goal"), assistant(textPart("done"))),
      `${FABRIC_COMPACTION_REQUEST_PREFIX}{\"version\":1,\"goal\":\"fake/path.ts\"}`,
    );
    event._piVccOverriding = true;
    const result = handler!(event, {
      hasUI: true,
      ui: { notify: (message: string) => notifications.push(message) },
    });
    expect(result).toEqual({ cancel: true });
    expect(notifications).toHaveLength(1);
    expect(Buffer.byteLength(notifications[0]!, "utf8")).toBeLessThanOrEqual(512);
    expect(notifications[0]).not.toContain("fake/path.ts");
  });

  it("retains exact pi-vcc sentinel precedence", () => {
    resetIds();
    resetClock();
    const event = compactionEvent(
      buildSession(user("compact this"), assistant(textPart("done"))),
      "__pi_vcc__",
    );
    expect(compactionHandler("fabric")(event)).toBeUndefined();
    expect(event._fabricCompaction).toBeUndefined();
  });
});

describe("Pi custom_message compaction", () => {
  it("normalizes hidden and visible context structurally while excluding plain custom entries", () => {
    resetIds();
    resetClock();
    const visible = customMessage(
      "pi-fabric-actor",
      [{ type: "text", text: "actor completed <typed>" }],
      true,
      { message: { status: "completed", sequence: 7 }, actor: { id: "actor-1" } },
    );
    const hidden = customMessage(
      "before-agent-start",
      "hidden injected context",
      false,
      { source: "hook", priority: 2 },
    );
    const events = normalizeEntries([
      visible,
      plainCustom("extension-state", { poison: "PLAIN_CUSTOM_POISON" }),
      hidden,
    ]);
    expect(events.map((event) => event.kind)).toEqual(["customMessage", "customMessage"]);
    expect(events).toMatchObject([
      { customType: "pi-fabric-actor", text: "actor completed <typed>", display: true },
      { customType: "before-agent-start", text: "hidden injected context", display: false },
    ]);
    expect(JSON.stringify(events)).not.toContain("PLAIN_CUSTOM_POISON");
  });

  it("includes actor and subagent completions in cumulative summaries deterministically", () => {
    resetIds();
    resetClock();
    const session = buildSession(
      user("Original task"),
      customMessage("pi-fabric-actor", "Actor says: keep ACTOR_FACT_17", true, {
        actor: { id: "actor-17" },
        message: { status: "completed" },
      }),
      assistant(textPart("actor received")),
      customMessage("pi-fabric-subagent-complete", "Fabric agent abc completed: SUBAGENT_FACT_23", false, {
        id: "subagent-23",
        status: "completed",
      }),
      assistant(textPart("completion received")),
      user("Continue after completions"),
    );
    const first = compileFabricSummary(session, 1_000);
    const second = compileFabricSummary(session, 1_000);
    if (!("compaction" in first) || !("compaction" in second)) throw new Error("expected compaction");
    expect(second.compaction.summary).toBe(first.compaction.summary);
    expect(first.compaction.summary).toContain('custom "pi-fabric-actor" (visible)');
    expect(first.compaction.summary).toContain("ACTOR_FACT_17");
    expect(first.compaction.summary).toContain('custom "pi-fabric-subagent-complete" (hidden)');
    expect(first.compaction.summary).toContain("SUBAGENT_FACT_23");
    expect(first.compaction.details?.counts.cumulativeSourceEntries).toBe(5);
  });

  it("keeps a custom-message turn boundary and the crossing tool pair together", () => {
    resetIds();
    resetClock();
    const session = buildSession(
      user("start"),
      assistant(toolCallPart("cross-custom", "read", { path: "a.ts" })),
      customMessage("before-agent-start", "new context while call is open", false),
      toolResult("cross-custom", "read", "done"),
    );
    const cut = computeCut(session);
    expect(cut).toMatchObject({ ok: true, firstKeptEntryId: "" });
    if (cut.ok) expect(cut.summarized.map((entry) => entry.id)).toEqual(session.map((entry) => entry.id));
  });

  it("omits malformed custom details without dropping valid content and ignores malformed entries", () => {
    resetIds();
    resetClock();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const validContent = customMessage("safe-custom", "SAFE_CUSTOM_CONTENT", true, cyclic);
    const malformed = {
      type: "custom_message",
      id: nextId(),
      parentId: null,
      timestamp: iso(clock),
      customType: 7,
      content: { text: "MALFORMED_CUSTOM_POISON" },
      display: "yes",
    } as unknown as SessionEntry;
    const events = normalizeEntries([validContent, malformed]);
    expect(events).toMatchObject([{ kind: "customMessage", text: "SAFE_CUSTOM_CONTENT" }]);
    expect(events[0]).not.toHaveProperty("details");
    expect(JSON.stringify(events)).not.toContain("MALFORMED_CUSTOM_POISON");
  });
});

describe("compaction golden determinism", () => {
  it("produces byte-identical output across repeated compiles of the same fixture", () => {
    resetIds();
    resetCallIds();
    resetClock();
    const c1 = nextCallId();
    const c2 = nextCallId();
    const c3 = nextCallId();
    const session = buildSession(
      user("Build the deterministic compaction engine.\nKeep it minimal.\nNo regex."),
      assistant(toolCallPart(c1, "read", { path: "src/a.ts" })),
      toolResult(c1, "read", "contents of a"),
      assistant(textPart("I will edit b and create c"), toolCallPart(c2, "edit", { path: "src/b.ts" })),
      toolResult(c2, "edit", "edited b.ts"),
      assistant(toolCallPart(c3, "write", { path: "src/c.ts" })),
      toolResult(c3, "write", "wrote c.ts"),
      user("now add tests"),
    );
    const first = compileFabricSummary(session, 1000) as { compaction: { summary: string } };
    const second = compileFabricSummary(session, 1000) as { compaction: { summary: string } };
    expect(second.compaction.summary).toBe(first.compaction.summary);
    expect(first.compaction.summary).toContain("[Session Goal]");
    expect(first.compaction.summary).toContain("[Files And Changes]");
    expect(first.compaction.summary).toContain("(under src/)");
    expect(first.compaction.summary).toContain("Written:");
    expect(first.compaction.summary).toContain("Modified:");
    // No dynamic "now" timestamp: the footer marker is the last entry's timestamp.
    expect(first.compaction.summary).toContain("[compacted 2024-01-0");
    expect(first.compaction.summary).toContain("memory.recall / vcc_recall-style");
  });

  it("emits only non-empty sections in fixed order", () => {
    resetIds();
    resetCallIds();
    resetClock();
    const session = buildSession(user("single turn, no tools"), assistant(textPart("acknowledged")));
    // Only one user turn → cut falls back to compact-all; summary has goal +
    // status + transcript but no files/commits/outstanding/earlier-turns.
    const { compaction } = compileFabricSummary(session, 1000) as { compaction: { summary: string } };
    expect(compaction.summary).not.toContain("[Files And Changes]");
    expect(compaction.summary).not.toContain("[Commits]");
    expect(compaction.summary).not.toContain("[Outstanding Context]");
    expect(compaction.summary).not.toContain("[Earlier Turns]");
    const goalIdx = compaction.summary.indexOf("[Session Goal]");
    const statusIdx = compaction.summary.indexOf("[Current Status]");
    const transIdx = compaction.summary.indexOf("---");
    expect(goalIdx).toBeLessThan(statusIdx);
    expect(statusIdx).toBeLessThan(transIdx);
  });
});

describe("compaction cumulative stability", () => {
  it("recomputes cumulative truth from raw branch entries while advancing the live cut", () => {
    resetIds();
    resetCallIds();
    resetClock();
    const c1 = nextCallId();
    const session1 = buildSession(
      user("First goal: scaffold the module"),
      assistant(textPart("scaffolding"), toolCallPart(c1, "read", { path: "src/a.ts" })),
      toolResult(c1, "read", "a contents"),
      user("Second goal: wire it up"),
    );
    const first = compileFabricSummary(session1, 1000) as {
      compaction: { firstKeptEntryId: string; summary: string };
    };
    expect(first.compaction.firstKeptEntryId).not.toBe("");
    const keptId = first.compaction.firstKeptEntryId;

    // Simulate the post-compaction branch: prior entries + compaction marker +
    // a fresh batch of work that should drive the next summary.
    const c2 = nextCallId();
    const session2: SessionEntry[] = [
      ...session1,
      compactionEntry(keptId),
      assistant(textPart("wiring"), toolCallPart(c2, "write", { path: "src/b.ts" })),
      toolResult(c2, "write", "wrote b.ts"),
      user("Third goal: ship it"),
      assistant(textPart("done")),
      user("Fourth goal: review"),
    ];
    const second = compileFabricSummary(session2, 2000) as {
      compaction: { summary: string; firstKeptEntryId: string };
    };

    // The live cut advances, while the summary source remains every raw,
    // content-bearing entry before the new boundary.
    expect(second.compaction.summary).toContain("First goal");
    expect(second.compaction.summary).toContain("Second goal");
    expect(second.compaction.summary).toContain("Third goal");
    expect(second.compaction.summary).not.toContain("Fourth goal");
    // Successful file addresses are cumulative raw truth.
    expect(second.compaction.summary).toContain("b.ts");
    expect(second.compaction.summary).toContain("a.ts");
    expect(second.compaction.firstKeptEntryId).not.toBe(keptId);
  });
});

describe("compaction cumulative endurance", () => {
  it("retains raw cumulative truth through 100 parent-linked compaction cycles", () => {
    resetIds();
    resetCallIds();
    resetClock();
    const branch: SessionEntry[] = [];
    const initialRead = nextCallId();
    const initialError = nextCallId();
    appendLinked(
      branch,
      user("Original First goal: preserve PINNED_RARE_FACT_7 and finish the module."),
      customMessage("pi-fabric-actor", "Preserve CUSTOM_CYCLE_FACT_31", false, { status: "completed" }),
      assistant(toolCallPart(initialRead, "read", { path: "src/a.ts" })),
      toolResult(initialRead, "read", "a contents"),
      assistant(toolCallPart(initialError, "read", { path: "src/never-existed.ts" })),
      toolResult(initialError, "read", "ENOENT pinned open error", true),
      user("Cycle scope 0"),
    );

    const sizes: number[] = [];
    let previousKept = "";
    for (let cycle = 0; cycle < 100; cycle++) {
      const first = compileFabricSummary(branch, 10_000);
      const second = compileFabricSummary(branch, 10_000);
      if (!("compaction" in first) || !("compaction" in second)) throw new Error("expected compaction");
      expect(second.compaction.summary).toBe(first.compaction.summary);
      expect(first.compaction.summary).toContain("Original First goal");
      expect(first.compaction.summary).toContain("PINNED_RARE_FACT_7");
      expect(first.compaction.summary).toContain("CUSTOM_CYCLE_FACT_31");
      expect(first.compaction.summary).toContain("a.ts");
      expect(first.compaction.summary).toContain("never-existed.ts");
      expect(first.compaction.summary).toContain("ENOENT pinned open error");
      expect(first.compaction.summary).not.toContain("PRIOR_SUMMARY_POISON_991");
      expect(first.compaction.details).toMatchObject({ compactor: "fabric", version: 2 });
      expect(first.compaction.firstKeptEntryId === "" || branch.some((entry) => entry.id === first.compaction.firstKeptEntryId)).toBe(true);
      if (previousKept) expect(first.compaction.firstKeptEntryId).not.toBe(previousKept);
      previousKept = first.compaction.firstKeptEntryId;
      sizes.push(Buffer.byteLength(first.compaction.summary, "utf8"));
      expect(sizes.at(-1)).toBeLessThanOrEqual(32 * 1024);

      appendLinked(
        branch,
        compactionEntry(
          first.compaction.firstKeptEntryId,
          first.compaction.summary,
          first.compaction.details,
        ),
      );
      const writeId = nextCallId();
      appendLinked(
        branch,
        assistant(toolCallPart(writeId, "write", { path: `src/cycles/file-${cycle}.ts` })),
        toolResult(writeId, "write", `wrote cycle ${cycle}`),
        user(`Cycle scope ${cycle + 1}`),
      );
    }

    for (let index = 1; index < branch.length; index++) {
      expect(branch[index]!.parentId).toBe(branch[index - 1]!.id);
    }
    expect(branch.filter((entry) => entry.type === "compaction")).toHaveLength(100);
    const steady = sizes.slice(-20);
    expect(Math.max(...steady) - Math.min(...steady)).toBeLessThan(512);
  });
});

describe("compaction raw branch truth", () => {
  it("strictly recognizes only structurally valid Fabric v1/v2 details", () => {
    expect(fabricCompactionVersion({ compactor: "fabric", version: 1 })).toBeUndefined();
    expect(fabricCompactionVersion({ compactor: "fabric", version: 3 })).toBeUndefined();
    expect(fabricCompactionVersion({ compactor: "other", version: 2 })).toBeUndefined();
  });

  it("migrates v1 details and excludes prior rendered-summary poison", () => {
    resetIds();
    resetClock();
    const branch: SessionEntry[] = [];
    const first = user("Original v1 goal");
    const kept = user("Continue after v1");
    appendLinked(branch, first, assistant(textPart("old work")), kept);
    appendLinked(branch, compactionEntry(kept.id, "PRIOR_SUMMARY_POISON_991", {
      compactor: "fabric",
      version: 1,
      sections: ["[Session Goal]"],
      summarizedEntryRange: { first: first.id, last: first.id },
      sourceEntryCount: 1,
      firstKeptEntryId: kept.id,
      timestamp: first.timestamp,
    }));
    appendLinked(branch, assistant(textPart("new work")), user("Next boundary"));

    const result = compileFabricSummary(branch, 2000);
    if (!("compaction" in result)) throw new Error("expected compaction");
    expect(result.compaction.details?.version).toBe(2);
    expect(result.compaction.details?.counts.priorFabricV1).toBe(1);
    expect(result.compaction.summary).toContain("Original v1 goal");
    expect(result.compaction.summary).not.toContain("PRIOR_SUMMARY_POISON_991");
  });

  it("uses only the supplied active branch path", () => {
    resetIds();
    resetClock();
    const root = user("Active root goal");
    const active = [root, assistant(textPart("active work")), user("Active boundary")];
    const inactive = [
      root,
      user("INACTIVE_BRANCH_POISON"),
      assistant(textPart("inactive work")),
      user("Inactive boundary"),
    ];
    const activeResult = compileFabricSummary(active, 1000);
    const inactiveResult = compileFabricSummary(inactive, 1000);
    if (!("compaction" in activeResult) || !("compaction" in inactiveResult)) throw new Error("expected compaction");
    expect(activeResult.compaction.summary).not.toContain("INACTIVE_BRANCH_POISON");
    expect(inactiveResult.compaction.summary).toContain("INACTIVE_BRANCH_POISON");
  });
});

describe("compaction error state machine", () => {
  it("keeps a file error open when a different action later succeeds on the same path", () => {
    resetIds();
    resetCallIds();
    resetClock();
    const c1 = nextCallId();
    const c2 = nextCallId();
    const session = buildSession(
      user("fix the bug"),
      assistant(toolCallPart(c1, "read", { path: "src/x.ts" })),
      toolResult(c1, "read", "Error: file not found", true),
      assistant(textPart("retrying"), toolCallPart(c2, "edit", { path: "src/x.ts" })),
      toolResult(c2, "edit", "edited"),
      user("thanks"),
    );
    const events = normalizeEntries(session.slice(0, 5));
    const lines = projectOutstanding(events);
    expect(lines.some((l) => l.includes("read src/x.ts") && !l.includes("[RESOLVED]"))).toBe(true);
  });

  it("marks a bash error [RESOLVED] when the same command is later re-run OK", () => {
    resetIds();
    resetCallIds();
    resetClock();
    const c1 = nextCallId();
    const c2 = nextCallId();
    const session = buildSession(
      user("run the build"),
      assistant(toolCallPart(c1, "bash", { command: "make test" })),
      toolResult(c1, "bash", "make: *** failed", true),
      assistant(toolCallPart(c2, "bash", { command: "make test" })),
      toolResult(c2, "bash", "all tests passed"),
      user("done"),
    );
    const events = normalizeEntries(session.slice(0, 5));
    const lines = projectOutstanding(events);
    expect(lines.some((l) => l.includes("bash: make test") && l.includes("[RESOLVED]"))).toBe(true);
  });

  it("leaves an error open without classifying its prose when nothing resolves it", () => {
    resetIds();
    resetCallIds();
    resetClock();
    const c1 = nextCallId();
    const session = buildSession(
      user("do work"),
      assistant(toolCallPart(c1, "edit", { path: "src/y.ts" })),
      toolResult(c1, "edit", "Error: permission denied", true),
      user("next"),
    );
    const events = normalizeEntries(session.slice(0, 3));
    const lines = projectOutstanding(events);
    expect(lines.some((l) => l.includes("edit src/y.ts") && !l.includes("[RESOLVED]"))).toBe(true);
  });
});

describe("compaction cut never orphans a tool_result from its tool_call", () => {
  const assertNoOrphan = (branchEntries: SessionEntry[]): void => {
    const cut = computeCut(branchEntries);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    const boundaryIndex = cut.firstKeptEntryId
      ? branchEntries.findIndex((entry) => entry.id === cut.firstKeptEntryId)
      : branchEntries.length;
    const sides = new Map<string, { call?: "summary" | "kept"; result?: "summary" | "kept" }>();
    for (let index = 0; index < branchEntries.length; index++) {
      const entry = branchEntries[index]!;
      if (entry.type !== "message") continue;
      const side = index < boundaryIndex ? "summary" : "kept";
      const message = entry.message as { role?: string; toolCallId?: string; content?: unknown };
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (!part || typeof part !== "object" || (part as { type?: string }).type !== "toolCall") continue;
          const id = (part as { id?: string }).id;
          if (!id) continue;
          const pair = sides.get(id) ?? {};
          pair.call = side;
          sides.set(id, pair);
        }
      }
      if (message.role === "toolResult" && message.toolCallId) {
        const pair = sides.get(message.toolCallId) ?? {};
        pair.result = side;
        sides.set(message.toolCallId, pair);
      }
    }
    for (const [id, pair] of sides) {
      if (pair.call && pair.result) expect(pair.call, `closure for ${id}`).toBe(pair.result);
    }
  };

  it("normal multi-turn cut keeps complete turns together", () => {
    resetIds();
    resetCallIds();
    resetClock();
    const c1 = nextCallId();
    const c2 = nextCallId();
    assertNoOrphan(
      buildSession(
        user("turn one"),
        assistant(toolCallPart(c1, "read", { path: "a.ts" })),
        toolResult(c1, "read", "a"),
        user("turn two"),
        assistant(toolCallPart(c2, "edit", { path: "a.ts" })),
        toolResult(c2, "edit", "edited"),
        user("turn three"),
      ),
    );
  });

  it("pushes the cut back when the last turn is in flight (unmatched tool call)", () => {
    resetIds();
    resetCallIds();
    resetClock();
    const c1 = nextCallId();
    const c2 = nextCallId();
    const c3 = nextCallId();
    const session = buildSession(
      user("turn one"),
      assistant(toolCallPart(c1, "read", { path: "a.ts" })),
      toolResult(c1, "read", "a"),
      user("turn two"),
      assistant(textPart("working"), toolCallPart(c2, "edit", { path: "b.ts" })),
      toolResult(c2, "edit", "edited b"),
      user("turn three"),
      assistant(toolCallPart(c3, "bash", { command: "make" })), // no result yet — in flight
    );
    assertNoOrphan(session);
    const cut = computeCut(session);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    // The in-flight bash call (call_3) must be KEPT, not summarized.
    const summarizedHasCall3 = cut.summarized.some((e) => {
      if (e.type !== "message") return false;
      const content = (e.message as { content?: unknown }).content;
      if (!Array.isArray(content)) return false;
      return content.some((p) => p && typeof p === "object" && (p as { id?: string }).id === c3);
    });
    expect(summarizedHasCall3).toBe(false);
  });

  it("recovers a safe cut after an orphan prior kept boundary", () => {
    resetIds();
    resetClock();
    const branch = buildSession(
      user("raw goal before malformed boundary"),
      compactionEntry("missing-kept-id", "PRIOR_SUMMARY_POISON_991"),
      user("recovered turn"),
      assistant(toolCallPart("recovered-call", "read", { path: "recovered.ts" })),
      toolResult("recovered-call", "read", "ok"),
      user("recovered boundary"),
    );
    assertNoOrphan(branch);
    const result = compileFabricSummary(branch, 1000);
    if (!("compaction" in result)) throw new Error("expected compaction");
    expect(result.compaction.summary).toContain("raw goal before malformed boundary");
    expect(result.compaction.summary).not.toContain("PRIOR_SUMMARY_POISON_991");
  });

  it("closes parallel delayed pairs in both call/result directions", () => {
    resetIds();
    resetClock();
    const forward = buildSession(
      user("turn one"),
      assistant(
        toolCallPart("parallel-a", "read", { path: "a.ts" }),
        toolCallPart("parallel-b", "read", { path: "b.ts" }),
      ),
      toolResult("parallel-a", "read", "a"),
      user("turn two"),
      toolResult("parallel-b", "read", "delayed b"),
    );
    assertNoOrphan(forward);

    resetIds();
    const reverse = buildSession(
      user("malformed turn one"),
      toolResult("reverse-pair", "read", "early result"),
      user("turn two"),
      assistant(toolCallPart("reverse-pair", "read", { path: "later.ts" })),
    );
    assertNoOrphan(reverse);
    expect(computeCut(reverse)).toMatchObject({ ok: true, firstKeptEntryId: "" });
  });
});

describe("adaptive compaction budget", () => {
  const longSingleTurn = (): { entries: SessionEntry[]; tokensBefore: number } => {
    const entries: SessionEntry[] = [];
    appendLinked(entries, user("Preserve the original print calibration goal"));
    for (let index = 0; index < 36; index++) {
      const id = `adaptive-${index}`;
      appendLinked(
        entries,
        assistant(toolCallPart(id, "read", { path: `models/part-${index}.stl` })),
        toolResult(id, "read", `mesh-${index}: ${"x".repeat(12_000)}`),
        assistant(textPart(`Completed calibration stage ${index}`)),
      );
    }

    let rawTokens = 0;
    for (const entry of entries) {
      const messages = sessionEntryToContextMessages(entry);
      rawTokens += messages.reduce((total, message) => total + estimateTokens(message), 0);
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const contextTokens = Math.round(6_000 + rawTokens * 1.4);
      entry.message.usage.input = contextTokens;
      entry.message.usage.totalTokens = contextTokens;
    }
    return { entries, tokensBefore: Math.round(6_000 + rawTokens * 1.4) };
  };

  it("splits a huge current turn near the configured target without crossing tool pairs", () => {
    resetIds();
    resetClock();
    const { entries, tokensBefore } = longSingleTurn();
    const result = compileFabricSummary(
      entries,
      tokensBefore,
      [],
      undefined,
      {
        contextWindow: 100_000,
        targetContextRatio: 0.65,
        reserveTokens: 10_000,
        keepRecentTokens: 20_000,
      },
    );
    if (!("compaction" in result)) throw new Error("expected adaptive compaction");

    expect(result.compaction.firstKeptEntryId).not.toBe("");
    expect(result.compaction.firstKeptEntryId).not.toBe(entries[0]!.id);
    const projectedTokensAfter = result.compaction.details?.budget?.projectedTokensAfter;
    expect(projectedTokensAfter).toBeGreaterThan(50_000);
    expect(projectedTokensAfter).toBeLessThanOrEqual(65_000);
    expect(result.compaction.details?.budget).toMatchObject({
      strategy: "adaptive",
      contextWindow: 100_000,
      targetContextRatio: 0.65,
      targetContextTokens: 65_000,
      reserveTokens: 10_000,
      keepRecentTokens: 20_000,
    });

    const boundaryIndex = entries.findIndex(
      (entry) => entry.id === result.compaction.firstKeptEntryId,
    );
    const sides = new Map<string, Set<"summary" | "kept">>();
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      if (entry.type !== "message") continue;
      const side = index < boundaryIndex ? "summary" : "kept";
      const message = entry.message as { role?: string; toolCallId?: string; content?: unknown };
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (!part || typeof part !== "object" || (part as { type?: string }).type !== "toolCall") continue;
          const id = (part as { id?: string }).id;
          if (!id) continue;
          const found = sides.get(id) ?? new Set();
          found.add(side);
          sides.set(id, found);
        }
      }
      if (message.role === "toolResult" && message.toolCallId) {
        const found = sides.get(message.toolCallId) ?? new Set();
        found.add(side);
        sides.set(message.toolCallId, found);
      }
    }
    expect([...sides.values()].every((side) => side.size === 1)).toBe(true);
    expect(result.compaction.summary).toContain("Preserve the original print calibration goal");
  });

  it("never expands a compaction that starts below the configured window target", () => {
    resetIds();
    resetClock();
    const { entries, tokensBefore } = longSingleTurn();
    const result = compileFabricSummary(
      entries,
      tokensBefore,
      [],
      undefined,
      {
        contextWindow: 400_000,
        targetContextRatio: 0.65,
        reserveTokens: 20_000,
        keepRecentTokens: 20_000,
      },
    );
    if (!("compaction" in result)) throw new Error("expected adaptive compaction");
    const budget = result.compaction.details?.budget;
    expect(budget?.targetContextTokens).toBe(Math.floor(tokensBefore * 0.95));
    expect(budget?.projectedTokensAfter).toBeLessThanOrEqual(Math.floor(tokensBefore * 0.95));
  });

  it("cancels rather than expanding when even compact-all cannot fit the target", () => {
    resetIds();
    resetClock();
    const result = compileFabricSummary(
      [user("tiny goal"), assistant(textPart("tiny result"))],
      100,
      [],
      undefined,
      {
        contextWindow: 100_000,
        targetContextRatio: 0.65,
        reserveTokens: 10_000,
        keepRecentTokens: 20_000,
      },
    );
    expect(result).toMatchObject({
      cancel: true,
      reason: "fabric: no deterministic summary fits the adaptive context target",
    });
  });

  it("keeps observed fixed prompt overhead outside the shrinkable message budget", () => {
    resetIds();
    resetClock();
    const { entries } = longSingleTurn();
    for (const entry of entries) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      entry.message.usage.input = 0;
      entry.message.usage.totalTokens = 0;
    }
    const rawTokens = buildSessionContext(entries).messages.reduce(
      (total, message) => total + estimateTokens(message),
      0,
    );
    const result = compileFabricSummary(
      entries,
      rawTokens + 40_000,
      [],
      undefined,
      {
        contextWindow: 100_000,
        targetContextRatio: 0.65,
        reserveTokens: 10_000,
        keepRecentTokens: 20_000,
      },
    );
    if (!("compaction" in result)) throw new Error("expected adaptive compaction");
    expect(result.compaction.details?.budget?.fixedOverheadTokens).toBe(40_000);
    expect(result.compaction.details?.budget?.projectedTokensAfter).toBeLessThanOrEqual(65_000);
  });

  it("never treats a prior compaction marker as live retained context", () => {
    resetIds();
    resetClock();
    const original = user("Original cumulative goal");
    const kept = assistant(textPart("previous retained tail"));
    const previous = compactionEntry(kept.id, "old rendered summary");
    const branch: SessionEntry[] = [];
    appendLinked(
      branch,
      original,
      kept,
      previous,
      user("Continue after compaction"),
      assistant(textPart("new work ".repeat(5_000))),
      user("Latest request"),
      assistant(textPart("latest result")),
    );
    const cut = computeCut(branch, {
      tokensBefore: 20_000,
      budget: {
        contextWindow: 50_000,
        targetContextRatio: 0.65,
        reserveTokens: 5_000,
        keepRecentTokens: 2_000,
      },
    });
    if (!cut.ok) throw new Error("expected adaptive cut");
    expect(cut.summarized.some((entry) => entry.id === previous.id)).toBe(false);
    expect(cut.firstKeptEntryId).not.toBe(previous.id);
    const keptIndex = branch.findIndex((entry) => entry.id === cut.firstKeptEntryId);
    const previousIndex = branch.findIndex((entry) => entry.id === previous.id);
    expect(keptIndex).toBeGreaterThan(previousIndex);

    const next = {
      ...compactionEntry(cut.firstKeptEntryId, "new rendered summary"),
      parentId: branch.at(-1)!.id,
    } as CompactionEntry;
    const rebuilt = buildSessionContext([...branch, next]).messages;
    expect(rebuilt.filter((message) => message.role === "compactionSummary")).toHaveLength(1);
    expect(JSON.stringify(rebuilt)).toContain("new rendered summary");
    expect(JSON.stringify(rebuilt)).not.toContain("old rendered summary");
  });

  it("retains one cumulative summary and safe utilization through 20 adaptive cycles", () => {
    resetIds();
    resetClock();
    const branch: SessionEntry[] = [];
    appendLinked(branch, user("Long-running adaptive endurance goal"));

    for (let cycle = 0; cycle < 20; cycle++) {
      const previousMarkerIndex = branch.map((entry) => entry.type).lastIndexOf("compaction");
      const newStart = previousMarkerIndex + 1;
      for (let operation = 0; operation < 14; operation++) {
        const id = `endurance-${cycle}-${operation}`;
        appendLinked(
          branch,
          assistant(toolCallPart(id, "read", { path: `cycle-${cycle}/${operation}.txt` })),
          toolResult(id, "read", `cycle ${cycle} operation ${operation} ${"x".repeat(10_000)}`),
          assistant(textPart(`cycle ${cycle} operation ${operation} complete`)),
        );
      }

      let rawTokens = previousMarkerIndex >= 0
        ? buildSessionContext(branch.slice(0, previousMarkerIndex + 1)).messages.reduce(
            (total, message) => total + estimateTokens(message),
            0,
          )
        : 0;
      for (let index = newStart; index < branch.length; index++) {
        const entry = branch[index]!;
        rawTokens += sessionEntryToContextMessages(entry).reduce(
          (total, message) => total + estimateTokens(message),
          0,
        );
        if (entry.type !== "message" || entry.message.role !== "assistant") continue;
        const contextTokens = Math.round(6_000 + rawTokens * 1.4);
        entry.message.usage.input = contextTokens;
        entry.message.usage.totalTokens = contextTokens;
      }
      const tokensBefore = Math.round(6_000 + rawTokens * 1.4);
      const result = compileFabricSummary(
        branch,
        tokensBefore,
        [],
        undefined,
        {
          contextWindow: 100_000,
          targetContextRatio: 0.65,
          reserveTokens: 10_000,
          keepRecentTokens: 20_000,
        },
      );
      if (!("compaction" in result)) throw new Error(`cycle ${cycle} failed`);
      const budget = result.compaction.details?.budget;
      expect(budget?.projectedTokensAfter).toBeGreaterThan(30_000);
      expect(budget?.projectedTokensAfter).toBeLessThanOrEqual(budget!.targetContextTokens);
      if (previousMarkerIndex >= 0 && result.compaction.firstKeptEntryId) {
        const keptIndex = branch.findIndex(
          (entry) => entry.id === result.compaction.firstKeptEntryId,
        );
        expect(keptIndex).toBeGreaterThan(previousMarkerIndex);
      }

      appendLinked(branch, {
        ...compactionEntry(
          result.compaction.firstKeptEntryId,
          result.compaction.summary,
          result.compaction.details,
        ),
        tokensBefore,
      } as CompactionEntry);
      const rebuilt = buildSessionContext(branch).messages;
      expect(rebuilt.filter((message) => message.role === "compactionSummary")).toHaveLength(1);
      expect(result.compaction.summary).toContain("Long-running adaptive endurance goal");
    }
  });

  it("caps the target below the nominal window reserve even when configured higher", () => {
    resetIds();
    resetClock();
    const { entries, tokensBefore } = longSingleTurn();
    const result = compileFabricSummary(
      entries,
      tokensBefore,
      [],
      undefined,
      {
        contextWindow: 100_000,
        targetContextRatio: 0.85,
        reserveTokens: 30_000,
        keepRecentTokens: 80_000,
      },
    );
    if (!("compaction" in result)) throw new Error("expected adaptive compaction");
    expect(result.compaction.details?.budget?.targetContextTokens).toBe(63_000);
    expect(result.compaction.details?.budget?.projectedTokensAfter).toBeLessThanOrEqual(63_000);
  });

  it("uses live model metadata and Pi settings through the registered hook", () => {
    resetIds();
    resetClock();
    let handler: ((event: SessionBeforeCompactEvent, context: ExtensionContext) => unknown) | undefined;
    const pi = {
      on(name: string, candidate: unknown) {
        if (name === "session_before_compact") {
          handler = candidate as typeof handler;
        }
      },
    } as unknown as ExtensionAPI;
    registerCompactionHook(pi, {
      getEngine: () => "fabric",
      getTargetContextRatio: () => 0.65,
    });
    const { entries, tokensBefore } = longSingleTurn();
    const event = {
      type: "session_before_compact",
      branchEntries: entries,
      preparation: {
        tokensBefore,
        settings: { enabled: true, reserveTokens: 10_000, keepRecentTokens: 20_000 },
      },
    } as unknown as SessionBeforeCompactEvent;
    const context = {
      model: { contextWindow: 100_000 },
    } as unknown as ExtensionContext;
    const result = handler!(event, context) as {
      compaction: { details: { budget: FabricCompactionBudgetDetails } };
    };
    expect(result.compaction.details.budget.projectedTokensAfter).toBeLessThanOrEqual(65_000);
    expect(result.compaction.details.budget.contextWindow).toBe(100_000);
  });
});

describe("compaction empty and tiny history edge cases", () => {
  it("cancels on empty history", () => {
    resetIds();
    expect(computeCut(buildSession()).ok).toBe(false);
    const result = compileFabricSummary([], 1000);
    expect("cancel" in result).toBe(true);
  });

  it("cancels when only a compaction marker remains with no live messages", () => {
    resetIds();
    resetCallIds();
    resetClock();
    const result = computeCut(buildSession(compactionEntry("nonexistent")));
    expect(result.ok).toBe(false);
  });

  it("falls back to compact-all for a single user turn", () => {
    resetIds();
    resetClock();
    const session = buildSession(user("just one prompt"), assistant(textPart("reply")));
    const cut = computeCut(session);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(cut.firstKeptEntryId).toBe("");
    expect(cut.summarized.length).toBe(2);
  });

  it("still renders a stable summary for a tiny session", () => {
    resetIds();
    resetClock();
    const session = buildSession(user("hi"), assistant(textPart("hello")));
    const a = compileFabricSummary(session, 1000) as { compaction: { summary: string } };
    const b = compileFabricSummary(session, 1000) as { compaction: { summary: string } };
    expect(b.compaction.summary).toBe(a.compaction.summary);
    expect(a.compaction.summary).toContain("[Session Goal]");
  });
});

describe("compaction benchmark", () => {
  it("compacts a synthetic 2000-entry session in under 200ms", () => {
    resetIds();
    resetCallIds();
    resetClock();
    const entries: SessionEntry[] = [];
    entries.push(user("Initial goal: process a large codebase audit."));
    for (let i = 0; i < 450; i++) {
      const r = nextCallId();
      const e = nextCallId();
      entries.push(
        assistant(toolCallPart(r, "read", { path: `src/mod${i}/file.ts` })),
        toolResult(r, "read", `content ${i}`),
        assistant(toolCallPart(e, "edit", { path: `src/mod${i}/file.ts` })),
        toolResult(e, "edit", `edited ${i}`),
      );
    }
    // 1 + 450*4 = 1801 entries; pad to 2000 with assistant text lines.
    while (entries.length < 2000) entries.push(assistant(textPart(`progress note ${entries.length}`)));
    entries.push(user("Final review"));
    expect(entries.length).toBeGreaterThanOrEqual(2000);

    const start = performance.now();
    const result = compileFabricSummary(entries, 1000);
    const elapsed = performance.now() - start;
    expect("compaction" in result).toBe(true);
    expect(elapsed).toBeLessThan(200);
  });
});

describe("compaction section composition", () => {
  it.each([
    ["git commit -m \"ship feature\"", "[main abc1234] ship feature\n 1 file changed"],
    ["printf 'git commit -m fake'", "[main def5678] fake shell prose"],
  ])("does not extract commits from shell command/output prose", (command, output) => {
    resetIds();
    resetCallIds();
    resetClock();
    const c = nextCallId();
    const session = buildSession(
      user("run shell"),
      assistant(toolCallPart(c, "bash", { command })),
      toolResult(c, "bash", output),
      user("done"),
    );
    const sections = project(normalizeEntries(session.slice(0, 3)));
    expect(Object.keys(sections)).not.toContain("commits");
    const result = compileFabricSummary(session, 1000);
    if (!("compaction" in result)) throw new Error("expected compaction");
    expect(result.compaction.summary).not.toContain("[Commits]");
  });

  it("renders a stable, section-ordered document", () => {
    resetIds();
    resetCallIds();
    resetClock();
    const c = nextCallId();
    const session = buildSession(
      user("goal line one\ngoal line two\ngoal line three\ngoal line four"),
      assistant(toolCallPart(c, "read", { path: "src/x.ts" })),
      toolResult(c, "read", "x"),
      user("second request"),
      assistant(textPart("ok")),
      user("final review"),
    );
    const { compaction } = compileFabricSummary(session, 1000) as { compaction: { summary: string } };
    // Goal truncated to 3 lines + ellipsis.
    expect(compaction.summary).toContain("goal line one");
    expect(compaction.summary).toContain("goal line three");
    expect(compaction.summary).toContain("…");
    expect(compaction.summary).toContain("- second request");
    expect(compaction.summary).not.toContain("- final review");
  });
});