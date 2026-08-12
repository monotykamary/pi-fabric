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

export interface FabricAgentToolPreviewNode {
  id: string;
  name: string;
  status?: string;
  runner?: "pi" | "claude" | "veda";
  owner?: "agent" | "actor";
  /** Most recent tool the agent was observed running, when known. */
  currentTool?: string;
  text?: string;
  tools: FabricTranscriptEntry[];
  /** Descendant previews, one branch per spawned nested agent run. */
  agents?: FabricAgentToolPreviewNode[];
  /** True when descendant previews were cut by the preview tree budget. */
  agentsTruncated?: boolean;
}

export interface FabricAgentToolPreview extends FabricAgentToolPreviewNode {
  kind: "fabric-agent-tools";
}

export const projectAgentTranscript = (
  events: Array<Record<string, unknown>>,
  olderAvailable = false,
): FabricAgentTranscript => {
  const accumulator = new TranscriptAccumulator();
  accumulator.append(events);
  return accumulator.snapshot(olderAvailable);
};

const PREVIEW_TREE_GUARD_MAX_DEPTH = 8;

const isFabricAgentToolPreviewNode = (
  value: unknown,
  depth: number,
): value is FabricAgentToolPreviewNode => {
  const record = recordOf(value);
  if (
    !record ||
    typeof record.id !== "string" ||
    typeof record.name !== "string" ||
    (record.text !== undefined && typeof record.text !== "string") ||
    (record.currentTool !== undefined && typeof record.currentTool !== "string") ||
    !Array.isArray(record.tools)
  ) {
    return false;
  }
  if (record.agents === undefined) return true;
  if (depth >= PREVIEW_TREE_GUARD_MAX_DEPTH || !Array.isArray(record.agents)) return false;
  return record.agents.every((child) => isFabricAgentToolPreviewNode(child, depth + 1));
};

export const isFabricAgentToolPreview = (value: unknown): value is FabricAgentToolPreview =>
  recordOf(value)?.kind === "fabric-agent-tools" && isFabricAgentToolPreviewNode(value, 0);

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
