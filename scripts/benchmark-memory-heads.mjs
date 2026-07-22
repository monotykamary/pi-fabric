import { performance } from "node:perf_hooks";
import { ActionRegistry } from "../dist/core/action-registry.js";
import { foldSessionDigest } from "../dist/memory/digest.js";
import { searchMemoryIndex } from "../dist/memory/search.js";

const HOT_SESSIONS = 100;
const COLD_SESSIONS = 100;
const ENTRIES_PER_SESSION = 12;
const ITERATIONS = 50;
const refs = ["pi.grep", "pi.read", "agents.run", "memory.recall"];

const descriptors = {
  pi: [
    {
      name: "grep",
      description: "Search source files for matching text",
      inputSchema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } } },
      risk: "read",
    },
    {
      name: "read",
      description: "Read a local file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      risk: "read",
    },
  ],
  agents: [{
    name: "run",
    description: "Delegate work to a background agent",
    inputSchema: { type: "object", properties: { task: { type: "string" } } },
    risk: "agent",
  }],
  memory: [{
    name: "recall",
    description: "Search historical session memory",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    risk: "read",
  }],
};

const context = {
  cwd: process.cwd(),
  signal: undefined,
  parentToolCallId: "memory-head-benchmark",
  nestedToolCallId: "memory-head-benchmark-nested",
  extensionContext: {},
  update() {},
};

const registry = new ActionRegistry();
for (const [providerName, actions] of Object.entries(descriptors)) {
  registry.register({
    name: providerName,
    description: `${providerName} capability provider`,
    async list(request) {
      if (!request.query) return actions;
      const query = request.query.toLowerCase();
      return actions.filter((action) => `${action.name} ${action.description}`.toLowerCase().includes(query));
    },
    async describe(name) {
      return actions.find((action) => action.name === name);
    },
    async invoke() {
      return null;
    },
  });
}

const entry = (sessionFile, sessionId, index, ref, text) => {
  const separator = ref.indexOf(".");
  const provider = ref.slice(0, separator);
  const action = ref.slice(separator + 1);
  return {
    sessionFile,
    sessionId,
    index,
    entryId: `${sessionId}-entry-${index}`,
    parentId: index === 0 ? null : `${sessionId}-entry-${index - 1}`,
    type: "fabric_operation",
    role: "fabricOperation",
    toolName: action,
    text,
    timestamp: 1_700_000_000_000 + index,
    isError: false,
    truncated: false,
    operationAddress: `${sessionId}-carrier/${index}`,
    ref,
    provider,
    action,
    outcome: "succeeded",
  };
};

const makeEntries = (sessionId, target = false) => {
  const sessionFile = `/benchmark/${sessionId}.jsonl`;
  return Array.from({ length: ENTRIES_PER_SESSION }, (_, index) => {
    const ref = refs[index % refs.length];
    const targetText = target && index === 4
      ? " rarelexeme_target"
      : target && index === 6
        ? " rarelexeme_target"
        : "";
    return entry(sessionFile, sessionId, index, ref, `operation ${ref} opaque_${sessionId}_${index}${targetText}`);
  });
};

const shards = [];
const digests = [];
let sourceBytes = 0;
let coldSourceBytes = 0;
let digestBytes = 0;
let legacyDigestBytes = 0;
for (let index = 0; index < HOT_SESSIONS + COLD_SESSIONS; index += 1) {
  const sessionId = `session-${index}`;
  const entries = makeEntries(sessionId, index === 0 || index === HOT_SESSIONS);
  const sessionFile = entries[0].sessionFile;
  const size = Buffer.byteLength(JSON.stringify(entries), "utf8");
  sourceBytes += size;
  if (index < HOT_SESSIONS) {
    shards.push({
      cacheVersion: 6,
      kind: "shard",
      sessionFile,
      sessionId,
      mtime: 2_000_000 - index,
      size,
      sourceHash: "a".repeat(64),
      branches: "active",
      lineageFingerprint: "b".repeat(64),
      policy: "benchmark",
      cacheBytes: 0,
      cacheSourceRatio: 0,
      entries,
      totalEntryCount: entries.length,
      indexCoverage: { complete: true, reasons: [] },
      tier: "hot",
    });
  } else {
    coldSourceBytes += size;
    const folded = foldSessionDigest({
      sessionId,
      file: sessionFile,
      cwd: "/benchmark",
      entries,
    });
    const digest = {
      cacheVersion: 6,
      kind: "digest",
      ...folded,
      mtime: 2_000_000 - index,
      size,
      sourceHash: "c".repeat(64),
      branches: "active",
      lineageFingerprint: "d".repeat(64),
      policy: "benchmark",
      cacheBytes: 0,
      cacheSourceRatio: 0,
    };
    digestBytes += Buffer.byteLength(JSON.stringify(digest), "utf8");
    legacyDigestBytes += Buffer.byteLength(JSON.stringify({
      ...digest,
      cacheVersion: 5,
      addresses: digest.addresses.map((address) => address.slice(0, 6)),
    }), "utf8");
    digests.push(digest);
  }
}

