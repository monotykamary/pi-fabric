import { ActorManager } from "../actors/manager.js";
import { GlobalActorRegistry } from "../actors/global-registry.js";
import { FABRIC_ACTOR_HOST_EVENTS, isFabricActorHostEvent } from "../actors/types.js";
import type {
  FabricActorDelivery,
  FabricActorHostEvent,
  FabricActorInfo,
  FabricActorMessage,
  FabricActorRequest,
} from "../actors/types.js";
import type {
  FabricAgentMessageResult,
  FabricMainAgentTarget,
} from "../main-agent.js";
import type { MeshIdentity } from "../mesh/store.js";
import { LifecycleBroker } from "../lifecycle/broker.js";
import {
  FABRIC_LIFECYCLE_EVENTS,
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
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";
import {
  effectiveAgentTimeoutMs,
  AgentManager,
} from "../agents/manager.js";
import type {
  AgentHandleInfo,
  AgentRunRecord,
  AgentRunRequest,
  AgentRunResult,
  AgentSessionSeed,
} from "../agents/types.js";
import { isFabricThinking } from "../thinking.js";
import { AgentTranscriptReader, recentTranscriptTools } from "../ui/transcript.js";

const runProperties = {
  task: { type: "string", description: "A self-contained task for the child agent" },
  name: { type: "string" },
  runner: {
    type: "string",
    enum: ["pi", "claude"],
    description: "Execution harness. Defaults to agents.runner.",
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
      "Optional longer wall-clock limit in milliseconds. Omit to use agents.timeoutMs (60 minutes by default); values below the configured default are ignored.",
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

const handoffSchema = {
  type: "object",
  properties: {
    task: {
      type: "string",
      description: "Optional instructions for the executor in addition to the inherited trajectory",
    },
    name: runProperties.name,
    transport: runProperties.transport,
    model: {
      ...runProperties.model,
      description: "Explicit Pi provider/id target that will continue the inherited trajectory",
    },
    thinking: runProperties.thinking,
    tools: runProperties.tools,
    timeoutMs: runProperties.timeoutMs,
    extensions: runProperties.extensions,
    recursive: runProperties.recursive,
    schema: runProperties.schema,
  },
  required: ["model"],
  additionalProperties: false,
};

const idSchema = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
  additionalProperties: false,
};

const lifecycleEventSchema = {
  type: "string",
  enum: [...FABRIC_LIFECYCLE_EVENTS],
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
    name: "handoff",
    description:
      "Schedule a Pi trajectory handoff after the current outer fabric_exec result, then wait for implementation at that boundary",
    inputSchema: handoffSchema,
    risk: "agent",
  },
  {
    name: "spawn",
    description:
      "Start a child agent through Pi or Claude Code and return a handle immediately. Detached runs send Main a follow-up on terminal completion when agents.notifyOnComplete is enabled; use wait when this Fabric program needs the result and status only for progress inspection.",
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
    description: "Get the latest status of any known project participant",
    inputSchema: idSchema,
    risk: "read",
  },
  {
    name: "list",
    description: "List agent participants locally, across the current lineage, or across the project",
    inputSchema: {
      type: "object",
      properties: { scope: { type: "string", enum: ["local", "lineage", "project"] } },
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "members",
    description: "List the unified project topology of roots, agents, and actors",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["local", "lineage", "project"] },
        kinds: {
          type: "array",
          items: { type: "string", enum: ["root", "agent", "actor"] },
        },
        includeStale: { type: "boolean" },
      },
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "self",
    description: "Return this caller's intrinsic participant identity in the unified topology",
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
    name: "subscribe",
    description:
      "Create a durable source-qualified participant lifecycle subscription. Events are delivered to Main by default or to another participant through steer/follow-up routing.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Exact source participant id; main means this lineage root" },
        events: { type: "array", minItems: 1, items: lifecycleEventSchema },
        to: { type: "string", description: "Target participant id; defaults to main" },
        delivery: { type: "string", enum: ["steer", "followUp"] },
        triggerTurn: { type: "boolean" },
        once: { type: "boolean" },
      },
      required: ["from", "events", "delivery", "triggerTurn"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "subscriptions",
    description: "List durable participant lifecycle subscriptions, optionally filtered by source or target",
    inputSchema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      additionalProperties: false,
    },
    risk: "read",
  },
  {
    name: "unsubscribe",
    description: "Remove a participant lifecycle subscription",
    inputSchema: idSchema,
    risk: "agent",
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
    description: "Stop a local or remotely owned agent or actor that advertises the stop capability",
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
      'Create a persistent actor with a mailbox and optional subscriptions to any session-bound Pi event or mesh topic. Image-bearing events attach images to the actor model automatically while persistent event data stays redacted. Use scope "global" to save a reusable project-independent template to the global registry instead of a live project actor; global templates are not live and carry no history.',
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        instructions: { type: "string" },
        events: {
          type: "array",
          items: {
            type: "string",
            enum: [...FABRIC_ACTOR_HOST_EVENTS],
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
        validWhile: {
          type: "object",
          properties: { version: { const: 1 }, source: { type: "string" } },
          required: ["version", "source"],
          additionalProperties: false,
        },
        scope: { type: "string", enum: ["project", "global"] },
      },
      required: ["name", "instructions"],
      oneOf: [
        {
          properties: {
            delivery: { const: "mailbox" },
            triggerTurn: { const: false },
          },
        },
        {
          properties: {
            delivery: { const: "nextTurn" },
            triggerTurn: { const: false },
          },
          required: ["delivery"],
        },
        {
          properties: { delivery: { enum: ["steer", "followUp"] } },
          required: ["delivery", "triggerTurn"],
        },
      ],
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
      "Steer Main, a running one-shot agent between turns, or a persistent actor through its mailbox. The stable id alias main targets the root user-facing Pi session. Non-local targets route over the project mesh.",
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
      "Queue a follow-up for Main or a running one-shot agent, or enqueue a persistent actor mailbox message. The stable id alias main targets the root user-facing Pi session. Non-local targets route over the project mesh.",
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
      "Set how queued steer messages are delivered to a running one-shot agent: all at once after the current turn, or one per turn (default). Local agent only.",
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
      "Set how queued follow-up messages are delivered to a one-shot agent: all when it finishes, or one per completion (default). Local agent only.",
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
    name: "setModel",
    description:
      "Change or clear a persistent actor's model override for its next activation without discarding its session trajectory",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, model: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "setThinking",
    description:
      "Change or clear a persistent actor's reasoning effort for its next activation",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, thinking: runProperties.thinking },
      required: ["id"],
      additionalProperties: false,
    },
    risk: "agent",
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
    description: "Replace a persistent actor's session-bound Pi and synthetic tool_error event subscriptions",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        events: {
          type: "array",
          items: {
            type: "string",
            enum: [...FABRIC_ACTOR_HOST_EVENTS],
          },
        },
      },
      required: ["id", "events"],
      additionalProperties: false,
    },
    risk: "agent",
  },
  {
    name: "setDeliveryPolicy",
    description:
      "Replace a project actor or global template delivery policy. steer/followUp require an explicit triggerTurn choice; mailbox/nextTurn require false.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        delivery: {
          type: "string",
          enum: ["mailbox", "steer", "followUp", "nextTurn"],
        },
        triggerTurn: { type: "boolean" },
        scope: { type: "string", enum: ["project", "global"] },
      },
      required: ["id", "delivery", "triggerTurn"],
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
      "Read an actor or agent run's LLM/agent log: the actor's session transcript (session.jsonl) and/or a retained run's event stream (events.jsonl: tool calls, model responses, usage). Actors retain their last runs so logs survive after success.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Actor ID/name or agent run ID" },
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
  const timeoutMs = longerTimeoutOverride(args.timeoutMs, manager);
  const validWhile = typeof args.validWhile === "object" && args.validWhile !== null &&
    !Array.isArray(args.validWhile) &&
    (args.validWhile as { version?: unknown }).version === 1 &&
    typeof (args.validWhile as { source?: unknown }).source === "string"
    ? { version: 1 as const, source: (args.validWhile as { source: string }).source }
    : undefined;
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
    ...(validWhile ? { validWhile } : {}),
  };
};

