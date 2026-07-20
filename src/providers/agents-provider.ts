import { ActorManager } from "../actors/manager.js";
import { GlobalActorRegistry } from "../actors/global-registry.js";
import type { FabricActorHostEvent, FabricActorMessage, FabricActorRequest } from "../actors/types.js";
import type {
  FabricAgentMessageResult,
  FabricMainAgentTarget,
} from "../main-agent.js";
import type { FabricPeerSource } from "../peer-session.js";
import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";
import {
  effectiveSubagentTimeoutMs,
  SubagentManager,
} from "../subagents/manager.js";
import type { SubagentRunRequest } from "../subagents/types.js";
import { isFabricThinking } from "../thinking.js";
import { AgentTranscriptReader, recentTranscriptTools } from "../ui/transcript.js";

const runProperties = {
  task: { type: "string", description: "A self-contained task for the child agent" },
  name: { type: "string" },
  runner: {
    type: "string",
    enum: ["pi", "claude"],
    description: "Execution harness. Defaults to subagents.runner.",
  },
  transport: {
    type: "string",
    enum: ["auto", "process", "tmux", "screen", "localterm", "herdr"],
  },
  model: {
    type: "string",
    description: "Pi provider/id key or Claude claude/<runtime-value> key from agents.models().",
  },
  thinking: {
    type: "string",
    enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  },
  tools: { type: "array", items: { type: "string" } },
  timeoutMs: {
    type: "number",
    description:
      "Optional longer wall-clock limit in milliseconds. Omit to use subagents.timeoutMs (60 minutes by default); values below the configured default are ignored.",
  },
  extensions: { type: "boolean" },
  recursive: { type: "boolean" },
  worktree: { type: "boolean" },
  schema: { type: "object", description: "Optional JSON Schema for validated structured output" },
};

const runSchema = {
  type: "object",
  properties: runProperties,
  required: ["task"],
  additionalProperties: false,
};

const idSchema = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
  additionalProperties: false,
};

const AGENT_PROGRESS_INTERVAL_MS = 1_000;
const AGENT_PREVIEW_TEXT_CODE_POINTS = 2_000;
const AGENT_PREVIEW_TOOL_LIMIT = 8;

const tailCodePoints = (value: string, limit: number): string => {
  if (value.length <= limit) return value;
  return Array.from(value.slice(-limit * 2)).slice(-limit).join("");
};

