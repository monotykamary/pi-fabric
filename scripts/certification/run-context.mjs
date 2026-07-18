import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { encodeCwdDir } from "../../dist/memory/discovery.js";
import { normalizeSession } from "../../dist/memory/normalize.js";
import { MemoryProvider } from "../../dist/providers/memory-provider.js";
import {
  contextEntriesMatch,
  expectedContextEntriesAfterCompaction,
  invokeRegisteredFabricCompactor,
  PI_COMPACTION_API,
  prepareEligibleCompaction,
} from "./pi-compaction.mjs";
import {
  evaluateCertification,
  evaluateFixtureOracle,
  formatHumanReport,
  runDeterministicHandoff,
  snapshotFiles,
} from "./context-lib.mjs";

const POISON_PREFIX = "PRIOR_SUMMARY_POISON_991";
const GOAL = "Goal: stabilize compaction and cross-session memory certification.";
const CONSTRAINT = "Constraint: never modify forbidden.txt and keep all work offline.";
const RARE_FACT = "Pinned fact: quasarneedle_7f91 maps to Ωmega雪 and port 43117.";
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const user = (content) => ({ role: "user", content, timestamp: Date.now() });
const assistantText = (text) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "anthropic-messages",
  provider: "certification",
  model: "deterministic",
  usage,
  stopReason: "stop",
  timestamp: Date.now(),
});
const assistantCall = (id, name, arguments_) => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name, arguments: arguments_ }],
  api: "anthropic-messages",
  provider: "certification",
  model: "deterministic",
  usage,
  stopReason: "toolUse",
  timestamp: Date.now(),
});
const toolResult = (toolCallId, toolName, text, isError = false, details) => ({
  role: "toolResult",
  toolCallId,
  toolName,
  content: [{ type: "text", text }],
  isError,
  ...(details === undefined ? {} : { details }),
  timestamp: Date.now(),
});

const pairSplitCount = (entries, firstKeptEntryId) => {
  const boundary = firstKeptEntryId
    ? entries.findIndex((entry) => entry.id === firstKeptEntryId)
    : entries.length;
  const pairs = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.type !== "message") continue;
    const side = index < boundary ? "summary" : "kept";
    const message = entry.message;
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type !== "toolCall" || typeof part.id !== "string") continue;
        const pair = pairs.get(part.id) ?? {};
        pair.call = side;
        pairs.set(part.id, pair);
      }
    }
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const pair = pairs.get(message.toolCallId) ?? {};
      pair.result = side;
      pairs.set(message.toolCallId, pair);
    }
  }
  return [...pairs.values()].filter((pair) => pair.call && pair.result && pair.call !== pair.result).length;
};

const directoryBytes = (root) => {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    total += entry.isDirectory() ? directoryBytes(target) : entry.isFile() ? fs.statSync(target).size : 0;
  }
  return total;
};

const invocationContext = (cwd) => ({
  cwd,
  signal: undefined,
  parentToolCallId: "certification",
  nestedToolCallId: "certification-memory",
  extensionContext: {},
  update() {},
});

const compileEligibleManager = (manager, customInstructions) => {
  const eligibility = prepareEligibleCompaction(manager);
  if (!eligibility.eligible) throw new Error("Fixture was not eligible under Pi shouldCompact semantics");
  if (!eligibility.preparation) throw new Error("Pi prepareCompaction returned undefined for an eligible fixture");
  if (!contextEntriesMatch(eligibility.builtEntries, eligibility.publicBuiltEntries)) {
    throw new Error("SessionManager and public buildContextEntries disagree");
  }
  const invoked = invokeRegisteredFabricCompactor({
    preparation: eligibility.preparation,
    branchEntries: eligibility.branchEntries,
    customInstructions,
  });
  if (!invoked.result || !("compaction" in invoked.result)) {
    throw new Error("Registered Fabric hook did not return a compaction");
  }
  return { eligibility, invoked, compaction: invoked.result.compaction };
};

