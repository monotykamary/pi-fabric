import type { AgentManager } from "../agents/manager.js";
import type { AgentRunRecord, AgentRunResult } from "../agents/types.js";
import type { FabricActorMessage } from "../actors/types.js";
import type { FabricInvocationContext } from "../protocol.js";
import {
  type AgentTranscriptReader,
  recentTranscriptTools,
  type FabricAgentToolPreview,
  type FabricAgentToolPreviewNode,
  type FabricTranscriptEntry,
} from "../ui/transcript.js";

type AgentProgressSink = Pick<FabricInvocationContext, "attachPreview" | "update" | "activity">;
const AGENT_PROGRESS_INTERVAL_MS = 1_000;
const AGENT_PREVIEW_TEXT_CODE_POINTS = 2_000;
const AGENT_PREVIEW_TOOL_LIMIT = 8;
const AGENT_PREVIEW_TREE_MAX_DEPTH = 4;
const AGENT_PREVIEW_TREE_MAX_NODES = 24;

const tailCodePoints = (value: string, limit: number): string => {
  if (value.length <= limit) return value;
  return Array.from(value.slice(-limit * 2)).slice(-limit).join("");
};

type AgentProgressStatus = ReturnType<AgentManager["status"]>;

export interface AgentToolPreviewTreeOptions {
  tools: (record: AgentRunRecord) => FabricTranscriptEntry[];
  maxDepth?: number;
  maxNodes?: number;
}

// Map an agent run tree (AgentRunRecord.nestedAgents) onto bounded preview
// nodes. Depth and total-node budgets keep recursive runs cheap to build and
// cheap to diff against the previous revision every progress tick.
export const collectAgentToolPreviewNodes = (
  records: readonly AgentRunRecord[],
  options: AgentToolPreviewTreeOptions,
  depth = 0,
  budget = { remaining: options.maxNodes ?? AGENT_PREVIEW_TREE_MAX_NODES },
): FabricAgentToolPreviewNode[] => {
  const maxDepth = options.maxDepth ?? AGENT_PREVIEW_TREE_MAX_DEPTH;
  const nodes: FabricAgentToolPreviewNode[] = [];
  for (const record of records) {
    if (budget.remaining <= 0) break;
    budget.remaining -= 1;
    const descendants = Array.isArray(record.nestedAgents) ? record.nestedAgents : [];
    const agents =
      depth + 1 < maxDepth && descendants.length > 0 && budget.remaining > 0
        ? collectAgentToolPreviewNodes(descendants, options, depth + 1, budget)
        : [];
    nodes.push({
      id: record.id,
      name: record.actorName ?? record.name,
      status: record.status,
      ...(record.runner === "pi" || record.runner === "claude" || record.runner === "veda"
        ? { runner: record.runner }
        : {}),
      owner: record.actorId ? "actor" : "agent",
      ...(record.currentTool ? { currentTool: record.currentTool } : {}),
      ...(record.text
        ? { text: tailCodePoints(record.text, AGENT_PREVIEW_TEXT_CODE_POINTS) }
        : {}),
      tools: options.tools(record),
      ...(agents.length > 0 ? { agents } : {}),
      ...(descendants.length > agents.length ? { agentsTruncated: true } : {}),
    });
  }
  return nodes;
};

const attachAgentToolPreview = (
  status: AgentProgressStatus,
  transcripts: Pick<AgentTranscriptReader, "read">,
  context: AgentProgressSink,
  enabled: () => boolean,
  previousRevision?: string,
): string => {
  if (!context.attachPreview) return agentProgressRevision(status);
  const previewTools = (source: {
    id: string;
    status: string;
    logFile?: string | undefined;
  }): FabricTranscriptEntry[] => {
    if (!enabled() || !source.logFile) return [];
    try {
      return recentTranscriptTools(
        transcripts.read({ id: source.id, status: source.status, logFile: source.logFile }),
        AGENT_PREVIEW_TOOL_LIMIT,
      );
    } catch {
      // Descendant runs can clean up mid-read; keep the rest of the tree.
      return [];
    }
  };
  try {
    const nestedRecords =
      "nestedAgents" in status && Array.isArray(status.nestedAgents) ? status.nestedAgents : [];
    const descendants = collectAgentToolPreviewNodes(nestedRecords, { tools: previewTools });
    const preview: FabricAgentToolPreview = {
      kind: "fabric-agent-tools",
      id: status.id,
      name: status.actorName ?? status.name,
      status: status.status,
      runner: status.runner,
      owner: status.actorId ? "actor" : "agent",
      ...("text" in status && status.text
        ? { text: tailCodePoints(status.text, AGENT_PREVIEW_TEXT_CODE_POINTS) }
        : {}),
      tools: previewTools(status),
      ...(descendants.length > 0 ? { agents: descendants } : {}),
      ...(nestedRecords.length > descendants.length ? { agentsTruncated: true } : {}),
    };
    // The preview is bounded before this point. Comparing its compact snapshot
    // keeps the one-second filesystem poll cheap while still noticing transcript
    // deltas that do not update the worker's coarse status record.
    const revision = JSON.stringify(preview);
    if (revision !== previousRevision) context.attachPreview(preview);
    return revision;
  } catch {
    // The worker may settle and clean up while its final preview is being read.
    return previousRevision ?? agentProgressRevision(status);
  }
};

