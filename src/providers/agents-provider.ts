import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";
import { SubagentManager } from "../subagents/manager.js";
import type { SubagentRunRequest } from "../subagents/types.js";

const runProperties = {
  task: { type: "string", description: "A self-contained task for the child Pi agent" },
  name: { type: "string" },
  transport: {
    type: "string",
    enum: ["auto", "process", "tmux", "screen", "localterm"],
  },
  model: { type: "string" },
  thinking: {
    type: "string",
    enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  },
  tools: { type: "array", items: { type: "string" } },
  timeoutMs: { type: "number" },
  extensions: { type: "boolean" },
  recursive: { type: "boolean" },
  worktree: { type: "boolean" },
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
    description: "Run a child Pi agent and wait for its final result",
    inputSchema: runSchema,
    risk: "agent",
  },
  {
    name: "spawn",
    description: "Start a child Pi agent and return a handle immediately",
    inputSchema: runSchema,
    risk: "agent",
  },
  {
    name: "wait",
    description: "Wait for a previously spawned child Pi agent",
    inputSchema: idSchema,
    risk: "read",
  },
  {
    name: "status",
    description: "Get the latest status of a child Pi agent",
    inputSchema: idSchema,
    risk: "read",
  },
  {
    name: "list",
    description: "List child Pi agents created by this Fabric session",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  },
  {
    name: "stop",
    description: "Stop a running child Pi agent",
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
];

const stringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;

const runRequest = (
  args: Record<string, unknown>,
  context: FabricInvocationContext,
): SubagentRunRequest => {
  const transport =
    args.transport === "auto" ||
    args.transport === "process" ||
    args.transport === "tmux" ||
    args.transport === "screen" ||
    args.transport === "localterm"
      ? args.transport
      : undefined;
  const thinking =
    args.thinking === "off" ||
    args.thinking === "minimal" ||
    args.thinking === "low" ||
    args.thinking === "medium" ||
    args.thinking === "high" ||
    args.thinking === "xhigh" ||
    args.thinking === "max"
      ? args.thinking
      : undefined;
  const tools = stringArray(args.tools);
  const inheritedModel = context.extensionContext.model
    ? `${context.extensionContext.model.provider}/${context.extensionContext.model.id}`
    : undefined;
  return {
    task: String(args.task),
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
        progressTimer = setTimeout(
          () => resolve({ done: false }),
          AGENT_PROGRESS_INTERVAL_MS,
        );
      }),
    ]);
    if (progressTimer) clearTimeout(progressTimer);
    if (settled.done) return settled.value;
    const status = manager.status(id);
    const currentTool = "currentTool" in status && status.currentTool ? ` · ${status.currentTool}` : "";
    context.update(`Agent ${id.slice(0, 8)}: ${status.status}${currentTool}`);
  }
};

export class AgentsProvider implements FabricProvider {
  readonly name = "agents";
  readonly description = "Guarded child Pi agents over process, tmux, screen, or LocalTerm";

  constructor(readonly manager: SubagentManager) {}

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
        const handle = await this.manager.spawn(runRequest(args, context), context.signal);
        context.update(
          `Agent ${handle.id.slice(0, 8)} started via ${handle.transport}${handle.attachCommand ? ` · ${handle.attachCommand}` : ""}`,
        );
        return waitWithProgress(this.manager, handle.id, context);
      }
      case "spawn": {
        const handle = await this.manager.spawn(runRequest(args, context), context.signal);
        this.manager.detachSignal(handle.id);
        context.update(
          `Agent ${handle.id.slice(0, 8)} started via ${handle.transport}${handle.attachCommand ? ` · ${handle.attachCommand}` : ""}`,
        );
        return handle;
      }
      case "wait":
        return waitWithProgress(this.manager, String(args.id), context);
      case "status":
        return this.manager.status(String(args.id));
      case "list":
        return this.manager.list();
      case "stop":
        return this.manager.stop(String(args.id));
      case "cleanup":
        return this.manager.cleanup(String(args.id), args.deleteBranch === true);
      default:
        throw new Error(`Unknown agents action: ${actionName}`);
    }
  }

  async close(): Promise<void> {
    await this.manager.close();
  }
}