type AgentProgressStatus = ReturnType<AgentManager["status"]>;

const attachAgentToolPreview = (
  status: AgentProgressStatus,
  transcripts: AgentTranscriptReader,
  context: FabricInvocationContext,
  enabled: () => boolean,
  previousRevision?: string,
): string => {
  if (!context.attachPreview) return agentProgressRevision(status);
  try {
    const tools =
      enabled() && "logFile" in status && status.logFile
        ? recentTranscriptTools(
            transcripts.read({ id: status.id, status: status.status, logFile: status.logFile }),
            AGENT_PREVIEW_TOOL_LIMIT,
          )
        : [];
    const preview = {
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
  nestedToolsEnabled: () => boolean,
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
        nestedToolsEnabled,
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
      attachAgentToolPreview(status, transcripts, context, nestedToolsEnabled);
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
  nestedToolsEnabled: () => boolean,
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
            nestedToolsEnabled,
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
    if (worker) attachAgentToolPreview(worker, transcripts, context, nestedToolsEnabled);
  }
};

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
    readonly nestedToolsEnabled: () => boolean = () => true,
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

  async handoff(
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<Record<string, unknown>> {
    const model = typeof args.model === "string" ? args.model.trim() : "";
    if (!model) throw new Error("agents.handoff requires an explicit Pi target model");
    if (!context.deferHandoff) {
      throw new Error(
        "agents.handoff must be scheduled from inside fabric_exec and completed at its outer result boundary",
      );
    }
    return context.deferHandoff({ ...args, model });
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
    );
    request.runner = "pi";
    request.sessionSeed = sessionSeed;
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
      this.nestedToolsEnabled,
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
      case "handoff":
        return this.handoff(args, context);
      case "spawn": {
        const handle = await this.manager.spawn(
          runRequest(args, context, this.manager),
          context.signal,
        );
        this.manager.detachSignal(handle.id);
        this.participants.scheduleRefresh();
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
      case "cleanup":
        return this.manager.cleanup(String(args.id), args.deleteBranch === true);
      case "create": {
        if (args.scope === "global") {
          return this.globalActors.create(actorRequest(args, context, this.manager, false));
        }
        const actor = await this.actorManager.create(actorRequest(args, context, this.manager));
        this.participants.scheduleRefresh();
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
        return this.#localActor(String(args.id));
      case "actors":
        return args.scope === "global"
          ? this.globalActors.list()
          : this.actorManager
              .list()
              .filter((actor) => this.#actorIsLocal(actor.id));
      case "messages": {
        const actor = this.#localActor(String(args.id));
        return this.actorManager.messages(
          actor.id,
          typeof args.limit === "number" ? args.limit : 50,
        );
      }
      case "setModel":
        return this.actorManager.setModel(
          String(args.id),
          typeof args.model === "string" ? args.model : undefined,
        );
      case "setThinking":
        return this.actorManager.setThinking(
          String(args.id),
          typeof args.thinking === "string" ? args.thinking : undefined,
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
        const actor = this.#localActor(String(args.id));
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
          const actor = this.#localActor(id);
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
    options: { from?: MeshIdentity; triggerTurn?: boolean } = {},
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
        { message, data },
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
    try {
      const actor = this.actorManager.status(id);
      const ownership = this.participants.get(actor.id);
      if (!ownership || ownership.local) {
        context?.activity?.({ type: "entity", id: actor.id, kind: "actor", name: actor.name });
        const result = this.actorManager.tell(actor.id, message, data);
        return { queued: true, messageId: result.messageId, routed: "local" };
      }
    } catch (error) {
      if (!(error instanceof Error && /Unknown Fabric actor/.test(error.message))) throw error;
    }

    const participant = this.participants.get(id);
    if (!participant) throw new Error(`Unknown Fabric participant: ${id}`);
    if (!participant.capabilities.includes(kind)) {
      throw new Error(`Fabric participant ${id} does not support ${kind}`);
    }
    if (!this.control || participant.controlProtocol === "legacy") {
      return this.actorManager.steerRemote(id, message, kind, data);
    }
    return this.control.request(
      participant.ownerHostId,
      participant.id,
      kind,
      { message, data },
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
  ): Promise<FabricControlAcceptance> {
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
    if (this.mainAgent.local && this.mainAgent.matches(command.targetId)) {
      const result = this.mainAgent.deliverAgent({
        from,
        message,
        delivery: command.operation,
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
      const result = this.actorManager.tell(actor.id, message, command.data);
      return { accepted: true, messageId: result.messageId };
    } catch (error) {
      if (!(error instanceof Error && /Unknown Fabric actor/.test(error.message))) {
        return { accepted: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    return { accepted: false, error: `Owner does not control Fabric participant ${command.targetId}` };
  }

  #actorIsLocal(id: string): boolean {
    const participant = this.participants.get(id);
    return this.actorManager.owns(id) && participant?.local !== false;
  }

  #localActor(id: string): FabricActorInfo {
    const actor = this.actorManager.status(id);
    const participant = this.participants.get(actor.id);
    if (!this.actorManager.owns(actor.id) || participant?.local === false) {
      throw new Error(`Fabric actor private data is available only from its owner: ${actor.id}`);
    }
    return actor;
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
    return this.participants
      .list({ scope, kinds: ["agent"] })
      .map((participant) => local.get(participant.id) ?? participant);
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
    await this.lifecycle.close();
    try {
      await this.actorManager.close();
    } finally {
      await this.manager.close();
    }
  }
}
