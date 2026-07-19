import { ActorManager } from "../actors/manager.js";
import { GlobalActorRegistry } from "../actors/global-registry.js";
import type { FabricActorHostEvent, FabricActorRequest } from "../actors/types.js";
import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";
import { SubagentManager } from "../subagents/manager.js";
import type { SubagentRunRequest } from "../subagents/types.js";
import { isFabricThinking } from "../thinking.js";

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
    enum: ["auto", "process", "tmux", "screen", "localterm"],
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
  timeoutMs: { type: "number" },
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
        timeoutMs: { type: "number" },
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
      "Steer a running one-shot subagent between its turns (preserving its context), or enqueue a message for a persistent actor. Routes to a local subagent/actor directly; for an id not local to this process, publishes a fabric.steer mesh event the owning process relays. Any Fabric-equipped agent can steer any other.",
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
      "Queue a message for a one-shot subagent that is delivered only after the agent finishes, or enqueue a message for a persistent actor. Routes locally first, then over the fabric.steer mesh for a non-local id.",
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
    args.transport === "localterm"
      ? args.transport
      : undefined;
  const thinking = isFabricThinking(args.thinking) ? args.thinking : undefined;
  const tools = stringArray(args.tools);
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
    ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
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
    args.transport === "localterm"
      ? { transport: args.transport }
      : {}),
    ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
  };
};

const waitWithProgress = async (
  manager: SubagentManager,
  id: string,
  context: FabricInvocationContext,
): Promise<unknown> => {
  const result = manager.wait(id);
  while (true) {
    let progressTimer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      result.then((value) => ({ done: true as const, value })),
      new Promise<{ done: false }>((resolve) => {
        progressTimer = setTimeout(() => resolve({ done: false }), AGENT_PROGRESS_INTERVAL_MS);
      }),
    ]);
    if (progressTimer) clearTimeout(progressTimer);
    if (settled.done) {
      context.activity?.({
        type: "metrics",
        tokens: settled.value.usage.input + settled.value.usage.output,
        toolCalls: settled.value.toolCalls,
        cost: settled.value.usage.cost,
      });
      return settled.value;
    }
    const status = manager.status(id);
    const currentTool =
      "currentTool" in status && status.currentTool ? ` · ${status.currentTool}` : "";
    context.update(`Agent ${id.slice(0, 8)}: ${status.status}${currentTool}`);
    if ("usage" in status) {
      context.activity?.({
        type: "metrics",
        tokens: status.usage.input + status.usage.output,
        toolCalls: status.toolCalls,
        cost: status.usage.cost,
      });
    }
  }
};

export class AgentsProvider implements FabricProvider {
  readonly name = "agents";
  readonly description =
    "One-shot Pi or Claude Code agents and persistent mailbox actors over process, tmux, screen, or LocalTerm";

  constructor(
    readonly manager: SubagentManager,
    readonly actorManager: ActorManager,
    readonly globalActors: GlobalActorRegistry,
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
          `Agent ${handle.id.slice(0, 8)} started via ${handle.runner}/${handle.transport}${handle.attachCommand ? ` · ${handle.attachCommand}` : ""}`,
        );
        return waitWithProgress(this.manager, handle.id, context);
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
          `Agent ${handle.id.slice(0, 8)} started via ${handle.runner}/${handle.transport}${handle.attachCommand ? ` · ${handle.attachCommand}` : ""}`,
        );
        return handle;
      }
      case "wait": {
        const id = String(args.id);
        const status = this.manager.status(id);
        context.activity?.({ type: "entity", id, kind: "agent", name: status.name });
        return waitWithProgress(this.manager, id, context);
      }
      case "status":
        return this.manager.status(String(args.id));
      case "list":
        return this.manager.list();
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
        return this.actorManager.ask(actor.id, String(args.message), args.data, context.signal);
      }
      case "tell": {
        const actor = this.actorManager.status(String(args.id));
        context.activity?.({ type: "entity", id: actor.id, kind: "actor", name: actor.name });
        return this.actorManager.tell(actor.id, String(args.message), args.data);
      }
      case "steer":
        return this.#steer(String(args.id), String(args.message), args.data, "steer", context);
      case "followUp":
        return this.#steer(String(args.id), String(args.message), args.data, "followUp", context);
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

  async #steer(
    id: string,
    message: string,
    data: unknown,
    kind: "steer" | "followUp",
    context: FabricInvocationContext,
  ): Promise<{ queued: true; messageId: string; routed: "local" | "mesh" }> {
    // Local one-shot subagent: forward between its turns via the worker's
    // steer.jsonl channel, preserving the child's accumulated context.
    try {
      const status = this.manager.status(id);
      context.activity?.({ type: "entity", id, kind: "agent", name: status.name });
      const result =
        kind === "steer"
          ? this.manager.steer(id, message, data)
          : this.manager.followUp(id, message, data);
      return { queued: true, messageId: result.messageId, routed: "local" };
    } catch (error) {
      if (!(error instanceof Error && /Unknown Fabric subagent/.test(error.message))) throw error;
    }
    // Local persistent actor: enqueue a mailbox message (steer == followUp for
    // an actor's serial queue).
    try {
      const actor = this.actorManager.status(id);
      context.activity?.({ type: "entity", id: actor.id, kind: "actor", name: actor.name });
      const result = this.actorManager.tell(actor.id, message, data);
      return { queued: true, messageId: result.messageId, routed: "local" };
    } catch (error) {
      if (!(error instanceof Error && /Unknown Fabric actor/.test(error.message))) throw error;
    }
    // Cross-process: publish a fabric.steer mesh event the owning process
    // relays to its local target. Best-effort; a target no process owns is dropped.
    const remote = await this.actorManager.steerRemote(id, message, kind, data);
    return { queued: true, messageId: remote.messageId, routed: "mesh" };
  }

  #steeringMode(mode: unknown): "all" | "one-at-a-time" {
    if (mode === "all" || mode === "one-at-a-time") return mode;
    throw new Error(
      `Invalid steering mode: ${String(mode)} (expected "all" or "one-at-a-time")`,
    );
  }

  async close(): Promise<void> {
    await this.actorManager.close();
    await this.manager.close();
  }
}
