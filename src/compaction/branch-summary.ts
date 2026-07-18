import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { FabricTraceJsonValue } from "../audit/trace.js";
import { canonicalizeText, clipUtf8, sampleAddressed } from "./bounds.js";
import {
  FABRIC_BRANCH_SUMMARY_KIND,
  FABRIC_BRANCH_SUMMARY_MAX_BYTES,
  FABRIC_BRANCH_SUMMARY_MAX_FACTS,
  FABRIC_BRANCH_SUMMARY_VERSION,
  type FabricBranchFactV1,
  type FabricBranchOperationFactV1,
  type FabricBranchSummaryDetailsV1,
} from "./branch-details.js";
import { NO_BUILTIN_ENRICHERS, runEnrichers, type CompactionEnricher } from "./enrichers.js";
import { normalizeEntries, type CompactionEvent, type ToolCallEvent } from "./normalize.js";
import { projectWithMetadata, type Sections } from "./projections.js";
import { renderSummary } from "./render.js";

const SECTION_HEADERS: { key: keyof Sections; header: string }[] = [
  { key: "goal", header: "[Session Goal]" },
  { key: "files", header: "[Files And Changes]" },
  { key: "commits", header: "[Commits]" },
  { key: "activity", header: "[Fabric Activity]" },
  { key: "outstanding", header: "[Outstanding Context]" },
  { key: "earlierTurns", header: "[Earlier Turns]" },
  { key: "status", header: "[Current Status]" },
];

const asJsonObject = (value: Record<string, unknown>): Record<string, FabricTraceJsonValue> | undefined => {
  try {
    const cloned = JSON.parse(JSON.stringify(value)) as unknown;
    return cloned && typeof cloned === "object" && !Array.isArray(cloned)
      ? cloned as Record<string, FabricTraceJsonValue>
      : undefined;
  } catch {
    return undefined;
  }
};

const directOperationFact = (
  call: ToolCallEvent,
  outcome: "succeeded" | "failed",
  error?: string,
): FabricBranchOperationFactV1 | undefined => {
  if (call.name === "fabric_exec") return undefined;
  const args = asJsonObject(call.args);
  if (!args) return undefined;
  const subordinal = `call:${call.toolCallId}`;
  return {
    kind: "operation",
    entryId: call.entryId,
    subordinal,
    address: `${call.entryId}/${subordinal}`,
    ref: call.name,
    action: call.name,
    tool: call.name,
    args,
    outcome,
    ...(error ? { error: clipUtf8(error, 8 * 1024) } : {}),
  };
};

const factsFromEvents = (events: CompactionEvent[]): FabricBranchFactV1[] => {
  const facts: FabricBranchFactV1[] = [];
  const calls = new Map<string, ToolCallEvent>();
  for (const event of events) {
    if (event.kind === "toolCall") calls.set(event.toolCallId, event);
  }
  for (const event of events) {
    if (event.kind === "user") {
      facts.push({
        kind: "user",
        entryId: event.entryId,
        subordinal: "user",
        address: `${event.entryId}/user`,
        text: clipUtf8(event.text, 2 * 1024),
      });
    } else if (event.kind === "fabricPhase") {
      facts.push({
        kind: "phase",
        entryId: event.entryId,
        subordinal: event.subordinal,
        address: event.address,
        phase: event.phase,
      });
    } else if (event.kind === "fabricOperation") {
      facts.push({
        kind: "operation",
        entryId: event.entryId,
        subordinal: event.subordinal,
        address: event.address,
        ref: event.ref,
        ...(event.provider ? { provider: event.provider } : {}),
        ...(event.action ? { action: event.action } : {}),
        tool: event.tool,
        args: event.args,
        outcome: event.outcome,
        ...(event.error !== undefined ? { error: event.error } : {}),
        ...(event.result !== undefined ? { result: event.result } : {}),
      });
    } else if (event.kind === "toolResult" && event.toolName !== "bash") {
      const call = event.toolCallId ? calls.get(event.toolCallId) : undefined;
      if (!call) continue;
      const fact = directOperationFact(call, event.isError ? "failed" : "succeeded", event.isError ? event.text : undefined);
      if (fact) facts.push(fact);
    } else if (event.kind === "bash") {
      const call = event.toolCallId ? calls.get(event.toolCallId) : undefined;
      if (call) {
        const fact = directOperationFact(call, event.isError ? "failed" : "succeeded", event.isError ? event.output : undefined);
        if (fact) facts.push(fact);
      } else {
        const subordinal = "bash";
        facts.push({
          kind: "operation",
          entryId: event.entryId,
          subordinal,
          address: `${event.entryId}/${subordinal}`,
          ref: "bash",
          action: "bash",
          tool: "bash",
          args: { command: event.command },
          outcome: event.isError ? "failed" : "succeeded",
          ...(event.isError && event.output ? { error: clipUtf8(event.output, 8 * 1024) } : {}),
        });
      }
    }
  }
  return facts;
};

const serializedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

const boundedDetails = (
  sourceEntries: SessionEntry[],
  facts: FabricBranchFactV1[],
  sections: string[],
  request: ReturnType<typeof canonicalizeText>,
): FabricBranchSummaryDetailsV1 => {
  const sampled = sampleAddressed(facts, FABRIC_BRANCH_SUMMARY_MAX_FACTS);
  const details: FabricBranchSummaryDetailsV1 = {
    kind: FABRIC_BRANCH_SUMMARY_KIND,
    version: FABRIC_BRANCH_SUMMARY_VERSION,
    source: {
      firstEntryId: sourceEntries[0]?.id ?? "",
      lastEntryId: sourceEntries.at(-1)?.id ?? "",
      entryCount: sourceEntries.length,
    },
    facts: sampled.values,
    omittedFacts: sampled.omitted,
    sections,
    request: {
      text: request.text,
      sourceBytes: request.sourceBytes,
      truncated: request.truncated,
    },
  };
  for (let index = details.facts.length - 1; serializedBytes(details) > FABRIC_BRANCH_SUMMARY_MAX_BYTES && index >= 0; index--) {
    const fact = details.facts[index]!;
    if (fact.kind === "operation" && fact.result !== undefined) delete fact.result;
  }
  while (serializedBytes(details) > FABRIC_BRANCH_SUMMARY_MAX_BYTES && details.facts.length > 0) {
    const middle = Math.floor(details.facts.length / 2);
    details.facts.splice(middle, 1);
    details.omittedFacts += 1;
  }
  return details;
};

export interface FabricBranchSummaryCompilation {
  summary: string;
  details: FabricBranchSummaryDetailsV1;
}

export const compileFabricBranchSummary = (
  entriesToSummarize: SessionEntry[],
  customInstructions?: string,
  enrichers: readonly CompactionEnricher[] = NO_BUILTIN_ENRICHERS,
): FabricBranchSummaryCompilation | undefined => {
  const events = normalizeEntries(entriesToSummarize);
  if (events.length === 0) return undefined;
  const projected = projectWithMetadata(events);
  runEnrichers(enrichers, events, projected.sections);
  const request = canonicalizeText(customInstructions ?? "");
  const sections = SECTION_HEADERS
    .filter(({ key }) => projected.sections[key].length > 0)
    .map(({ header }) => header);
  if (request.text) sections.splice(1, 0, "[Compaction Request]");
  const summary = renderSummary(projected.sections, {
    firstEntryId: entriesToSummarize[0]?.id ?? "",
    lastEntryId: entriesToSummarize.at(-1)?.id ?? "",
    lastTimestamp: entriesToSummarize.at(-1)?.timestamp ?? "",
    ...(request.text ? { requestLines: [request.text] } : {}),
    summaryKind: "branch",
  });
  return {
    summary,
    details: boundedDetails(entriesToSummarize, factsFromEvents(events), sections, request),
  };
};
