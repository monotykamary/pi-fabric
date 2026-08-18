import { ActorManager } from "../actors/manager.js";
import { GlobalActorRegistry } from "../actors/global-registry.js";
import { isFabricActorHostEvent } from "../actors/types.js";
import type {
  FabricActorDelivery,
  FabricActorHostEvent,
  FabricActorInfo,
  FabricActorMessage,
  FabricActorRequest,
  FabricActorRunBinding,
} from "../actors/types.js";
import type {
  FabricAgentMessageResult,
  FabricMainAgentTarget,
} from "../main-agent.js";
import type { MeshIdentity } from "../mesh/store.js";
import { LifecycleBroker } from "../lifecycle/broker.js";
import {
  isFabricLifecycleEventType,
  lifecycleSourceIdentity,
  type FabricLifecycleEvent,
  type FabricLifecycleSubscription,
} from "../lifecycle/types.js";
import {
  FabricControlPlane,
  type FabricControlCommand,
  type FabricControlAcceptance,
} from "../topology/control-plane.js";
import type {
  FabricParticipantScope,
  FabricParticipantSource,
} from "../topology/types.js";
import type {
  FabricActionDescriptor,
  FabricCapabilityRequirement,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";
import {
  effectiveAgentTimeoutMs,
  AgentManager,
  validateAgentCwdRequest,
} from "../agents/manager.js";
import { checkedHandoffCompaction } from "../agents/handoff.js";
import type {
  AgentHandleInfo,
  AgentRunRecord,
  AgentRunRequest,
  AgentRunResult,
  AgentSessionSeed,
} from "../agents/types.js";
import type { ThinkingTransferInput } from "../agents/thinking-transfer.js";
import { AGENTS_ACTION_DESCRIPTORS } from "./agents-actions.js";
import { actionArgNormalizer } from "./arg-normalization.js";
import { isFabricThinking } from "../thinking.js";
import { ResidencyClient } from "../residency/client.js";
import {
  AgentTranscriptReader,
  recentTranscriptTools,
  type FabricAgentToolPreview,
  type FabricAgentToolPreviewNode,
  type FabricTranscriptEntry,
} from "../ui/transcript.js";

const REMOTE_ASK_ACK_GRACE_MS = 30_000;
const MAX_ACTIVITY_CWD_CHARS = 240;

const displaySafeCwd = (cwd: string): string => {
  const safe = cwd.replace(/[\u0000-\u001f\u007f]/g, (character) =>
    `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`,
  );
  if (safe.length <= MAX_ACTIVITY_CWD_CHARS) return safe;
  return `…${safe.slice(-(MAX_ACTIVITY_CWD_CHARS - 1))}`;
};

const agentStartedMessage = (handle: AgentHandleInfo): string =>
  `Agent ${handle.name} started via ${handle.runner}/${handle.transport}${handle.attachCommand ? ` · ${handle.attachCommand}` : ""} · cwd ${displaySafeCwd(handle.cwd)}`;

// Resolve source and executor reasoning channels for the trajectory handoff
// boundary. The executor model must be registered to transfer at all; an
// unresolvable source model simply yields no family comparison, so the
// transfer falls back to the target-driven policy.
const resolveThinkingTransfer = (
  extensionContext: FabricInvocationContext["extensionContext"],
  targetKey: string,
  sourceModel?: { provider: string; modelId: string },
): ThinkingTransferInput | undefined => {
  const separator = targetKey.indexOf("/");
  if (separator <= 0 || separator === targetKey.length - 1) return undefined;
  // Invocation contexts don't always thread the extension host (tests, nested
  // runners); without a registry no family comparison is possible.
  const registry = extensionContext?.modelRegistry;
  if (!registry) return undefined;
  const target = registry.find(targetKey.slice(0, separator), targetKey.slice(separator + 1));
  if (!target) return undefined;
  const source = sourceModel
    ? {
        provider: sourceModel.provider,
        modelId: sourceModel.modelId,
        api: registry.find(sourceModel.provider, sourceModel.modelId)?.api,
      }
    : undefined;
  return {
    ...(source ? { source } : {}),
    target: {
      provider: target.provider,
      modelId: target.id,
      api: target.api,
      reasoning: target.reasoning,
      ...((target.compat as { requiresThinkingAsText?: boolean } | undefined)
        ?.requiresThinkingAsText !== undefined
        ? {
            requiresThinkingAsText: (target.compat as { requiresThinkingAsText?: boolean })
              .requiresThinkingAsText,
          }
        : {}),
    },
  };
};

const AGENT_PROGRESS_INTERVAL_MS = 1_000;
const AGENT_PREVIEW_TEXT_CODE_POINTS = 2_000;
const AGENT_PREVIEW_TOOL_LIMIT = 8;
const AGENT_PREVIEW_TREE_MAX_DEPTH = 4;
const AGENT_PREVIEW_TREE_MAX_NODES = 24;

const tailCodePoints = (value: string, limit: number): string => {
  if (value.length <= limit) return value;
  return Array.from(value.slice(-limit * 2)).slice(-limit).join("");
};

const stringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;

const actorRunBinding = (args: Record<string, unknown>): FabricActorRunBinding => ({
  ...(typeof args.model === "string" && args.model.trim()
    ? { model: args.model.trim() }
    : {}),
  ...(isFabricThinking(args.thinking) ? { thinking: args.thinking } : {}),
});

const longerTimeoutOverride = (
  value: unknown,
  manager: AgentManager,
): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const effective = effectiveAgentTimeoutMs(manager.config.timeoutMs, value);
  return effective > manager.config.timeoutMs ? effective : undefined;
};