const hotAddresses = (result) => new Set(
  result.segments.flatMap((segment) => segment.exactMatches)
    .map((match) => match.operationAddress)
    .filter(Boolean),
);
const coldSessions = (result) => new Set(result.digestHits.map((hit) => hit.sessionId));
const recall = (found, expected) => {
  if (expected.size === 0) return found.size === 0 ? 1 : 0;
  let matches = 0;
  for (const value of expected) if (found.has(value)) matches += 1;
  return matches / expected.size;
};

const expectedHotGrep = new Set(
  shards.flatMap((shard) => shard.entries)
    .filter((item) => item.ref === "pi.grep")
    .map((item) => item.operationAddress),
);
const expectedColdGrepSessions = new Set(
  Array.from({ length: COLD_SESSIONS }, (_, index) => `session-${HOT_SESSIONS + index}`),
);

const headQueries = [
  ["search source files", "pi.grep"],
  ["read a local file", "pi.read"],
  ["delegate work to a background agent", "agents.run"],
  ["search historical session memory", "memory.recall"],
];
const headResults = [];
for (const [query, expected] of headQueries) {
  const candidates = await registry.search(query, context, 5);
  headResults.push({ query, expected, selected: candidates[0]?.ref ?? null });
}
const catalog = await registry.catalog(context);
const lexical = await searchMemoryIndex(shards, digests, { query: "search source files" });
const structural = await searchMemoryIndex(shards, digests, { filters: { ref: "pi.grep" } });
const combined = await searchMemoryIndex(shards, digests, {
  query: "rarelexeme_target",
  filters: { ref: "pi.grep" },
});
const negative = await searchMemoryIndex(shards, digests, { filters: { ref: "pi.write" } });

const expectedCombinedAddress = shards[0].entries.find(
  (item) => item.ref === "pi.grep" && item.text.includes("rarelexeme_target"),
).operationAddress;
const combinedAddresses = hotAddresses(combined);

const durations = [];
for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
  const started = performance.now();
  await searchMemoryIndex(shards, digests, { filters: { ref: "pi.grep" } });
  durations.push(performance.now() - started);
}
durations.sort((left, right) => left - right);
const percentile = (fraction) => durations[Math.min(durations.length - 1, Math.floor(durations.length * fraction))];

const report = {
  corpus: {
    hotSessions: HOT_SESSIONS,
    coldSessions: COLD_SESSIONS,
    entriesPerSession: ENTRIES_PER_SESSION,
    sourceBytes,
    coldDigestBytes: digestBytes,
    coldDigestSourceRatio: digestBytes / coldSourceBytes,
    structuralPostingBytes: digestBytes - legacyDigestBytes,
    structuralPostingSourceRatio: (digestBytes - legacyDigestBytes) / coldSourceBytes,
  },
  catalog: {
    queries: headResults,
    recallAt1: headResults.filter((result) => result.selected === result.expected).length / headResults.length,
    descriptorHash: catalog.root.descriptorHash,
    complete: catalog.complete,
  },
  quality: {
    lexicalDescriptionMatches: lexical.matchedCount,
    structuralHotAddressRecall: recall(hotAddresses(structural), expectedHotGrep),
    structuralColdSessionRecall: recall(coldSessions(structural), expectedColdGrepSessions),
    combinedTargetFound: combinedAddresses.has(expectedCombinedAddress),
    combinedMode: combined.matchMode,
    combinedColdRequiresHydration: combined.queryCoverage.reasons.includes(
      "cold_structural_filter_requires_hydration",
    ),
    negativeMatches: negative.matchedCount,
  },
  latencyMs: {
    iterations: ITERATIONS,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
  },
};

const failures = [];
if (report.catalog.recallAt1 !== 1) failures.push("capability head Recall@1");
if (report.quality.lexicalDescriptionMatches !== 0) failures.push("catalog prose leaked into lexical evidence");
if (report.quality.structuralHotAddressRecall !== 1) failures.push("hot structural recall");
if (report.quality.structuralColdSessionRecall !== 1) failures.push("cold structural recall");
if (!report.quality.combinedTargetFound) failures.push("combined exact target");
if (report.quality.combinedMode !== "combined") failures.push("combined mode provenance");
if (!report.quality.combinedColdRequiresHydration) failures.push("cold co-location coverage");
if (report.quality.negativeMatches !== 0) failures.push("negative structural control");
if (report.corpus.structuralPostingSourceRatio > 0.15) failures.push("structural posting overhead exceeds 15% of source");

console.log(JSON.stringify({ ...report, passed: failures.length === 0, failures }, null, 2));
if (failures.length > 0) process.exitCode = 1;