const appendAndCheckContext = (manager, expected, append) => {
  const entryId = append();
  const entry = manager.getEntry(entryId);
  const nextExpected = entry ? [...expected, entry] : expected;
  const matches = entry !== undefined
    && contextEntriesMatch(manager.buildContextEntries(), nextExpected);
  return { entryId, expected: nextExpected, matches };
};

const createContextCertification = (sessionDir, cwd) => {
  const manager = SessionManager.create(cwd, sessionDir);
  manager.appendMessage(user(`${GOAL}\n${CONSTRAINT}\n${RARE_FACT}`));
  manager.appendMessage(assistantCall("initial-read", "read", { path: "src/original.ts" }));
  manager.appendMessage(toolResult("initial-read", "read", "original source"));
  manager.appendMessage(assistantCall("initial-error", "read", { path: "src/rare-missing.ts" }));
  manager.appendMessage(toolResult("initial-error", "read", "ENOENT certification-open-error", true));
  manager.appendMessage(user("Cycle boundary 0"));

  const summaryBytes = [];
  const emittedEntryIds = new Set();
  let goalRetained = true;
  let constraintsRetained = true;
  let rareFactRetained = true;
  let cumulativeAddressesValid = true;
  let callResultSplitCount = 0;
  let invalidFirstKeptCount = 0;
  let poisonLeakCount = 0;
  let poisonStoredCount = 0;
  let byteMismatchCount = 0;
  let eligibleCycleCount = 0;
  let prepareUndefinedCount = 0;
  let builtContextMismatchCount = 0;
  let priorSummaryObservedCount = 0;
  let priorSummaryFedAsInput = false;
  let previousStoredSummary;
  let previousPoison;

  for (let cycle = 0; cycle < 100; cycle += 1) {
    const eligibility = prepareEligibleCompaction(manager);
    eligibleCycleCount += eligibility.eligible ? 1 : 0;
    prepareUndefinedCount += eligibility.preparation ? 0 : 1;
    builtContextMismatchCount += contextEntriesMatch(
      eligibility.builtEntries,
      eligibility.publicBuiltEntries,
    ) ? 0 : 1;
    if (!eligibility.eligible || !eligibility.preparation) {
      throw new Error(`Pi compaction was ineligible at cycle ${cycle + 1}`);
    }
    if (cycle > 0 && eligibility.preparation.previousSummary === previousStoredSummary) {
      priorSummaryObservedCount += 1;
    }

    const invoked = invokeRegisteredFabricCompactor({
      preparation: eligibility.preparation,
      branchEntries: eligibility.branchEntries,
    });
    priorSummaryFedAsInput ||= invoked.instrumentation.priorSummaryFedAsInput;
    if (!invoked.result || !("compaction" in invoked.result)) {
      throw new Error(`Fabric compaction cancelled at cycle ${cycle + 1}`);
    }
    const compacted = invoked.result.compaction;
    const summary = compacted.summary;
    const details = compacted.details;
    summaryBytes.push(Buffer.byteLength(summary, "utf8"));
    goalRetained &&= summary.includes(GOAL);
    constraintsRetained &&= summary.includes(CONSTRAINT);
    rareFactRetained &&= summary.includes(RARE_FACT);
    poisonLeakCount += previousPoison && summary.includes(previousPoison) ? 1 : 0;
    if (compacted.firstKeptEntryId
      && !eligibility.branchEntries.some((entry) => entry.id === compacted.firstKeptEntryId)) {
      invalidFirstKeptCount += 1;
    }
    callResultSplitCount += pairSplitCount(eligibility.branchEntries, compacted.firstKeptEntryId);

    const sourceRange = details.coverage.cumulativeSourceRange;
    const stableRange = details.stableAddresses.cumulativeSourceRange;
    cumulativeAddressesValid &&= sourceRange.first !== ""
      && sourceRange.last !== ""
      && stableRange.first === sourceRange.first
      && stableRange.last === sourceRange.last
      && eligibility.branchEntries.some((entry) => entry.id === sourceRange.first)
      && eligibility.branchEntries.some((entry) => entry.id === sourceRange.last)
      && summary.includes("original.ts")
      && summary.includes("rare-missing.ts")
      && summary.includes("ENOENT certification-open-error");

    for (const entry of eligibility.branchEntries) {
      if (entry.type === "message" && summary.includes(entry.id)) emittedEntryIds.add(entry.id);
    }
    for (const address of [
      compacted.firstKeptEntryId,
      sourceRange.first,
      sourceRange.last,
      details.coverage.liveCutRange.first,
      details.coverage.liveCutRange.last,
    ]) {
      if (address) emittedEntryIds.add(address);
    }

    const poison = `${POISON_PREFIX}_cycle_${String(cycle + 1).padStart(3, "0")}`;
    const storedSummary = `${summary}\n${poison}`;
    const compactionId = manager.appendCompaction(
      storedSummary,
      compacted.firstKeptEntryId,
      compacted.tokensBefore,
      details,
      true,
    );
    const compactionEntry = manager.getEntry(compactionId);
    if (!compactionEntry || compactionEntry.type !== "compaction") {
      throw new Error("Pi did not persist the CompactionEntry");
    }
    poisonStoredCount += compactionEntry.summary.endsWith(poison) ? 1 : 0;
    const expectedAfterCompaction = expectedContextEntriesAfterCompaction(
      eligibility.branchEntries,
      compactionEntry,
    );
    builtContextMismatchCount += contextEntriesMatch(
      manager.buildContextEntries(),
      expectedAfterCompaction,
    ) ? 0 : 1;
    byteMismatchCount += compactionEntry.summary === storedSummary
      && JSON.stringify(compactionEntry.details) === JSON.stringify(details) ? 0 : 1;

    const callId = `cycle-write-${cycle}`;
    let checked = appendAndCheckContext(manager, expectedAfterCompaction, () =>
      manager.appendMessage(assistantCall(callId, "write", {
        path: `src/cycles/file-${String(cycle).padStart(3, "0")}.ts`,
      })));
    builtContextMismatchCount += checked.matches ? 0 : 1;
    checked = appendAndCheckContext(manager, checked.expected, () =>
      manager.appendMessage(toolResult(callId, "write", `wrote deterministic cycle ${cycle}`)));
    builtContextMismatchCount += checked.matches ? 0 : 1;
    checked = appendAndCheckContext(manager, checked.expected, () =>
      manager.appendMessage(user(`Cycle boundary ${cycle + 1}`)));
    builtContextMismatchCount += checked.matches ? 0 : 1;

    previousStoredSummary = storedSummary;
    previousPoison = poison;
  }

  const entries = manager.getEntries();
  const parentLinksValid = entries.every((entry, index) => index === 0
    ? entry.parentId === null
    : entry.parentId === entries[index - 1].id);
  cumulativeAddressesValid &&= parentLinksValid
    && entries.filter((entry) => entry.type === "compaction").length === 100;
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error("Expected a persisted context session");
  return {
    session: { id: manager.getSessionId(), file: sessionFile },
    emittedEntryIds,
    metrics: {
      cycles: 100,
      eligibleCycleCount,
      prepareUndefinedCount,
      builtContextMismatchCount,
      summaryBytes,
      maxSummaryBytes: Math.max(...summaryBytes),
      goalRetained,
      constraintsRetained,
      rareFactRetained,
      cumulativeAddressesValid,
      callResultSplitCount,
      invalidFirstKeptCount,
      poisonLeakCount,
      poisonStoredCount,
      byteMismatchCount,
      parentLinksValid,
      priorSummaryObservedCount,
      priorSummaryFedAsInput,
    },
  };
};

