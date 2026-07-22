import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const DEFAULT_THRESHOLDS = Object.freeze({
  cycles: 100,
  maxSummaryBytes: 32 * 1024,
  maxSteadyRangeBytes: 512,
  maxSteadySlopeBytesPerCycle: 16,
  minimumSessions: 1_000,
  minimumAddressExpansionRate: 1,
  minimumContinuationPassRate: 1,
  minimumMaximalSummaryBytes: 24 * 1024,
});

export const linearSlope = (values) => {
  if (values.length < 2) return 0;
  const meanX = (values.length - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    const dx = index - meanX;
    numerator += dx * (values[index] - meanY);
    denominator += dx * dx;
  }
  return denominator === 0 ? 0 : numerator / denominator;
};

export const evaluateCertification = (report, thresholds = DEFAULT_THRESHOLDS) => {
  const steadySizes = report.context.summaryBytes.slice(-20);
  const steadyRange = steadySizes.length === 0 ? Number.POSITIVE_INFINITY : Math.max(...steadySizes) - Math.min(...steadySizes);
  const steadySlope = linearSlope(steadySizes);
  const checks = [
    ["context.cycles", report.context.cycles === thresholds.cycles, `${report.context.cycles} === ${thresholds.cycles}`],
    ["context.eligibility", report.context.eligibleCycleCount === thresholds.cycles && report.context.prepareUndefinedCount === 0, `${report.context.eligibleCycleCount} eligible; ${report.context.prepareUndefinedCount} undefined preparations`],
    ["context.builtContext", report.context.builtContextMismatchCount === 0, `${report.context.builtContextMismatchCount} mismatches`],
    ["context.priorSummaryInput", report.context.priorSummaryFedAsInput === false && report.context.priorSummaryObservedCount === thresholds.cycles - 1, `${report.context.priorSummaryObservedCount} prior summaries observed; fed=${String(report.context.priorSummaryFedAsInput)}`],
    ["context.goal", report.context.goalRetained === true, "original goal retained in every cycle"],
    ["context.constraints", report.context.constraintsRetained === true, "constraints retained in every cycle"],
    ["context.rareFact", report.context.rareFactRetained === true, "pinned rare fact retained in every cycle"],
    ["context.addresses", report.context.cumulativeAddressesValid === true, "cumulative file/error addresses remain valid"],
    ["context.callResultClosure", report.context.callResultSplitCount === 0, `${report.context.callResultSplitCount} split pairs`],
    ["context.firstKept", report.context.invalidFirstKeptCount === 0, `${report.context.invalidFirstKeptCount} invalid ids`],
    ["context.poison", report.context.poisonLeakCount === 0 && report.context.poisonStoredCount === thresholds.cycles, `${report.context.poisonLeakCount} leaks; ${report.context.poisonStoredCount} stored`],
    ["context.determinism", report.context.byteMismatchCount === 0, `${report.context.byteMismatchCount} mismatches`],
    ["context.size", report.context.maxSummaryBytes <= thresholds.maxSummaryBytes, `${report.context.maxSummaryBytes} <= ${thresholds.maxSummaryBytes}`],
    ["context.maximalUtf8", report.context.maximalMultibyte.validUtf8 === true && report.context.maximalMultibyte.summaryBytes >= thresholds.minimumMaximalSummaryBytes && report.context.maximalMultibyte.summaryBytes <= thresholds.maxSummaryBytes, `${report.context.maximalMultibyte.summaryBytes} bytes; valid=${String(report.context.maximalMultibyte.validUtf8)}`],
    ["context.closureFixtures", Object.values(report.context.closureFixtureCounts).every((count) => count > 0), JSON.stringify(report.context.closureFixtureCounts)],
    ["context.steadyRange", steadyRange <= thresholds.maxSteadyRangeBytes, `${steadyRange} <= ${thresholds.maxSteadyRangeBytes}`],
    ["context.steadySlope", Math.abs(steadySlope) <= thresholds.maxSteadySlopeBytesPerCycle, `${steadySlope.toFixed(3)} <= ±${thresholds.maxSteadySlopeBytesPerCycle}`],
    ["memory.sessions", report.memory.eligibleSessions >= thresholds.minimumSessions, `${report.memory.eligibleSessions} >= ${thresholds.minimumSessions}`],
    ["memory.coverage", report.memory.coverageComplete === true, "all eligible sessions indexed"],
    ["memory.rareRecall", report.memory.rareRecallExact === true, "cold rare fact recalled and expanded exactly"],
    ["memory.structuralRecall", report.memory.structuralRecallExact === true, "cold exact-ref head recalled and integrity-bound hydration returned the typed operation"],
    ["memory.structuralNegative", report.memory.structuralNegativeControl === true, "nonexistent exact ref returned no structural results"],
    ["memory.cold", report.memory.rareSessionTier === "cold", `${report.memory.rareSessionTier} === cold`],
    ["memory.addressExpansion", report.memory.addressExpansionRate >= thresholds.minimumAddressExpansionRate, `${report.memory.addressExpansionRate} >= ${thresholds.minimumAddressExpansionRate}`],
    ["memory.integrityBound", report.memory.integrityBoundExpansion === true, "V6 sourceHash pointer verified during expansion"],
    ["continuation.address", report.continuation.addressesResolved === true, "every continuation address resolved through MemoryProvider"],
    ["continuation.oracle", report.continuation.passRate >= thresholds.minimumContinuationPassRate, `${report.continuation.passRate} >= ${thresholds.minimumContinuationPassRate}`],
  ].map(([id, passed, evidence]) => ({ id, passed, evidence }));
  return {
    passed: checks.every((check) => check.passed),
    checks,
    derived: { steadyRangeBytes: steadyRange, steadySlopeBytesPerCycle: steadySlope },
  };
};

