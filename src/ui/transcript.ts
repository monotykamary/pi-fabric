import { TranscriptAccumulator } from "./transcript-parser.js";
import { AgentTranscriptReader } from "./transcript-reader.js";
import { recordOf } from "./transcript-sanitization.js";

type FabricTranscriptEntryStatus = "running" | "completed" | "failed";

export interface FabricTranscriptEntry {
  id: string;
  kind: "user" | "assistant" | "tool" | "error" | "status";
  label: string;
  text?: string;
  status?: FabricTranscriptEntryStatus;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  parentId?: string;
  depth?: number;
}

export interface FabricAgentTranscript {
  entries: FabricTranscriptEntry[];
  /** Kept for compatibility; true means older pages are available. */
  truncated: boolean;
  hasMore?: boolean;
  hasNewer?: boolean;
  updatedAt?: number;
}

export interface FabricTranscriptSource {
  id: string;
  status: string;
  logFile?: string;
}

export interface FabricNestedToolPreview {
  kind: "fabric-agent-tools";
  id: string;
  name: string;
  status: string;
  runner?: "pi" | "claude";
  owner: "agent" | "actor";
  text?: string;
  tools: FabricTranscriptEntry[];
}

export const projectAgentTranscript = (
  events: Array<Record<string, unknown>>,
  olderAvailable = false,
): FabricAgentTranscript => {
  const accumulator = new TranscriptAccumulator();
  accumulator.append(events);
  return accumulator.snapshot(olderAvailable);
};

export const isFabricNestedToolPreview = (value: unknown): value is FabricNestedToolPreview => {
  const record = recordOf(value);
  return (
    record?.kind === "fabric-agent-tools" &&
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    (record.text === undefined || typeof record.text === "string") &&
    Array.isArray(record.tools)
  );
};

export const recentTranscriptTools = (
  transcript: FabricAgentTranscript,
  limit = 2,
): FabricTranscriptEntry[] => {
  const tools = transcript.entries.filter((entry) => entry.kind === "tool");
  const boundedLimit = Math.max(1, limit);
  const running = tools.filter((entry) => entry.status === "running");
  const completed = tools.filter((entry) => entry.status !== "running");
  const completedSlots = Math.max(0, boundedLimit - Math.min(running.length, boundedLimit));
  const retained = new Set([
    ...running.slice(-boundedLimit),
    ...completed.slice(-completedSlots),
  ]);
  return tools
    .filter((entry) => retained.has(entry))
    .slice(-boundedLimit)
    .map((entry) => ({ ...entry }));
};

export { AgentTranscriptReader };