const createClosureFixtures = (sessionDir, cwd) => {
  const counts = {
    normal: 0,
    compactAll: 0,
    splitTurn: 0,
    parallelDelayed: 0,
    reverseOrder: 0,
    malformedBoundary: 0,
  };

  const normal = SessionManager.create(cwd, sessionDir);
  normal.appendMessage(user("normal old turn " + "雪".repeat(80)));
  normal.appendMessage(assistantText("normal completion " + "界".repeat(80)));
  normal.appendMessage(user("normal kept turn"));
  const normalResult = compileEligibleManager(normal);
  if (normalResult.compaction.firstKeptEntryId
    && pairSplitCount(normalResult.eligibility.branchEntries, normalResult.compaction.firstKeptEntryId) === 0) {
    counts.normal += 1;
  }

  const compactAll = SessionManager.create(cwd, sessionDir);
  compactAll.appendMessage(user("single turn " + "雪界".repeat(120)));
  compactAll.appendMessage(assistantText("single response " + "界雪".repeat(120)));
  const compactAllResult = compileEligibleManager(compactAll);
  if (compactAllResult.compaction.firstKeptEntryId === "") counts.compactAll += 1;

  const splitTurn = SessionManager.create(cwd, sessionDir);
  splitTurn.appendMessage(user("split request " + "雪界".repeat(200)));
  splitTurn.appendMessage(assistantText("split response " + "界雪".repeat(200)));
  const splitResult = compileEligibleManager(splitTurn);
  if (splitResult.eligibility.preparation.isSplitTurn
    && pairSplitCount(splitResult.eligibility.branchEntries, splitResult.compaction.firstKeptEntryId) === 0) {
    counts.splitTurn += 1;
  }

  const parallel = SessionManager.create(cwd, sessionDir);
  parallel.appendMessage(user("parallel delayed request " + "雪".repeat(80)));
  parallel.appendMessage(assistantCall("parallel-a", "read", { path: "src/a.ts" }));
  parallel.appendMessage(assistantCall("parallel-b", "read", { path: "src/b.ts" }));
  parallel.appendMessage(toolResult("parallel-b", "read", "b"));
  parallel.appendMessage(user("candidate boundary"));
  parallel.appendMessage(assistantText("work continues"));
  parallel.appendMessage(toolResult("parallel-a", "read", "delayed a"));
  parallel.appendMessage(assistantText("delayed result observed"));
  const parallelResult = compileEligibleManager(parallel);
  if (parallelResult.compaction.firstKeptEntryId === ""
    && pairSplitCount(parallelResult.eligibility.branchEntries, parallelResult.compaction.firstKeptEntryId) === 0) {
    counts.parallelDelayed += 1;
  }

  const reverse = SessionManager.create(cwd, sessionDir);
  reverse.appendMessage(user("reverse malformed ordering " + "界".repeat(80)));
  reverse.appendMessage(toolResult("reverse-call", "read", "result before call"));
  reverse.appendMessage(assistantCall("reverse-call", "read", { path: "src/reverse.ts" }));
  reverse.appendMessage(user("reverse kept boundary"));
  const reverseResult = compileEligibleManager(reverse);
  if (pairSplitCount(reverseResult.eligibility.branchEntries, reverseResult.compaction.firstKeptEntryId) === 0) {
    counts.reverseOrder += 1;
  }

  const malformed = SessionManager.create(cwd, sessionDir);
  malformed.appendMessage(user("historical malformed boundary"));
  malformed.appendMessage(assistantText("historical response"));
  malformed.appendCompaction("untrusted prior summary", "orphan-kept-entry", 100, {}, true);
  malformed.appendMessage(user("live after orphan " + "雪".repeat(80)));
  malformed.appendMessage(assistantText("live response " + "界".repeat(80)));
  malformed.appendMessage(user("malformed boundary kept turn"));
  const malformedResult = compileEligibleManager(malformed);
  if (malformedResult.eligibility.branchEntries.some(
    (entry) => entry.type === "compaction" && entry.firstKeptEntryId === "orphan-kept-entry",
  ) && pairSplitCount(
    malformedResult.eligibility.branchEntries,
    malformedResult.compaction.firstKeptEntryId,
  ) === 0) counts.malformedBoundary += 1;

  return counts;
};

