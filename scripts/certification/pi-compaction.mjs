import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as Pi from "@earendil-works/pi-coding-agent";
import { registerCompactionHook } from "../../dist/compaction/hook.js";

const piMainFile = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piPackageRoot = path.dirname(path.dirname(piMainFile));
const piPackage = JSON.parse(fs.readFileSync(path.join(piPackageRoot, "package.json"), "utf8"));
const internalCompactionUrl = pathToFileURL(
  path.join(piPackageRoot, "dist", "core", "compaction", "compaction.js"),
).href;
const internalCompaction = await import(internalCompactionUrl);

if (piPackage.version !== "0.80.6") {
  throw new Error(`Certification requires Pi 0.80.6, resolved ${String(piPackage.version)}`);
}
if (typeof internalCompaction.prepareCompaction !== "function"
  || typeof internalCompaction.estimateContextTokens !== "function") {
  throw new Error("Installed Pi compaction internals do not expose the expected 0.80.6 functions");
}

export const PI_COMPACTION_API = Object.freeze({
  version: piPackage.version,
  prepareCompactionPubliclyExported: typeof Pi.prepareCompaction === "function",
  prepareCompactionAccess: "resolved-installed-internal-module",
  buildContextEntriesPubliclyExported: typeof Pi.buildContextEntries === "function",
  buildSessionContextPubliclyExported: typeof Pi.buildSessionContext === "function",
  shouldCompactPubliclyExported: typeof Pi.shouldCompact === "function",
});

export const SMALL_COMPACTION_SETTINGS = Object.freeze({
  enabled: true,
  reserveTokens: 63,
  keepRecentTokens: 1,
});

export const SMALL_CONTEXT_WINDOW = 64;

export const getPiContextTokens = (manager) =>
  internalCompaction.estimateContextTokens(manager.buildSessionContext().messages).tokens;

export const prepareEligibleCompaction = (
  manager,
  settings = SMALL_COMPACTION_SETTINGS,
  contextWindow = SMALL_CONTEXT_WINDOW,
) => {
  const branchEntries = manager.getBranch();
  const builtEntries = manager.buildContextEntries();
  const publicBuiltEntries = Pi.buildContextEntries(manager.getEntries(), manager.getLeafId());
  const contextTokens = getPiContextTokens(manager);
  const eligible = Pi.shouldCompact(contextTokens, contextWindow, settings);
  const preparation = eligible
    ? internalCompaction.prepareCompaction(branchEntries, settings)
    : undefined;
  return {
    branchEntries,
    builtEntries,
    publicBuiltEntries,
    contextTokens,
    contextWindow,
    eligible,
    preparation,
  };
};

let fabricHandler;
const fakePi = {
  on(name, handler) {
    if (name === "session_before_compact") fabricHandler = handler;
  },
};
registerCompactionHook(fakePi, { getEngine: () => "fabric" });
if (typeof fabricHandler !== "function") throw new Error("Fabric compaction hook was not registered");

export const invokeRegisteredFabricCompactor = ({ preparation, branchEntries, customInstructions }) => {
  let previousSummaryReads = 0;
  const instrumentedPreparation = new Proxy(preparation, {
    get(target, property, receiver) {
      if (property === "previousSummary") previousSummaryReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const event = {
    type: "session_before_compact",
    preparation: instrumentedPreparation,
    branchEntries,
    ...(customInstructions === undefined ? {} : { customInstructions }),
    reason: "threshold",
    willRetry: false,
    signal: new AbortController().signal,
  };
  const result = fabricHandler(event, undefined);
  return {
    event,
    result,
    instrumentation: {
      previousSummaryReads,
      priorSummaryFedAsInput: previousSummaryReads > 0,
    },
  };
};

export const expectedContextEntriesAfterCompaction = (branchEntries, compactionEntry) => {
  if (!compactionEntry.firstKeptEntryId) return [compactionEntry];
  const firstKeptIndex = branchEntries.findIndex((entry) => entry.id === compactionEntry.firstKeptEntryId);
  if (firstKeptIndex < 0) return [compactionEntry];
  return [compactionEntry, ...branchEntries.slice(firstKeptIndex)];
};

export const contextEntriesMatch = (actual, expected) =>
  actual.length === expected.length
  && actual.every((entry, index) => entry.id === expected[index]?.id && entry.type === expected[index]?.type);