const descriptors: FabricActionDescriptor[] = [
  {
    name: "run",
    description: "Run a child agent through Pi or Claude Code and wait for its final result",
    inputSchema: runSchema,
    risk: "agent",
  },
  {
    name: "spawn",
    description: "Start a child agent through Pi or Claude Code and return a handle immediately",
    inputSchema: runSchema,
    risk: "agent",
  },
  {
    name: "wait",
    description: "Wait for a previously spawned child agent",
    inputSchema: idSchema,
    risk: "read",
  },
  {
    name: "status",
    description: "Get the latest status of a child agent",
    inputSchema: idSchema,
    risk: "read",
  },
  {
    name: "list",
    description: "List child agents created by this Fabric session",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  },
  {
    name: "main",
    description:
      "Return the root user-facing Main Pi agent target. The stable alias main is also accepted by agents.steer and agents.followUp.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  },
  {
    name: "peers",
    description: "List other live root Pi sessions sharing this project mesh. The dashboard-owning session remains Main; these targets are named peers.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  },
  {
    name: "models",
    description:
      "List models exposed by the selected runner. Claude models are enumerated from the installed Claude Code runtime, not hard-coded.",
    inputSchema: {
      type: "object",
      properties: {
        runner: { type: "string", enum: ["pi", "claude"] },
        refresh: { type: "boolean" },
      },
      additionalProperties: false,
    },
    risk: "execute",
  },
  {
    name: "stop",
    description: "Stop a running child agent",
    inputSchema: idSchema,
    risk: "agent",
  },
  {
    name: "cleanup",
    description: "Remove a completed agent's run files and optional Git worktree",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        deleteBranch: { type: "boolean" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    risk: "write",
  },
  {
    name: "create",
    description:
      'Create a persistent actor with a mailbox and optional host-event or mesh-topic subscriptions. Use scope "global" to save a reusable project-independent template to the global registry instead of a live project actor; global templates are not live and carry no history.',
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        instructions: { type: "string" },
        events: {
          type: "array",
          items: {
            type: "string",
            enum: ["input", "turn_end", "agent_settled", "tool_error", "session_compact"],
          },
        },
        topics: { type: "array", items: { type: "string" } },
        delivery: {
          type: "string",
          enum: ["mailbox", "steer", "followUp", "nextTurn"],
        },
        responseMode: { type: "string", enum: ["text", "directive"] },
        triggerTurn: { type: "boolean" },
        coalesce: { type: "boolean" },
        runner: runProperties.runner,
        model: runProperties.model,
        thinking: runProperties.thinking,
        tools: runProperties.tools,
        transport: runProperties.transport,
        timeoutMs: runProperties.timeoutMs,
        extensions: runProperties.extensions,
        scope: { type: "string", enum: ["project", "global"] },
      },
      required: ["name", "instructions"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "ask",
    description: "Send a message to a persistent actor and wait for its next response",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, message: { type: "string" }, data: {} },
      required: ["id", "message"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "tell",
    description: "Queue a message for a persistent actor without waiting",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, message: { type: "string" }, data: {} },
      required: ["id", "message"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "steer",
    description:
      "Steer Main, a running one-shot subagent between turns, or a persistent actor through its mailbox. The stable id alias main targets the root user-facing Pi session. Non-local targets route over the project mesh.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, message: { type: "string" }, data: {} },
      required: ["id", "message"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "followUp",
    description:
      "Queue a follow-up for Main or a running one-shot subagent, or enqueue a persistent actor mailbox message. The stable id alias main targets the root user-facing Pi session. Non-local targets route over the project mesh.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, message: { type: "string" }, data: {} },
      required: ["id", "message"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "setSteeringMode",
    description:
      "Set how queued steer messages are delivered to a running one-shot subagent: all at once after the current turn, or one per turn (default). Local subagent only.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        mode: { type: "string", enum: ["all", "one-at-a-time"] },
      },
      required: ["id", "mode"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "setFollowUpMode",
    description:
      "Set how queued follow-up messages are delivered to a one-shot subagent: all when it finishes, or one per completion (default). Local subagent only.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        mode: { type: "string", enum: ["all", "one-at-a-time"] },
      },
      required: ["id", "mode"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "compact",
    description:
      "Request an advisory compaction of a running Pi-runner child agent's context at its next safe boundary (between its own turns), preserving the child's accumulated context. Rejected for Claude-runner children. The child pi core applies the compaction; Fabric only forwards the intent.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        instructions: {
          type: "string",
          description: "Optional custom compaction instructions forwarded to the child pi",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "actorStatus",
    description: "Read one persistent actor's status",
    inputSchema: idSchema,
    risk: "read",
  },
  {
    name: "actors",
    description:
      'List persistent actors. Default scope "project" lists live actors in this Fabric session; scope "global" lists project-independent templates in the global registry.',
    inputSchema: {
      type: "object",
      properties: { scope: { type: "string", enum: ["project", "global"] } },
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "messages",
    description: "Read a persistent actor's bounded inbox and outbox history",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, limit: { type: "number", minimum: 1 } },
      required: ["id"],
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "setTools",
    description:
      "Replace a persistent actor's tool allowlist. Takes effect on its next queued message; an empty list disables optional tools.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        tools: runProperties.tools,
        scope: { type: "string", enum: ["project", "global"] },
      },
      required: ["id", "tools"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "setEvents",
    description: "Replace a persistent actor's host-event subscriptions",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        events: {
          type: "array",
          items: {
            type: "string",
            enum: ["input", "turn_end", "agent_settled", "tool_error", "session_compact"],
          },
        },
      },
      required: ["id", "events"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "clearMessages",
    description: "Clear a persistent actor's recorded message history",
    inputSchema: idSchema,
    risk: "write",
  },
  {
    name: "remove",
    description:
      'Stop and remove a persistent actor. Default scope "project" removes a live project actor; scope "global" removes a project-independent template from the global registry.',
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        scope: { type: "string", enum: ["project", "global"] },
      },
      required: ["id"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "setInstructions",
    description:
      'Replace an actor\'s default instruction (its persona / system-prompt body). Default scope "project" edits a live project actor; scope "global" edits a project-independent template. Takes effect on the actor\'s next queued message.',
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        instructions: { type: "string" },
        scope: { type: "string", enum: ["project", "global"] },
      },
      required: ["id", "instructions"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "import",
    description:
      "Import a project-independent template from the global registry into the current project as a fresh live actor with no inherited history (no messages, session, or run logs). Identify the template by id or name; optionally rename the imported actor with \"as\" to avoid colliding with a live actor.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Template id or name (one of id/name required)" },
        name: { type: "string", description: "Template name (one of id/name required)" },
        as: { type: "string", description: "Optional new name for the imported live actor" },
      },
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "export",
    description:
      "Export a live project actor's definition to the global registry as a project-independent template, without any history (no messages, session, or run logs). Throws on a name collision unless overwrite is true.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        overwrite: { type: "boolean" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    risk: "write",
  },
  {
    name: "log",
    description:
      "Read an actor or subagent run's LLM/agent log: the actor's session transcript (session.jsonl) and/or a retained run's event stream (events.jsonl: tool calls, model responses, usage). Actors retain their last runs so logs survive after success.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Actor ID/name or subagent run ID" },
        type: {
          type: "string",
          enum: ["session", "run", "all"],
          description:
            "session = actor session transcript (default for actors); run = last retained run's events; all = both",
        },
        lines: { type: "number", minimum: 1, description: "Page line limit (default 200)" },
        before: {
          type: "number",
          minimum: 0,
          description: "Exclusive line cursor returned by a previous page to load older entries",
        },
        runId: { type: "string", description: "Specific retained run (default: actor's last run)" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    risk: "read",
  },
];

const stringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;

const longerTimeoutOverride = (
  value: unknown,
  manager: SubagentManager,
): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const effective = effectiveSubagentTimeoutMs(manager.config.timeoutMs, value);
  return effective > manager.config.timeoutMs ? effective : undefined;
};

const runRequest = (
  args: Record<string, unknown>,
  context: FabricInvocationContext,
  manager: SubagentManager,
): SubagentRunRequest => {
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
  const runner = args.runner === "pi" || args.runner === "claude" ? args.runner : manager.config.runner;
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
    ...(thinking ? { thinking } : {}),
    ...(tools ? { tools } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(typeof args.extensions === "boolean" ? { extensions: args.extensions } : {}),
    ...(typeof args.recursive === "boolean" ? { recursive: args.recursive } : {}),
    ...(typeof args.worktree === "boolean" ? { worktree: args.worktree } : {}),
    ...(typeof args.schema === "object" && args.schema !== null && !Array.isArray(args.schema)
      ? { schema: args.schema as Record<string, unknown> }
      : {}),
  };
};

const actorRequest = (
  args: Record<string, unknown>,
  context: FabricInvocationContext,
  manager: SubagentManager,
  inheritModel = true,
): FabricActorRequest => {
  const events = Array.isArray(args.events)
    ? args.events.filter(
        (event): event is FabricActorHostEvent =>
          event === "input" ||
          event === "turn_end" ||
          event === "agent_settled" ||
          event === "tool_error" ||
          event === "session_compact",
      )
    : undefined;
  const topics = stringArray(args.topics);
  const tools = stringArray(args.tools);
  const timeoutMs = longerTimeoutOverride(args.timeoutMs, manager);
  const runner = args.runner === "pi" || args.runner === "claude" ? args.runner : manager.config.runner;
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
  };
};

type AgentProgressStatus = ReturnType<SubagentManager["status"]>;

const attachAgentToolPreview = (
  status: AgentProgressStatus,
  transcripts: AgentTranscriptReader,
  context: FabricInvocationContext,
  enabled: () => boolean,
): void => {
  if (!context.attachPreview) return;
  try {
    const tools =
      enabled() && "logFile" in status && status.logFile
        ? recentTranscriptTools(
            transcripts.read({ id: status.id, status: status.status, logFile: status.logFile }),
            AGENT_PREVIEW_TOOL_LIMIT,
          )
        : [];
    context.attachPreview({
      kind: "fabric-agent-tools",
      id: status.id,
      name: status.actorName ?? status.name,
      status: status.status,
      runner: status.runner,
      owner: status.actorId ? "actor" : "agent",
      ...("text" in status && status.text
        ? { text: tailCodePoints(status.text, AGENT_PREVIEW_TEXT_CODE_POINTS) }
        : {}),
      tools,
    });
  } catch {
    // The worker may settle and clean up while its final preview is being read.
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
  manager: SubagentManager,
  actorId: string,
  includeTerminal: boolean,
): ReturnType<SubagentManager["list"]>[number] | undefined => {
  const candidates = manager.list().filter((candidate) => candidate.actorId === actorId);
  const active = candidates.find((candidate) => candidate.status === "running");
  if (active || !includeTerminal) return active;
  // SubagentManager.list() preserves run insertion order; the last actor run
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
  manager: SubagentManager,
  transcripts: AgentTranscriptReader,
  id: string,
  context: FabricInvocationContext,
  nestedToolsEnabled: () => boolean,
): Promise<unknown> => {
  const result = manager.wait(id);
  let lastProgressRevision: string | undefined;
  try {
    const settled = await waitForResultWithProgress(result, () => {
      const status = manager.status(id);
      const revision = agentProgressRevision(status);
      if (revision === lastProgressRevision) return;
      lastProgressRevision = revision;
      attachAgentToolPreview(status, transcripts, context, nestedToolsEnabled);
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
      attachAgentToolPreview(status, transcripts, context, nestedToolsEnabled);
      const displayName = status.actorName ?? status.name;
      context.update(`Agent ${displayName}: ${status.status}`);
    } catch {
      // The run may have been cleaned up during cancellation.
    }
  }
};

const waitWithActorProgress = async (
  manager: SubagentManager,
  transcripts: AgentTranscriptReader,
  actorId: string,
  actorName: string,
  result: Promise<FabricActorMessage>,
  context: FabricInvocationContext,
  nestedToolsEnabled: () => boolean,
): Promise<FabricActorMessage> => {
  let lastProgressRevision: string | undefined;
  try {
    return await waitForResultWithProgress(result, () => {
      const worker = actorWorker(manager, actorId, false);
      const revision = worker ? agentProgressRevision(worker) : "queued";
      if (worker && revision !== lastProgressRevision) {
        attachAgentToolPreview(worker, transcripts, context, nestedToolsEnabled);
      }
      if (revision === lastProgressRevision) return;
      lastProgressRevision = revision;
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
    if (worker) attachAgentToolPreview(worker, transcripts, context, nestedToolsEnabled);
  }
};

export class AgentsProvider implements FabricProvider {
  readonly #transcripts = new AgentTranscriptReader();
  readonly name = "agents";
  readonly description =
    "The user-facing Main target, one-shot Pi or Claude Code agents, and persistent mailbox actors over process, tmux, screen, LocalTerm, or Herdr";

  constructor(
    readonly manager: SubagentManager,
    readonly actorManager: ActorManager,
    readonly globalActors: GlobalActorRegistry,
    readonly mainAgent: FabricMainAgentTarget,
    readonly nestedToolsEnabled: () => boolean = () => true,
    readonly peers: FabricPeerSource = { list: () => [] },
  ) {}

  async list(
    request: FabricProviderListRequest,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor[]> {
    const query = request.query?.toLowerCase();
    return query
      ? descriptors.filter((descriptor) =>
          `${descriptor.name} ${descriptor.description}`.toLowerCase().includes(query),
        )
      : descriptors;
  }

  async describe(
    actionName: string,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor | undefined> {
    return descriptors.find((descriptor) => descriptor.name === actionName);
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
        context.activity?.({
          type: "entity",
          id: handle.id,
          kind: "agent",
          name: handle.name,
        });
        context.update(
          `Agent ${handle.name} started via ${handle.runner}/${handle.transport}${handle.attachCommand ? ` · ${handle.attachCommand}` : ""}`,
        );
        return waitWithProgress(
          this.manager,
          this.#transcripts,
          handle.id,
          context,
          this.nestedToolsEnabled,
        );
      }
      case "spawn": {
        const handle = await this.manager.spawn(
          runRequest(args, context, this.manager),
          context.signal,
        );
        this.manager.detachSignal(handle.id);
        context.activity?.({
          type: "entity",
          id: handle.id,
          kind: "agent",
          name: handle.name,
        });
        context.update(
          `Agent ${handle.name} started via ${handle.runner}/${handle.transport}${handle.attachCommand ? ` · ${handle.attachCommand}` : ""}`,
        );
        return handle;
      }
      case "wait": {
        const id = String(args.id);
        const status = this.manager.status(id);
        context.activity?.({ type: "entity", id, kind: "agent", name: status.name });
        return waitWithProgress(
          this.manager,
          this.#transcripts,
          id,
          context,
          this.nestedToolsEnabled,
        );
      }
      case "status": {
        const id = String(args.id);
        if (this.mainAgent.matches(id)) return this.mainAgent.info(context.extensionContext);
        return this.manager.status(id);
      }
      case "list":
        return this.manager.list();
      case "main":
        return this.mainAgent.info(context.extensionContext);
      case "peers":
        return this.peers.list();
      case "models": {
        const runner =
          args.runner === "pi" || args.runner === "claude"
            ? args.runner
            : this.manager.config.runner;
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
        return this.manager.stop(String(args.id));
      case "cleanup":
        return this.manager.cleanup(String(args.id), args.deleteBranch === true);
      case "create": {
        if (args.scope === "global") {
          return this.globalActors.create(actorRequest(args, context, this.manager, false));
        }
        const actor = await this.actorManager.create(actorRequest(args, context, this.manager));
        context.activity?.({ type: "entity", id: actor.id, kind: "actor", name: actor.name });
        return actor;
      }
      case "ask": {
        const actor = this.actorManager.status(String(args.id));
        context.activity?.({ type: "entity", id: actor.id, kind: "actor", name: actor.name });
        return waitWithActorProgress(
          this.manager,
          this.#transcripts,
          actor.id,
          actor.name,
          this.actorManager.ask(actor.id, String(args.message), args.data, context.signal),
          context,
          this.nestedToolsEnabled,
        );
      }
      case "tell": {
        const actor = this.actorManager.status(String(args.id));
        context.activity?.({ type: "entity", id: actor.id, kind: "actor", name: actor.name });
        return this.actorManager.tell(actor.id, String(args.message), args.data);
      }
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
      case "messages":
        return this.actorManager.messages(
          String(args.id),
          typeof args.limit === "number" ? args.limit : 50,
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
              (event): event is FabricActorHostEvent =>
                event === "input" ||
                event === "turn_end" ||
                event === "agent_settled" ||
                event === "tool_error" ||
                event === "session_compact",
            )
          : [];
        return this.actorManager.setEvents(String(args.id), events);
      }
      case "clearMessages":
        return this.actorManager.clearMessages(String(args.id));
      case "remove":
        return args.scope === "global"
          ? this.globalActors.remove(String(args.id))
          : this.actorManager.remove(String(args.id));
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
        const actor = await this.actorManager.create(this.globalActors.toRequest(def, as));
        context.activity?.({ type: "entity", id: actor.id, kind: "actor", name: actor.name });
        return actor;
      }
      case "export": {
        const id = String(args.id);
        const overwrite = args.overwrite === true;
        const def = this.actorManager.definition(id);
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
        } catch {
          /* not an actor — fall through to subagent */
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
          from: this.actorManager.identity,
          message,
          delivery: kind,
          ...(data === undefined ? {} : { data }),
        });
      }
      return this.actorManager.steerRemote(
        this.mainAgent.id,
        message,
        kind,
        data,
      );
    }

    // Local one-shot subagent: forward between its turns via the worker's
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
      if (!(error instanceof Error && /Unknown Fabric subagent/.test(error.message))) throw error;
    }

    // Persistent actors consume both delivery modes through their serial mailbox.
    try {
      const actor = this.actorManager.status(id);
      context?.activity?.({ type: "entity", id: actor.id, kind: "actor", name: actor.name });
      const result = this.actorManager.tell(actor.id, message, data);
      return { queued: true, messageId: result.messageId, routed: "local" };
    } catch (error) {
      if (!(error instanceof Error && /Unknown Fabric actor/.test(error.message))) throw error;
    }

    // Recursive descendants and peers are owned by another Fabric process.
    return this.actorManager.steerRemote(id, message, kind, data);
  }

  #steeringMode(mode: unknown): "all" | "one-at-a-time" {
    if (mode === "all" || mode === "one-at-a-time") return mode;
    throw new Error(
      `Invalid steering mode: ${String(mode)} (expected "all" or "one-at-a-time")`,
    );
  }

  async close(): Promise<void> {
    this.#transcripts.clear();
    await this.actorManager.close();
    await this.manager.close();
  }
}