const runRequest = (
  args: Record<string, unknown>,
  context: FabricInvocationContext,
  manager: AgentManager,
  options: { allowCwd?: boolean } = {},
): AgentRunRequest => {
  const transport =
    args.transport === "auto" ||
    args.transport === "process" ||
    args.transport === "tmux" ||
    args.transport === "screen" ||
    args.transport === "localterm" ||
    args.transport === "herdr"
      ? args.transport
      : undefined;
  const thinking = isFabricThinking(args.thinking) ? args.thinking : undefined;
  const tools = stringArray(args.tools);
  const timeoutMs = longerTimeoutOverride(args.timeoutMs, manager);
  const runner =
    args.runner === "pi" || args.runner === "claude" || args.runner === "veda"
      ? args.runner
      : manager.config.runner;
  const inheritedModel =
    runner === "pi" && !manager.config.model && context.extensionContext.model
      ? `${context.extensionContext.model.provider}/${context.extensionContext.model.id}`
      : undefined;
  return {
    task: String(args.task),
    runner,
    ...(typeof args.name === "string" ? { name: args.name } : {}),
    ...(transport ? { transport } : {}),
    ...(typeof args.model === "string"
      ? { model: args.model }
      : inheritedModel
        ? { model: inheritedModel }
        : {}),
    ...(typeof args.persona === "string" && args.persona.trim()
      ? { persona: args.persona.trim() }
      : {}),
    ...(thinking ? { thinking } : {}),
    ...(tools ? { tools } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(typeof args.extensions === "boolean" ? { extensions: args.extensions } : {}),
    ...(typeof args.recursive === "boolean" ? { recursive: args.recursive } : {}),
    ...(options.allowCwd !== false && typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
    ...(typeof args.worktree === "boolean" ? { worktree: args.worktree } : {}),
    ...(args.residency === "session" || args.residency === "durable"
      ? { residency: args.residency }
      : {}),
    ...(typeof args.schema === "object" && args.schema !== null && !Array.isArray(args.schema)
      ? { schema: args.schema as Record<string, unknown> }
      : {}),
  };
};

const handoffTask = (args: Record<string, unknown>): string => {
  const task = typeof args.task === "string" ? args.task.trim() : "";
  const lines = [
    "Continue and complete the current user task from the inherited conversation trajectory and current workspace.",
    "The caller has handed implementation to you and is blocked awaiting this run. Do the remaining work; do not merely advise the caller or restate the plan.",
    "Treat the inherited conversation, completed outer Fabric result, and current workspace as grounded context. Inspect again only where the workspace or a failed check makes it necessary.",
    "Keep the change scoped, run the relevant full test module or equivalent verification, and report the implementation plus checks honestly.",
  ];
  if (task) lines.push("Additional continuation task:", task);
  return lines.join("\n\n");
};

const compactHandoffResult = (
  result: AgentRunResult,
): Record<string, unknown> => ({
  handedOff: true,
  completed: result.status === "completed",
  status: result.status,
  agent: {
    id: result.id,
    name: result.name,
    runner: result.runner,
    transport: result.transport,
    ...(result.model ? { model: result.model } : {}),
    ...(result.thinking ? { thinking: result.thinking } : {}),
    turns: result.turns,
    toolCalls: result.toolCalls,
    usage: result.usage,
  },
  implementation: result.value ?? result.text,
  ...(result.error ? { error: result.error } : {}),
});

const actorRequest = (
  args: Record<string, unknown>,
  context: FabricInvocationContext,
  manager: AgentManager,
  inheritModel = true,
): FabricActorRequest => {
  const events = Array.isArray(args.events)
    ? args.events.filter(
        (event): event is FabricActorHostEvent => isFabricActorHostEvent(event),
      )
    : undefined;
  const topics = stringArray(args.topics);
  const tools = stringArray(args.tools);
  const requires = Array.isArray(args.requires)
    ? args.requires.reduce<Array<string | FabricCapabilityRequirement>>(
        (result, requirement) => {
          if (typeof requirement === "string") result.push(requirement);
          else if (
            typeof requirement === "object" &&
            requirement !== null &&
            !Array.isArray(requirement) &&
            typeof (requirement as { ref?: unknown }).ref === "string"
          ) {
            result.push({
              ref: (requirement as { ref: string }).ref,
              ...((requirement as { optional?: unknown }).optional === true
                ? { optional: true }
                : {}),
            });
          }
          return result;
        },
        [],
      )
    : undefined;
  const timeoutMs = longerTimeoutOverride(args.timeoutMs, manager);
  const validWhile = typeof args.validWhile === "object" && args.validWhile !== null &&
    !Array.isArray(args.validWhile) &&
    (args.validWhile as { version?: unknown }).version === 1 &&
    typeof (args.validWhile as { source?: unknown }).source === "string"
    ? { version: 1 as const, source: (args.validWhile as { source: string }).source }
    : undefined;
  const runner =
    args.runner === "pi" || args.runner === "claude" || args.runner === "veda"
      ? args.runner
      : manager.config.runner;
  if (runner === "veda") {
    throw new Error(
      'The Veda runner does not support persistent actors: Veda executes one headless prompt per invocation. Use a Pi or Claude actor, or agents.run({ runner: "veda" }).',
    );
  }
  const inheritedModel =
    inheritModel && runner === "pi" && !manager.config.model && context.extensionContext.model
      ? `${context.extensionContext.model.provider}/${context.extensionContext.model.id}`
      : undefined;
  return {
    name: String(args.name),
    instructions: String(args.instructions),
    runner,
    ...(events ? { events } : {}),
    ...(topics ? { topics } : {}),
    ...(args.delivery === "mailbox" ||
    args.delivery === "steer" ||
    args.delivery === "followUp" ||
    args.delivery === "nextTurn"
      ? { delivery: args.delivery }
      : {}),
    ...(args.responseMode === "text" || args.responseMode === "directive"
      ? { responseMode: args.responseMode }
      : {}),
    ...(typeof args.triggerTurn === "boolean" ? { triggerTurn: args.triggerTurn } : {}),
    ...(typeof args.coalesce === "boolean" ? { coalesce: args.coalesce } : {}),
    ...(args.residency === "session" || args.residency === "durable"
      ? { residency: args.residency }
      : {}),
    ...(typeof args.model === "string"
      ? { model: args.model }
      : inheritedModel
        ? { model: inheritedModel }
        : {}),
    ...(isFabricThinking(args.thinking) ? { thinking: args.thinking } : {}),
    ...(tools ? { tools } : {}),
    ...(args.transport === "auto" ||
    args.transport === "process" ||
    args.transport === "tmux" ||
    args.transport === "screen" ||
    args.transport === "localterm" ||
    args.transport === "herdr"
      ? { transport: args.transport }
      : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(typeof args.extensions === "boolean" ? { extensions: args.extensions } : {}),
    ...(requires ? { requires } : {}),
    ...(validWhile ? { validWhile } : {}),
  };
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
  transcripts: AgentTranscriptReader,
  context: FabricInvocationContext,
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
  manager: AgentManager,
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

const waitWithProgress = async (
  manager: AgentManager,
  transcripts: AgentTranscriptReader,
  id: string,
  context: FabricInvocationContext,
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

const waitWithActorProgress = async (
  manager: AgentManager,
  transcripts: AgentTranscriptReader,
  actorId: string,
  actorName: string,
  result: Promise<FabricActorMessage>,
  context: FabricInvocationContext,
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



// Argument repair derives from the action schemas plus the shared synonym
// lexicon; no agents-specific table remains.
export const normalizeAgentsArgs = actionArgNormalizer(() => AGENTS_ACTION_DESCRIPTORS);

export class AgentsProvider implements FabricProvider {
  readonly #transcripts = new AgentTranscriptReader();
  readonly name = "agents";
  readonly description =
    "The user-facing Main target, one-shot Pi or Claude Code agents, and persistent mailbox actors over process, tmux, screen, LocalTerm, or Herdr";

  constructor(
    readonly manager: AgentManager,
    readonly actorManager: ActorManager,
    readonly globalActors: GlobalActorRegistry,
    readonly mainAgent: FabricMainAgentTarget,
    readonly participants: FabricParticipantSource,
    readonly control: FabricControlPlane | undefined,
    readonly lifecycle: LifecycleBroker,
    readonly agentToolPreviewEnabled: () => boolean = () => true,
    readonly residency?: ResidencyClient,
    readonly ownsRuntime = true,
  ) {}

  async list(
    request: FabricProviderListRequest,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor[]> {
    const query = request.query?.toLowerCase();
    return query
      ? AGENTS_ACTION_DESCRIPTORS.filter((descriptor) =>
          `${descriptor.name} ${descriptor.description}`.toLowerCase().includes(query),
        )
      : AGENTS_ACTION_DESCRIPTORS;
  }

  async describe(
    actionName: string,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor | undefined> {
    return AGENTS_ACTION_DESCRIPTORS.find((descriptor) => descriptor.name === actionName);
  }

  prepareArguments(
    actionName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    return normalizeAgentsArgs(actionName, args);
  }

  async handoff(
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<Record<string, unknown>> {
    const model = typeof args.model === "string" ? args.model.trim() : "";
    if (!model) throw new Error("agents.handoff requires an explicit Pi target model");
    checkedHandoffCompaction(args.compact);
    if (!context.deferHandoff) {
      throw new Error(
        "agents.handoff must be scheduled from inside fabric_exec and completed at its outer result boundary",
      );
    }
    const handoffArgs = { ...args };
    delete handoffArgs.cwd;
    return context.deferHandoff({ ...handoffArgs, model });
  }

  async executeHandoff(
    args: Record<string, unknown>,
    context: FabricInvocationContext,
    sessionSeed: AgentSessionSeed,
  ): Promise<Record<string, unknown>> {
    const model = typeof args.model === "string" ? args.model.trim() : "";
    if (!model) throw new Error("agents.handoff requires an explicit Pi target model");
    const request = runRequest(
      {
        ...args,
        task: handoffTask(args),
        name:
          typeof args.name === "string" && args.name.trim()
            ? args.name
            : "Trajectory handoff",
        runner: "pi",
        model,
      },
      context,
      this.manager,
      { allowCwd: false },
    );
    request.runner = "pi";
    request.sessionSeed = sessionSeed;
    const handoffCompaction = checkedHandoffCompaction(args.compact);
    if (handoffCompaction) request.handoffCompact = handoffCompaction;
    request.thinkingTransfer = resolveThinkingTransfer(
      context.extensionContext,
      model,
      sessionSeed.sourceModel,
    );
    const handle = await this.manager.spawn(request, context.signal);
    context.activity?.({
      type: "entity",
      id: handle.id,
      kind: "agent",
      name: handle.name,
    });
    context.update(
      `Trajectory handed off to ${handle.name} (${model}); caller is waiting for implementation`,
    );
    const completed = await waitWithProgress(
      this.manager,
      this.#transcripts,
      handle.id,
      context,
      this.agentToolPreviewEnabled,
    );
    context.update(
      completed.status === "completed"
        ? `Handoff ${handle.name} completed implementation`
        : `Handoff ${handle.name} ended with ${completed.status}`,
    );
    return compactHandoffResult(completed);
  }

  async invoke(
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<unknown> {
    switch (actionName) {
      case "run": {
        const handle = await this.manager.spawn(
          runRequest(args, context, this.manager),
          context.signal,
        );
        this.participants.scheduleRefresh();
        context.activity?.({
          type: "entity",
          id: handle.id,
          kind: "agent",
          name: handle.name,
        });
        context.update(agentStartedMessage(handle));
        return waitWithProgress(
          this.manager,
          this.#transcripts,
          handle.id,
          context,
          this.agentToolPreviewEnabled,
        );
      }
      case "handoff":
        return this.handoff(args, context);
      case "spawn": {
        const request = runRequest(args, context, this.manager);
        validateAgentCwdRequest(request);
        const durableRequest = request.residency === "durable" && request.cwd !== undefined
          ? { ...request, cwd: this.manager.resolveCwd(request.cwd) }
          : request;
        const handle = durableRequest.residency === "durable"
          ? await this.#resident().spawnAgent(durableRequest, context.signal)
          : await this.manager.spawn(durableRequest, context.signal);
        if (request.residency !== "durable") this.manager.detachSignal(handle.id);
        this.participants.scheduleRefresh();
        context.activity?.({
          type: "entity",
          id: handle.id,
          kind: "agent",
          name: handle.name,
        });
        context.update(agentStartedMessage(handle));
        return handle;
      }
      case "wait": {
        const id = String(args.id);
        if (this.residency?.hasAgent(id)) {
          const status = this.residency.statusAgent(id);
          context.activity?.({ type: "entity", id, kind: "agent", name: status.name });
          context.update(`Waiting for durable agent ${status.name}`);
          return this.residency.waitAgent(id, context.signal);
        }
        const status = this.manager.status(id);
        context.activity?.({ type: "entity", id, kind: "agent", name: status.name });
        return waitWithProgress(
          this.manager,
          this.#transcripts,
          id,
          context,
          this.agentToolPreviewEnabled,
        );
      }
      case "status": {
        const id = String(args.id);
        if (this.mainAgent.matches(id)) {
          if (this.mainAgent.local) return this.mainAgent.info(context.extensionContext);
          const root = this.participants.get(this.mainAgent.id);
          if (!root) throw new Error(`Unknown Fabric Main participant: ${this.mainAgent.id}`);
          return root;
        }
        try {
          return this.manager.status(id);
        } catch (error) {
          if (!(error instanceof Error && /Unknown Fabric agent/.test(error.message))) throw error;
        }
        if (this.residency?.hasAgent(id)) return this.residency.statusAgent(id);
        const known = this.participants.get(id);
        if (known && !known.local) return known;
        try {
          return this.actorManager.status(id);
        } catch (error) {
          if (!(error instanceof Error && /Unknown Fabric actor/.test(error.message))) throw error;
        }
        const participant = this.participants.get(id);
        if (!participant) throw new Error(`Unknown Fabric participant: ${id}`);
        return participant;
      }
      case "list":
        return this.#listAgents(args.scope);
      case "members": {
        const kinds = Array.isArray(args.kinds)
          ? args.kinds.filter(
              (kind): kind is "root" | "agent" | "actor" =>
                kind === "root" || kind === "agent" || kind === "actor",
            )
          : undefined;
        return this.participants.list({
          scope: this.#participantScope(args.scope, "project"),
          ...(kinds ? { kinds } : {}),
          ...(args.includeStale === true ? { includeStale: true } : {}),
        });
      }
      case "self":
        return this.participants.self();
      case "main":
        return this.mainAgent.info(context.extensionContext);
      case "peers":
        return this.participants.peers();
      case "subscribe": {
        const events = Array.isArray(args.events)
          ? args.events.filter(isFabricLifecycleEventType)
          : [];
        if (typeof args.triggerTurn !== "boolean") {
          throw new Error("Lifecycle subscriptions require explicit triggerTurn: true or false");
        }
        const delivery = args.delivery === "steer" || args.delivery === "followUp"
          ? args.delivery
          : undefined;
        if (!delivery) throw new Error("Invalid lifecycle subscription delivery");
        const subscription = await this.lifecycle.subscribe({
          from: this.#participantAlias(String(args.from)),
          events,
          to: this.#participantAlias(typeof args.to === "string" ? args.to : "main"),
          delivery,
          triggerTurn: args.triggerTurn,
          ...(args.once === true ? { once: true } : {}),
        });
        context.update(
          `Subscribed ${subscription.to.slice(0, 8)} to ${subscription.events.join(", ")} from ${subscription.from.slice(0, 8)}`,
        );
        return subscription;
      }
      case "subscriptions":
        return this.lifecycle.list({
          ...(typeof args.from === "string"
            ? { from: this.#participantAlias(args.from) }
            : {}),
          ...(typeof args.to === "string"
            ? { to: this.#participantAlias(args.to) }
            : {}),
        });
      case "unsubscribe":
        return this.lifecycle.unsubscribe(String(args.id));
      case "models": {
        const runner =
          args.runner === "pi" || args.runner === "claude"
            ? args.runner
            : this.manager.config.runner;
        if (runner === "veda") {
          // Veda forwards any -m value to the configured backend; model
          // discovery would require parsing `veda models <backend>`. Return an
          // empty advisory list so callers can still pass model strings
          // directly to agents.run({ runner: "veda", model }).
          return [];
        }
        if (runner === "claude") {
          const models = await this.manager.claudeModels(args.refresh === true);
          return models.map((model) => ({
            runner: "claude",
            provider: "claude",
            id: model.value,
            name: model.displayName,
            key: `claude/${model.value}`,
            ...model,
          }));
        }
        try {
          const available = context.extensionContext.modelRegistry.getAvailable();
          return available.map((model) => ({
            runner: "pi",
            provider: String(model.provider),
            id: String(model.id),
            name: String(model.name ?? model.id),
            key: `${model.provider}/${model.id}`,
          }));
        } catch {
          return [];
        }
      }
      case "stop":
        return this.stopParticipant(String(args.id));
      case "cleanup": {
        const id = String(args.id);
        return this.residency?.hasAgent(id)
          ? this.residency.cleanupAgent(id, args.deleteBranch === true)
          : this.manager.cleanup(id, args.deleteBranch === true);
      }
      case "create": {
        if (args.scope === "global") {
          return this.globalActors.create(actorRequest(args, context, this.manager, false));
        }
        const request = actorRequest(args, context, this.manager);
        if (request.residency === "durable") await this.#resident().ensureHost();
        const actor = await this.actorManager.create(request);
        if (actor.residency === "durable") await this.#activateDurableActor(actor);
        this.participants.scheduleRefresh();
        context.activity?.({ type: "entity", id: actor.id, kind: "actor", name: actor.name });
        return actor;
      }
      case "ask": {
        const actor = this.actorManager.status(String(args.id));
        this.actorManager.validateDirectMessage(String(args.message), args.data);
        const overrides = actorRunBinding(args);
        context.activity?.({ type: "entity", id: actor.id, kind: "actor", name: actor.name });
        if (this.actorManager.owns(actor.id)) {
          return waitWithActorProgress(
            this.manager,
            this.#transcripts,
            actor.id,
            actor.name,
            this.actorManager.ask(
              actor.id,
              String(args.message),
              args.data,
              context.signal,
              { overrides },
            ),
            context,
            this.agentToolPreviewEnabled,
          );
        }
        const participant = this.participants.get(actor.id);
        if (!participant || participant.kind !== "actor") {
          throw new Error(`Fabric actor ${actor.id} has no live execution owner`);
        }
        if (!participant.capabilities.includes("ask")) {
          throw new Error(`Fabric actor owner ${participant.ownerHostId} does not support remote ask`);
        }
        if (!participant.capabilities.includes("actor-bindings")) {
          throw new Error(`Fabric actor owner ${participant.ownerHostId} does not support session bindings`);
        }
        if (!this.control || participant.controlProtocol === "legacy") {
          throw new Error(`Fabric actor owner ${participant.ownerHostId} has no result control channel`);
        }
        return this.control.requestResult<FabricActorMessage>(
          participant.ownerHostId,
          actor.id,
          "ask",
          {
            message: String(args.message),
            ...(args.data === undefined ? {} : { data: args.data }),
            binding: this.actorManager.resolveBinding(actor.id, overrides),
          },
          participant.ownerIdentityId,
          {
            timeoutMs: (actor.timeoutMs ?? this.manager.config.timeoutMs) +
              REMOTE_ASK_ACK_GRACE_MS,
            ...(context.signal ? { signal: context.signal } : {}),
          },
        );
      }
      case "tell":
        return this.routeMessage(
          String(args.id),
          String(args.message),
          args.data,
          "followUp",
          context,
          { binding: actorRunBinding(args) },
        );
      case "steer":
        return this.routeMessage(
          String(args.id),
          String(args.message),
          args.data,
          "steer",
          context,
        );
      case "followUp":
        return this.routeMessage(
          String(args.id),
          String(args.message),
          args.data,
          "followUp",
          context,
        );
      case "setSteeringMode":
        return this.manager.setSteeringMode(String(args.id), this.#steeringMode(args.mode));
      case "setFollowUpMode":
        return this.manager.setFollowUpMode(String(args.id), this.#steeringMode(args.mode));
      case "compact": {
        const id = String(args.id);
        const status = this.manager.status(id);
        context.activity?.({ type: "entity", id, kind: "agent", name: status.name });
        const instructions = typeof args.instructions === "string" ? args.instructions : undefined;
        const result = this.manager.compact(id, instructions);
        context.activity?.({
          type: "progress",
          message: `Compaction enqueued for agent ${id.slice(0, 8)} (advisory; commits at the child's next turn boundary)`,
        });
        return result;
      }
      case "actorStatus":
        return this.actorManager.status(String(args.id));
      case "actors":
        return args.scope === "global" ? this.globalActors.list() : this.actorManager.list();
      case "messages": {
        const actor = this.actorManager.status(String(args.id));
        return this.actorManager.messages(
          actor.id,
          typeof args.limit === "number" ? args.limit : 50,
        );
      }
      case "setModel":
        return this.actorManager.setModel(
          String(args.id),
          typeof args.model === "string" ? args.model : undefined,
          args.scope === "project" ? "project" : "session",
        );
      case "setThinking":
        return this.actorManager.setThinking(
          String(args.id),
          typeof args.thinking === "string" ? args.thinking : undefined,
          args.scope === "project" ? "project" : "session",
        );
      case "setTools": {
        const tools = stringArray(args.tools) ?? [];
        if (args.scope === "global") {
          return this.globalActors.update(String(args.id), { tools });
        }
        return this.actorManager.setTools(String(args.id), tools);
      }
      case "setEvents": {
        const events = Array.isArray(args.events)
          ? args.events.filter(
              (event): event is FabricActorHostEvent => isFabricActorHostEvent(event),
            )
          : [];
        return this.actorManager.setEvents(String(args.id), events);
      }
      case "setDeliveryPolicy": {
        const delivery = args.delivery as FabricActorDelivery;
        if (typeof args.triggerTurn !== "boolean") {
          throw new Error("setDeliveryPolicy requires explicit triggerTurn: true or false");
        }
        const triggerTurn = args.triggerTurn;
        if (args.scope === "global") {
          return this.globalActors.update(String(args.id), { delivery, triggerTurn });
        }
        return this.actorManager.setDeliveryPolicy(String(args.id), delivery, triggerTurn);
      }
      case "clearMessages":
        return this.actorManager.clearMessages(String(args.id));
      case "remove": {
        if (args.scope === "global") return this.globalActors.remove(String(args.id));
        const id = String(args.id);
        const actor = this.actorManager.status(id);
        return actor.residency === "durable" && !this.actorManager.owns(actor.id)
          ? this.#resident().removeActor(actor.id)
          : this.actorManager.remove(actor.id);
      }
      case "setInstructions": {
        const id = String(args.id);
        const instructions = String(args.instructions);
        if (args.scope === "global") {
          return this.globalActors.update(id, { instructions });
        }
        return this.actorManager.setInstructions(id, instructions);
      }
      case "import": {
        const key =
          typeof args.id === "string" && args.id.trim()
            ? args.id.trim()
            : typeof args.name === "string" && args.name.trim()
              ? args.name.trim()
              : "";
        if (!key) throw new Error("Import requires a template id or name");
        const def = this.globalActors.resolve(key);
        if (!def) throw new Error(`Unknown global actor: ${key}`);
        const as =
          typeof args.as === "string" && args.as.trim() ? args.as.trim() : undefined;
        const request = this.globalActors.toRequest(def, as);
        if (request.residency === "durable") await this.#resident().ensureHost();
        const actor = await this.actorManager.create(request);
        if (actor.residency === "durable") await this.#activateDurableActor(actor);
        context.activity?.({ type: "entity", id: actor.id, kind: "actor", name: actor.name });
        return actor;
      }
      case "export": {
        const actor = this.actorManager.status(String(args.id));
        const overwrite = args.overwrite === true;
        const def = this.actorManager.definition(actor.id);
        return this.globalActors.create(def, overwrite);
      }
      case "log": {
        const id = String(args.id);
        const type = args.type === "run" || args.type === "all" ? args.type : "session";
        const lines = typeof args.lines === "number" ? args.lines : 200;
        const runId = typeof args.runId === "string" ? args.runId : undefined;
        const before = typeof args.before === "number" ? args.before : undefined;
        try {
          const actor = this.actorManager.status(id);
          return this.actorManager.readLog(actor.id, {
            type,
            lines,
            ...(runId ? { runId } : {}),
            ...(before !== undefined ? { before } : {}),
          });
        } catch (error) {
          if (!(error instanceof Error && /Unknown Fabric actor/.test(error.message))) throw error;
          /* not an actor — fall through to agent */
        }
        if (this.residency?.hasAgent(id)) {
          return this.residency.readAgentLog(id, {
            lines,
            ...(before !== undefined ? { before } : {}),
          });
        }
        return this.manager.readLog(id, { lines, ...(before !== undefined ? { before } : {}) });
      }
      default:
        throw new Error(`Unknown agents action: ${actionName}`);
    }
  }

  async routeMessage(
    id: string,
    message: string,
    data: unknown,
    kind: "steer" | "followUp",
    context?: FabricInvocationContext,
    options: {
      from?: MeshIdentity;
      triggerTurn?: boolean;
      binding?: FabricActorRunBinding;
    } = {},
  ): Promise<FabricAgentMessageResult> {
    if (this.mainAgent.matches(id)) {
      if (this.mainAgent.local) {
        context?.activity?.({
          type: "entity",
          id: this.mainAgent.id,
          kind: "agent",
          name: "Main",
        });
        return this.mainAgent.deliverAgent({
          from: options.from ?? this.actorManager.identity,
          message,
          delivery: kind,
          ...(typeof options.triggerTurn === "boolean"
            ? { triggerTurn: options.triggerTurn }
            : {}),
          ...(data === undefined ? {} : { data }),
        });
      }
      const participant = this.participants.get(this.mainAgent.id);
      if (!participant) throw new Error(`Unknown Fabric Main participant: ${this.mainAgent.id}`);
      if (!participant.capabilities.includes(kind)) {
        throw new Error(`Fabric participant ${participant.id} does not support ${kind}`);
      }
      if (!this.control || participant.controlProtocol === "legacy") {
        return this.actorManager.steerRemote(this.mainAgent.id, message, kind, data);
      }
      return this.control.request(
        participant.ownerHostId,
        participant.id,
        kind,
        {
          message,
          data,
          ...(typeof options.triggerTurn === "boolean"
            ? { triggerTurn: options.triggerTurn }
            : {}),
        },
        participant.ownerIdentityId,
      );
    }

    // Local one-shot agent: forward between its turns via the worker's
    // steer.jsonl channel, preserving the child's accumulated context.
    try {
      const status = this.manager.status(id);
      context?.activity?.({ type: "entity", id, kind: "agent", name: status.name });
      const result =
        kind === "steer"
          ? this.manager.steer(id, message, data)
          : this.manager.followUp(id, message, data);
      return { queued: true, messageId: result.messageId, routed: "local" };
    } catch (error) {
      if (!(error instanceof Error && /Unknown Fabric agent/.test(error.message))) throw error;
    }

    // Persistent actors consume both delivery modes through their serial mailbox.
    let actorTarget: FabricActorInfo | undefined;
    try {
      const actor = this.actorManager.status(id);
      actorTarget = actor;
      this.actorManager.validateDirectMessage(message, data);
      const ownership = this.participants.get(actor.id);
      if (!ownership || ownership.local) {
        context?.activity?.({ type: "entity", id: actor.id, kind: "actor", name: actor.name });
        const result = this.actorManager.tell(actor.id, message, data, {
          ...(options.binding ? { overrides: options.binding } : {}),
        });
        return { queued: true, messageId: result.messageId, routed: "local" };
      }
    } catch (error) {
      if (!(error instanceof Error && /Unknown Fabric actor/.test(error.message))) throw error;
    }

    const participantId = actorTarget?.id ?? id;
    const participant = this.participants.get(participantId);
    if (!participant) throw new Error(`Unknown Fabric participant: ${id}`);
    if (!participant.capabilities.includes(kind)) {
      throw new Error(`Fabric participant ${participant.id} does not support ${kind}`);
    }
    const sessionBinding = actorTarget?.binding;
    const needsBinding = Boolean(
      options.binding?.model ||
        options.binding?.thinking ||
        sessionBinding?.model ||
        sessionBinding?.thinking,
    );
    if (needsBinding && !participant.capabilities.includes("actor-bindings")) {
      throw new Error(`Fabric actor owner ${participant.ownerHostId} does not support session bindings`);
    }
    if (!this.control || participant.controlProtocol === "legacy") {
      if (needsBinding) {
        throw new Error(`Fabric actor owner ${participant.ownerHostId} has no binding control channel`);
      }
      return this.actorManager.steerRemote(participant.id, message, kind, data);
    }
    const binding = actorTarget && participant.capabilities.includes("actor-bindings")
      ? this.actorManager.resolveBinding(actorTarget.id, options.binding)
      : undefined;
    return this.control.request(
      participant.ownerHostId,
      participant.id,
      kind,
      {
        message,
        data,
        ...(typeof options.triggerTurn === "boolean"
          ? { triggerTurn: options.triggerTurn }
          : {}),
        ...(binding ? { binding } : {}),
      },
      participant.ownerIdentityId,
    );
  }

  async deliverLifecycle(
    subscription: FabricLifecycleSubscription,
    event: FabricLifecycleEvent,
  ): Promise<void> {
    const status = event.status ? ` with status ${event.status}` : "";
    const run = event.runId ? ` (run ${event.runId.slice(0, 8)})` : "";
    const message =
      `Fabric lifecycle ${event.event} from ${event.source.name} (${event.source.id})${run}${status}.`;
    await this.routeMessage(
      subscription.to,
      message,
      event,
      subscription.delivery,
      undefined,
      {
        from: lifecycleSourceIdentity(event.source),
        triggerTurn: subscription.triggerTurn,
      },
    );
  }

  async acceptControl(
    command: FabricControlCommand,
    from: MeshIdentity,
    signal?: AbortSignal,
  ): Promise<FabricControlAcceptance> {
    if (command.operation === "cancel") {
      return { accepted: false, error: "Cancel commands are handled by the control plane" };
    }
    if (command.operation === "stop") {
      try {
        await this.manager.stop(command.targetId);
        this.participants.scheduleRefresh();
        return { accepted: true, messageId: command.commandId };
      } catch (error) {
        if (!(error instanceof Error && /Unknown Fabric agent/.test(error.message))) {
          return { accepted: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      try {
        const actor = this.actorManager.status(command.targetId);
        const ownership = this.participants.get(actor.id);
        if (ownership && !ownership.local) {
          return { accepted: false, error: `Participant ${actor.id} is owned by ${ownership.ownerHostId}` };
        }
        await this.actorManager.stop(actor.id);
        this.participants.scheduleRefresh();
        return { accepted: true, messageId: command.commandId };
      } catch (error) {
        if (!(error instanceof Error && /Unknown Fabric actor/.test(error.message))) {
          return { accepted: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      return { accepted: false, error: `Owner does not control Fabric participant ${command.targetId}` };
    }

    const message = command.message?.trim();
    if (!message) return { accepted: false, error: "Fabric control message must not be empty" };
    if (command.operation === "ask") {
      try {
        const actor = this.actorManager.status(command.targetId);
        const ownership = this.participants.get(actor.id);
        if (ownership && !ownership.local) {
          return {
            accepted: false,
            error: `Participant ${actor.id} is owned by ${ownership.ownerHostId}`,
          };
        }
        const result = await this.actorManager.ask(
          actor.id,
          message,
          command.data,
          signal,
          command.binding !== undefined ? { binding: command.binding } : {},
        );
        return { accepted: true, messageId: result.id, result };
      } catch (error) {
        return {
          accepted: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    if (this.mainAgent.local && this.mainAgent.matches(command.targetId)) {
      const result = this.mainAgent.deliverAgent({
        from,
        message,
        delivery: command.operation,
        ...(typeof command.triggerTurn === "boolean"
          ? { triggerTurn: command.triggerTurn }
          : {}),
        ...(command.data === undefined ? {} : { data: command.data }),
      });
      return { accepted: true, messageId: result.messageId };
    }
    try {
      this.manager.status(command.targetId);
      const result =
        command.operation === "steer"
          ? this.manager.steer(command.targetId, message, command.data)
          : this.manager.followUp(command.targetId, message, command.data);
      return { accepted: true, messageId: result.messageId };
    } catch (error) {
      if (!(error instanceof Error && /Unknown Fabric agent/.test(error.message))) {
        return { accepted: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    try {
      const actor = this.actorManager.status(command.targetId);
      const ownership = this.participants.get(actor.id);
      if (ownership && !ownership.local) {
        return { accepted: false, error: `Participant ${actor.id} is owned by ${ownership.ownerHostId}` };
      }
      const result = this.actorManager.tell(
        actor.id,
        message,
        command.data,
        command.binding !== undefined ? { binding: command.binding } : {},
      );
      return { accepted: true, messageId: result.messageId };
    } catch (error) {
      if (!(error instanceof Error && /Unknown Fabric actor/.test(error.message))) {
        return { accepted: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    return { accepted: false, error: `Owner does not control Fabric participant ${command.targetId}` };
  }

  #resident(): ResidencyClient {
    if (!this.residency) {
      throw new Error(
        "Durable residency requires a trusted project with Fabric mesh persistence enabled",
      );
    }
    return this.residency;
  }

  async #activateDurableActor(actor: FabricActorInfo): Promise<void> {
    const residency = this.#resident();
    await this.actorManager.cede(actor.id);
    await this.participants.refresh();
    try {
      await residency.ensureActor(actor.id);
    } catch (error) {
      try {
        await residency.removeActor(actor.id);
      } catch {
        this.actorManager.reclaim(actor.id);
      }
      await this.participants.refresh().catch(() => undefined);
      throw error;
    }
  }

  #listAgents(scopeValue: unknown): Array<AgentRunRecord | AgentHandleInfo | ReturnType<FabricParticipantSource["self"]>> {
    const scope = this.#participantScope(scopeValue, "local");
    if (scope === "local") return this.manager.list();
    const local = new Map<string, AgentRunRecord | AgentHandleInfo>();
    const append = (record: AgentRunRecord | AgentHandleInfo): void => {
      local.set(record.id, record);
      if ("nestedAgents" in record) {
        for (const nested of record.nestedAgents ?? []) append(nested);
      }
    };
    for (const record of this.manager.list()) append(record);
    for (const record of this.residency?.listAgents() ?? []) append(record);
    const listed = this.participants
      .list({ scope, kinds: ["agent"] })
      .map((participant) => local.get(participant.id) ?? participant);
    const seen = new Set(listed.map((record) => record.id));
    for (const record of this.residency?.listAgents() ?? []) {
      if (!seen.has(record.id)) listed.push(record);
    }
    return listed;
  }

  #participantAlias(value: string): string {
    const id = value.trim();
    return id === "main" ? this.mainAgent.id : id;
  }

  #participantScope(
    value: unknown,
    fallback: FabricParticipantScope,
  ): FabricParticipantScope {
    return value === "local" || value === "lineage" || value === "project" ? value : fallback;
  }

  async stopParticipant(id: string): Promise<unknown> {
    try {
      const result = await this.manager.stop(id);
      this.participants.scheduleRefresh();
      return result;
    } catch (error) {
      if (!(error instanceof Error && /Unknown Fabric agent/.test(error.message))) throw error;
    }
    try {
      const actor = this.actorManager.status(id);
      const ownership = this.participants.get(actor.id);
      if (!ownership || ownership.local) {
        const result = await this.actorManager.stop(actor.id);
        this.participants.scheduleRefresh();
        return result;
      }
    } catch (error) {
      if (!(error instanceof Error && /Unknown Fabric actor/.test(error.message))) throw error;
    }
    const participant = this.participants.get(id);
    if (!participant) throw new Error(`Unknown Fabric participant: ${id}`);
    if (!participant.capabilities.includes("stop")) {
      throw new Error(`Fabric participant ${id} cannot be stopped`);
    }
    if (!this.control) throw new Error("Fabric control plane is unavailable");
    return this.control.request(
      participant.ownerHostId,
      participant.id,
      "stop",
      {},
      participant.ownerIdentityId,
    );
  }

  #steeringMode(mode: unknown): "all" | "one-at-a-time" {
    if (mode === "all" || mode === "one-at-a-time") return mode;
    throw new Error(
      `Invalid steering mode: ${String(mode)} (expected "all" or "one-at-a-time")`,
    );
  }

  async close(): Promise<void> {
    this.#transcripts.clear();
    if (!this.ownsRuntime) return;
    await this.lifecycle.close();
    try {
      await this.actorManager.close();
    } finally {
      await this.manager.close();
    }
  }
}