const walkFiles = (root, relative = "") => {
  const directory = path.join(root, relative);
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(root, child));
    else if (entry.isFile()) files.push(child.split(path.sep).join("/"));
  }
  return files;
};

export const snapshotFiles = (root, relativePaths) => Object.fromEntries(
  relativePaths.map((relative) => [relative, fs.existsSync(path.join(root, relative)) ? fs.readFileSync(path.join(root, relative), "utf8") : null]),
);

export const evaluateFixtureOracle = (root, fixture, forbiddenBefore = {}) => {
  const failures = [];
  for (const [relative, expected] of Object.entries(fixture.expectedFiles)) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) failures.push(`${relative}: missing`);
    else if (fs.readFileSync(file, "utf8") !== expected) failures.push(`${relative}: content mismatch`);
  }
  for (const [relative, before] of Object.entries(forbiddenBefore)) {
    const file = path.join(root, relative);
    const after = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (after !== before) failures.push(`${relative}: forbidden change`);
  }
  const allowed = new Set([...Object.keys(fixture.initialFiles), ...Object.keys(fixture.expectedFiles)]);
  for (const relative of walkFiles(root)) {
    if (relative.startsWith(".git/")) continue;
    if (!allowed.has(relative)) failures.push(`${relative}: unexpected file`);
  }
  let test = { command: fixture.test.command, args: fixture.test.args, status: null, stdout: "", stderr: "" };
  if (failures.length === 0) {
    const result = spawnSync(fixture.test.command, fixture.test.args, {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, PI_OFFLINE: "1" },
    });
    test = {
      ...test,
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
    if (result.status !== 0) failures.push(`test exited ${result.status ?? "without status"}`);
  }
  return { passed: failures.length === 0, failures, test };
};

const resolveInside = (root, relative) => {
  const resolved = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!resolved.startsWith(prefix)) throw new Error(`Task path escapes fixture: ${relative}`);
  return resolved;
};

export const runDeterministicHandoff = async ({ root, compactedContext, memory }) => {
  const details = compactedContext.details;
  if (!details || details.stableAddresses?.recall !== "session-entry-id-range") {
    throw new Error("Compacted context has no supported recall address");
  }
  const taskAddress = details.coverage?.cumulativeSourceRange?.first;
  if (typeof taskAddress !== "string" || taskAddress.length === 0) {
    throw new Error("Compacted context has no task address");
  }
  const pointer = await memory.currentSessionPointer();
  if (!pointer || typeof pointer.session !== "string" || typeof pointer.sourceHash !== "string") {
    throw new Error("MemoryProvider did not issue an integrity-bound current-session pointer");
  }
  const expansion = await memory.expand({ pointer, entryIds: [taskAddress] });
  if (expansion?.error) throw new Error(`Memory expansion failed: ${String(expansion.error.code)}`);
  const taskEntry = expansion?.expanded?.find((entry) => entry.entryId === taskAddress);
  const addressResolved = Boolean(taskEntry);
  if (!taskEntry || !taskEntry.text.startsWith("CERT_TASK_V1\n")) {
    throw new Error("Address did not expand to an exact CERT_TASK_V1 task");
  }
  const task = JSON.parse(taskEntry.text.slice("CERT_TASK_V1\n".length));
  if (!Array.isArray(task.operations)) throw new Error("Exact task operations are unavailable after expansion");
  for (const operation of task.operations) {
    if (!operation || typeof operation !== "object" || typeof operation.path !== "string") {
      throw new Error("Invalid task operation");
    }
    const target = resolveInside(root, operation.path);
    if (operation.type === "write" && typeof operation.content === "string") {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, operation.content, "utf8");
    } else if (operation.type === "replace" && typeof operation.oldText === "string" && typeof operation.newText === "string") {
      const before = fs.readFileSync(target, "utf8");
      if (!before.includes(operation.oldText)) throw new Error(`Replace source not found: ${operation.path}`);
      fs.writeFileSync(target, before.replace(operation.oldText, operation.newText), "utf8");
    } else {
      throw new Error(`Exact content unavailable for task operation: ${String(operation.type)}`);
    }
  }
  return { taskAddress, operationCount: task.operations.length, addressResolved };
};

export const formatHumanReport = (report) => {
  const status = report.evaluation.passed ? "PASS" : "FAIL";
  const lines = [
    `Context + memory certification: ${status}`,
    `  Compaction: ${report.context.cycles}/${report.context.eligibleCycleCount} cycles eligible; ${report.context.maxSummaryBytes} endurance / ${report.context.maximalMultibyte.summaryBytes} maximal UTF-8 bytes; ${report.evaluation.derived.steadySlopeBytesPerCycle.toFixed(2)} B/cycle steady slope`,
    `  Memory: ${report.memory.indexedSessions}/${report.memory.eligibleSessions} sessions; ${(report.memory.addressExpansionRate * 100).toFixed(1)}% address expansion; structural=${report.memory.structuralRecallExact ? "pass" : "fail"}; ${report.memory.cacheBytes} cache bytes / ${report.memory.sourceBytes} source bytes`,
    `  Continuation: ${report.continuation.passedFixtures}/${report.continuation.totalFixtures} executable fixtures passed`,
  ];
  for (const check of report.evaluation.checks.filter((candidate) => !candidate.passed)) {
    lines.push(`  FAIL ${check.id}: ${check.evidence}`);
  }
  return lines.join("\n");
};