const createMaximalMultibyteFixture = (sessionDir, cwd) => {
  const manager = SessionManager.create(cwd, sessionDir);
  manager.appendMessage(user([
    `目标 ${"雪界Ω".repeat(900)}`,
    `约束 ${"漢字é".repeat(900)}`,
    `事实 ${"🚀霜".repeat(900)}`,
  ].join("\n")));
  for (let index = 0; index < 48; index += 1) {
    const suffix = String(index).padStart(2, "0");
    manager.appendMessage(assistantCall(`max-write-${suffix}`, "write", {
      path: `src/${"多字节".repeat(30)}-${suffix}.ts`,
    }));
    manager.appendMessage(toolResult(
      `max-write-${suffix}`,
      "write",
      `写入成功 ${"内容雪界".repeat(70)}`,
    ));
    manager.appendMessage(assistantCall(`max-read-${suffix}`, "read", {
      path: `missing/${"错误雪".repeat(30)}-${suffix}.ts`,
    }));
    manager.appendMessage(toolResult(
      `max-read-${suffix}`,
      "read",
      `读取失败 ${"罕见错误Ω雪".repeat(70)}`,
      true,
    ));
    manager.appendMessage(user(`范围变更 ${suffix} ${"继续保持多字节事实".repeat(55)}`));
  }
  const trace = {
    kind: "pi-fabric.execution",
    version: 1,
    outcome: "succeeded",
    phases: Array.from({ length: 20 }, (_, index) => `阶段${index} ${"并行多字节".repeat(20)}`),
    operations: Array.from({ length: 40 }, (_, index) => ({
      type: "call",
      sequence: index,
      ref: `extensions.action${index}`,
      provider: "extensions",
      action: `action${index}`,
      args: { label: `活动 ${"雪界漢字".repeat(24)}` },
      outcome: "succeeded",
      result: { status: `完成 ${"Ω霜".repeat(20)}` },
    })),
    counts: { droppedValues: 0, truncatedValues: 0, redactedValues: 0, droppedOperations: 0 },
  };
  manager.appendMessage(assistantCall("max-fabric", "fabric_exec", { source: "return exact typed trace" }));
  manager.appendMessage(toolResult(
    "max-fabric",
    "fabric_exec",
    "typed trace persisted",
    false,
    { trace },
  ));
  manager.appendMessage(user(`最终范围 ${"保持最大多字节上下文".repeat(80)}`));
  const compiled = compileEligibleManager(manager, `保留请求 ${"雪界漢字Ω".repeat(1800)}`);
  const summary = compiled.compaction.summary;
  const encoded = Buffer.from(summary, "utf8");
  let validUtf8 = false;
  try {
    validUtf8 = new TextDecoder("utf-8", { fatal: true }).decode(encoded) === summary;
  } catch {
    validUtf8 = false;
  }
  const sectionBytes = Object.fromEntries(
    summary.split(/\n\n(?=\[)/u).map((section) => [
      section.slice(0, section.indexOf("]") + 1),
      Buffer.byteLength(section, "utf8"),
    ]),
  );
  return {
    sourceBytes: fs.statSync(manager.getSessionFile()).size,
    summaryBytes: encoded.length,
    validUtf8,
    limitBytes: 32 * 1024,
    nearBound: encoded.length >= 24 * 1024,
    sectionBytes,
  };
};

const createMemoryCertification = async ({ agentDir, cwd, sessionDir, contextResult, indexDir }) => {
  const baseSeconds = 1_700_000_000;
  let rareSessionFile = "";
  let rareEntryId = "";
  const coldRareFact = "cold_exact_quasar_7f91 Ωmega雪 address=43117";
  for (let index = 0; index < 1_000; index += 1) {
    const manager = SessionManager.create(cwd, sessionDir);
    const text = index === 0
      ? coldRareFact
      : `common certification distractor session_${String(index).padStart(4, "0")}`;
    const entryId = manager.appendMessage(user(text));
    manager.appendMessage(assistantText("Indexed certification session."));
    const file = manager.getSessionFile();
    if (!file) throw new Error("Expected a persisted memory session");
    fs.utimesSync(file, baseSeconds + index, baseSeconds + index);
    if (index === 0) {
      rareSessionFile = file;
      rareEntryId = entryId;
    }
  }
  fs.utimesSync(contextResult.session.file, baseSeconds + 2_000, baseSeconds + 2_000);

  const provider = new MemoryProvider({
    agentDir,
    cwd,
    sessionId: contextResult.session.id,
    config: {
      enabled: true,
      indexDir,
      maxSessions: 25,
      maxEntryChars: 1_000_000,
      hotSessions: 8,
      digestTerms: 8,
    },
  });
  const recalled = await provider.invoke(
    "recall",
    { scope: "global", query: "cold_exact_quasar_7f91", queryMode: "literal", pageSize: 20 },
    invocationContext(cwd),
  );
  const rareHit = recalled.digestHits.find(
    (hit) => hit.sessionId === SessionManager.open(rareSessionFile).getSessionId(),
  );
  const rareHydration = rareHit
    ? await provider.invoke(
      "recall",
      {
        scope: `session:${rareHit.sessionFile}`,
        expectedSourceHash: rareHit.sourceHash,
        query: "cold_exact_quasar_7f91",
        queryMode: "literal",
        pageSize: 20,
      },
      invocationContext(cwd),
    )
    : { segments: [], error: { code: "missing_cold_pointer" } };
  const hydratedEntryIds = rareHydration.segments.flatMap((segment) =>
    segment.entries
      .filter((item) => item.matched && item.entry.entryId)
      .map((item) => item.entry.entryId));
  const rareExpansion = rareHit
    ? await provider.invoke(
      "expand",
      {
        session: rareHit.sessionFile,
        expectedSourceHash: rareHit.sourceHash,
        entryIds: hydratedEntryIds,
      },
      invocationContext(cwd),
    )
    : { expanded: [], error: { code: "missing_cold_pointer" } };

  const sourceById = new Map(
    normalizeSession(contextResult.session.file, Number.MAX_SAFE_INTEGER).entries
      .filter((entry) => entry.entryId !== null)
      .map((entry) => [entry.entryId, entry.text]),
  );
  const emittedIds = [...contextResult.emittedEntryIds];
  const contextPointer = await provider.invoke(
    "expand",
    { session: contextResult.session.id },
    invocationContext(cwd),
  );
  const expandedAddresses = await provider.invoke(
    "expand",
    {
      session: contextResult.session.id,
      expectedSourceHash: contextPointer.sourceHash,
      entryIds: emittedIds,
    },
    invocationContext(cwd),
  );
  const expandedById = new Map(expandedAddresses.expanded.map((entry) => [entry.entryId, entry.text]));
  const expandedCorrectly = emittedIds.filter((id) => expandedById.get(id) === sourceById.get(id)).length;
  const rareTier = rareHit?.tier ?? "missing";
  const sourceRoot = path.join(agentDir, "sessions");

  return {
    eligibleSessions: recalled.coverage.eligibleSessions,
    indexedSessions: recalled.coverage.indexedSessions,
    staleSessions: recalled.coverage.staleSessions,
    coverageComplete: recalled.coverage.complete,
    rareSessionTier: rareTier,
    rareRecallExact: Boolean(rareHit)
      && rareHydration.error === undefined
      && hydratedEntryIds.includes(rareEntryId)
      && rareExpansion.error === undefined
      && rareExpansion.expanded.some(
        (entry) => entry.entryId === rareEntryId && entry.text === coldRareFact,
      ),
    emittedAddresses: emittedIds.length,
    expandedAddresses: expandedCorrectly,
    addressExpansionRate: emittedIds.length === 0 ? 0 : expandedCorrectly / emittedIds.length,
    integrityBoundExpansion: typeof contextPointer.sourceHash === "string"
      && contextPointer.sourceHash.length === 64
      && expandedAddresses.sourceHash === contextPointer.sourceHash,
    cacheVersionBehavior: "V5 sourceHash checked for cold hydration and address expansion",
    cacheBytes: directoryBytes(indexDir),
    sourceBytes: directoryBytes(sourceRoot),
  };
};

const fixtures = [
  {
    name: "create-module",
    initialFiles: {
      "package.json": "{\"type\":\"module\"}\n",
      "test.mjs": "import assert from 'node:assert/strict';\nimport { sum } from './src/sum.js';\nassert.equal(sum(2, 3), 5);\n",
      "forbidden.txt": "do-not-touch\n",
    },
    task: {
      operations: [{ type: "write", path: "src/sum.js", content: "export const sum = (left, right) => left + right;\n" }],
    },
    expectedFiles: {
      "package.json": "{\"type\":\"module\"}\n",
      "test.mjs": "import assert from 'node:assert/strict';\nimport { sum } from './src/sum.js';\nassert.equal(sum(2, 3), 5);\n",
      "forbidden.txt": "do-not-touch\n",
      "src/sum.js": "export const sum = (left, right) => left + right;\n",
    },
    forbiddenPaths: ["forbidden.txt"],
    test: { command: process.execPath, args: ["test.mjs"] },
  },
  {
    name: "targeted-replacement",
    initialFiles: {
      "config.json": "{\"enabled\":false,\"port\":43117}\n",
      "verify.mjs": "import assert from 'node:assert/strict';\nimport fs from 'node:fs';\nconst value = JSON.parse(fs.readFileSync('config.json', 'utf8'));\nassert.deepEqual(value, { enabled: true, port: 43117 });\n",
      "notes/forbidden.md": "historical record\n",
    },
    task: {
      operations: [{ type: "replace", path: "config.json", oldText: "\"enabled\":false", newText: "\"enabled\":true" }],
    },
    expectedFiles: {
      "config.json": "{\"enabled\":true,\"port\":43117}\n",
      "verify.mjs": "import assert from 'node:assert/strict';\nimport fs from 'node:fs';\nconst value = JSON.parse(fs.readFileSync('config.json', 'utf8'));\nassert.deepEqual(value, { enabled: true, port: 43117 });\n",
      "notes/forbidden.md": "historical record\n",
    },
    forbiddenPaths: ["notes/forbidden.md"],
    test: { command: process.execPath, args: ["verify.mjs"] },
  },
];

const memoryConfig = (indexDir) => ({
  enabled: true,
  indexDir,
  maxSessions: 25,
  maxEntryChars: 256,
  hotSessions: 8,
  digestTerms: 8,
});

const resumeContinuationFromPersistedHandoff = async ({ handoffFile, root, agentDir, cwd, indexDir }) => {
  const persisted = JSON.parse(fs.readFileSync(handoffFile, "utf8"));
  const provider = new MemoryProvider({
    agentDir,
    cwd,
    sessionId: persisted.currentSession.id,
    config: memoryConfig(indexDir),
  });
  const memory = {
    currentSessionPointer: async () => {
      const result = await provider.invoke(
        "expand",
        { session: persisted.currentSession.id },
        invocationContext(cwd),
      );
      if (result.error) return undefined;
      return { session: result.session, sourceHash: result.sourceHash };
    },
    expand: ({ pointer, entryIds }) => provider.invoke(
      "expand",
      {
        session: pointer.session,
        expectedSourceHash: pointer.sourceHash,
        entryIds,
      },
      invocationContext(cwd),
    ),
  };
  return runDeterministicHandoff({
    root,
    compactedContext: persisted.compactedContext,
    memory,
  });
};

const createContinuationCertification = async ({ root, sessionDir, cwd, agentDir, indexDir }) => {
  const results = [];
  for (const fixture of fixtures) {
    const fixtureRoot = path.join(root, "continuation", fixture.name);
    for (const [relative, content] of Object.entries(fixture.initialFiles)) {
      const file = path.join(fixtureRoot, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, "utf8");
    }
    const forbiddenBefore = snapshotFiles(fixtureRoot, fixture.forbiddenPaths);
    const manager = SessionManager.create(cwd, sessionDir);
    const taskText = `CERT_TASK_V1\n${JSON.stringify({ ...fixture.task, padding: "雪".repeat(1_500) })}`;
    manager.appendMessage(user(taskText));
    manager.appendMessage(assistantText("Task accepted; exact source remains memory-addressable."));
    manager.appendMessage(user("Compact before continuation"));
    const compiled = compileEligibleManager(manager);
    const compactionId = manager.appendCompaction(
      compiled.compaction.summary,
      compiled.compaction.firstKeptEntryId,
      compiled.compaction.tokensBefore,
      compiled.compaction.details,
      true,
    );
    const compactionEntry = manager.getEntry(compactionId);
    const expected = expectedContextEntriesAfterCompaction(
      compiled.eligibility.branchEntries,
      compactionEntry,
    );
    if (!contextEntriesMatch(manager.buildContextEntries(), expected)) {
      throw new Error(`Built continuation context mismatch for ${fixture.name}`);
    }
    const handoffFile = path.join(root, "handoffs", `${fixture.name}.json`);
    fs.mkdirSync(path.dirname(handoffFile), { recursive: true });
    fs.writeFileSync(handoffFile, JSON.stringify({
      currentSession: { id: manager.getSessionId() },
      compactedContext: {
        summary: compiled.compaction.summary,
        details: compiled.compaction.details,
      },
    }), "utf8");

    const handoff = await resumeContinuationFromPersistedHandoff({
      handoffFile,
      root: fixtureRoot,
      agentDir,
      cwd,
      indexDir,
    });
    const oracle = evaluateFixtureOracle(fixtureRoot, fixture, forbiddenBefore);
    results.push({
      name: fixture.name,
      handoff: {
        operationCount: handoff.operationCount,
        taskAddress: handoff.taskAddress,
        addressResolved: handoff.addressResolved,
      },
      oracle: { passed: oracle.passed, failures: oracle.failures, testStatus: oracle.test.status },
    });
  }
  const passedFixtures = results.filter((result) => result.oracle.passed).length;
  return {
    totalFixtures: results.length,
    passedFixtures,
    passRate: results.length === 0 ? 0 : passedFixtures / results.length,
    addressesResolved: results.length > 0 && results.every((result) => result.handoff.addressResolved),
    primaryMetric: "executable filesystem, forbidden-change, and process-test oracle",
    simulatorInputs: "persisted compacted context plus fresh integrity-bound MemoryProvider APIs",
    results,
  };
};

export const runContextCertification = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fabric-certification-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "repo");
  const sessionDir = path.join(agentDir, "sessions", encodeCwdDir(cwd));
  const indexDir = path.join(root, "memory-index");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const contextResult = createContextCertification(sessionDir, cwd);
    contextResult.metrics.closureFixtureCounts = createClosureFixtures(sessionDir, cwd);
    contextResult.metrics.maximalMultibyte = createMaximalMultibyteFixture(sessionDir, cwd);
    const memory = await createMemoryCertification({ agentDir, cwd, sessionDir, contextResult, indexDir });
    const continuation = await createContinuationCertification({
      root,
      sessionDir,
      cwd,
      agentDir,
      indexDir,
    });
    const report = {
      schemaVersion: 2,
      deterministic: true,
      piApi: PI_COMPACTION_API,
      context: contextResult.metrics,
      memory,
      continuation,
    };
    report.evaluation = evaluateCertification(report);
    return report;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

export { formatHumanReport };