const waitForResultWithProgress = <T>(
  result: Promise<T>,
  onProgress: () => void,
): Promise<T> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      clearInterval(progressTimer);
      complete();
    };
    const progressTimer = setInterval(() => {
      if (settled) return;
      try {
        onProgress();
      } catch (error) {
        finish(() => reject(error));
      }
    }, AGENT_PROGRESS_INTERVAL_MS);
    progressTimer.unref?.();
    result.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });

const actorWorker = (
  manager: Pick<AgentManager, "list">,
  actorId: string,
  includeTerminal: boolean,
): ReturnType<AgentManager["list"]>[number] | undefined => {
  const candidates = manager.list().filter((candidate) => candidate.actorId === actorId);
  const active = candidates.find((candidate) => candidate.status === "running");
  if (active || !includeTerminal) return active;
  // AgentManager.list() preserves run insertion order; the last actor run
  // is therefore the terminal snapshot for the ask that just settled.
  return candidates.at(-1);
};

const agentProgressRevision = (status: AgentProgressStatus): string =>
  [
    status.status,
    "updatedAt" in status ? status.updatedAt : 0,
    "currentTool" in status ? status.currentTool : "",
    "toolCalls" in status ? status.toolCalls : 0,
    "turns" in status ? status.turns : 0,
  ].join(":");

export const waitWithProgress = async (
  manager: Pick<AgentManager, "wait" | "status">,
  transcripts: Pick<AgentTranscriptReader, "read">,
  id: string,
  context: AgentProgressSink,
  agentToolPreviewEnabled: () => boolean,
): Promise<AgentRunResult> => {
  const result = manager.wait(id);
  let lastPreviewRevision: string | undefined;
  try {
    const settled = await waitForResultWithProgress(result, () => {
      const status = manager.status(id);
      const revision = attachAgentToolPreview(
        status,
        transcripts,
        context,
        agentToolPreviewEnabled,
        lastPreviewRevision,
      );
      if (revision === lastPreviewRevision) return;
      lastPreviewRevision = revision;
      const currentTool =
        "currentTool" in status && status.currentTool ? ` · ${status.currentTool}` : "";
      const displayName = status.actorName ?? status.name;
      context.update(`Agent ${displayName}: ${status.status}${currentTool}`);
      if ("usage" in status) {
        context.activity?.({
          type: "metrics",
          tokens: status.usage.input + status.usage.output,
          toolCalls: status.toolCalls,
          cost: status.usage.cost,
        });
      }
    });
    context.activity?.({
      type: "metrics",
      tokens: settled.usage.input + settled.usage.output,
      toolCalls: settled.toolCalls,
      cost: settled.usage.cost,
    });
    return settled;
  } finally {
    try {
      const status = manager.status(id);
      attachAgentToolPreview(status, transcripts, context, agentToolPreviewEnabled);
      const displayName = status.actorName ?? status.name;
      context.update(`Agent ${displayName}: ${status.status}`);
    } catch {
      // The run may have been cleaned up during cancellation.
    }
  }
};

export const waitWithActorProgress = async (
  manager: Pick<AgentManager, "list">,
  transcripts: Pick<AgentTranscriptReader, "read">,
  actorId: string,
  actorName: string,
  result: Promise<FabricActorMessage>,
  context: AgentProgressSink,
  agentToolPreviewEnabled: () => boolean,
): Promise<FabricActorMessage> => {
  let lastPreviewRevision: string | undefined;
  try {
    return await waitForResultWithProgress(result, () => {
      const worker = actorWorker(manager, actorId, false);
      const revision = worker
        ? attachAgentToolPreview(
            worker,
            transcripts,
            context,
            agentToolPreviewEnabled,
            lastPreviewRevision,
          )
        : "queued";
      if (revision === lastPreviewRevision) return;
      lastPreviewRevision = revision;
      const currentTool =
        worker && "currentTool" in worker && worker.currentTool ? ` · ${worker.currentTool}` : "";
      context.update(
        worker
          ? `Actor ${actorName}: ${worker.status}${currentTool}`
          : `Actor ${actorName}: queued`,
      );
    });
  } finally {
    const worker = actorWorker(manager, actorId, true);
    if (worker) attachAgentToolPreview(worker, transcripts, context, agentToolPreviewEnabled);
  }
};



