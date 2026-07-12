import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
  FabricRisk,
} from "../protocol.js";
import { CapturedToolsProvider } from "./captured-tools-provider.js";

type PiToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

const readTools = new Set<PiToolName>(["read", "grep", "find", "ls"]);
const writeTools = new Set<PiToolName>(["edit", "write"]);

const riskForTool = (name: PiToolName): FabricRisk => {
  if (readTools.has(name)) return "read";
  if (writeTools.has(name)) return "write";
  return "execute";
};

const textContent = (content: Array<{ type: string; text?: string }>): string =>
  content
    .filter((part): part is { type: string; text: string } => typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");

const normalizeResult = (
  name: PiToolName,
  result: {
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
    isError?: boolean;
  },
): unknown => {
  const text = textContent(result.content);
  if (result.isError) throw new Error(text || `${name} failed`);
  if (name === "read" || name === "grep" || name === "find" || name === "ls") {
    return text;
  }
  return {
    ok: true,
    output: text,
    details: result.details ?? null,
  };
};

export class PiToolsProvider implements FabricProvider {
  readonly name = "pi";
  readonly description = "Pi's built-in coding tools";
  readonly #tools: Record<PiToolName, ToolDefinition<any, any, any>>;

  constructor(
    cwd: string,
    readonly capturedTools?: CapturedToolsProvider,
  ) {
    this.#tools = {
      read: createReadToolDefinition(cwd),
      bash: createBashToolDefinition(cwd),
      edit: createEditToolDefinition(cwd),
      write: createWriteToolDefinition(cwd),
      grep: createGrepToolDefinition(cwd),
      find: createFindToolDefinition(cwd),
      ls: createLsToolDefinition(cwd),
    };
  }

  async list(
    request: FabricProviderListRequest,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor[]> {
    const query = request.query?.toLowerCase();
    const descriptors = await Promise.all(
      Object.keys(this.#tools).map((name) => this.describe(name, _context)),
    );
    return descriptors
      .filter((descriptor): descriptor is FabricActionDescriptor => descriptor !== undefined)
      .filter((descriptor) =>
        query ? `${descriptor.name} ${descriptor.description}`.toLowerCase().includes(query) : true,
      );
  }

  async describe(
    actionName: string,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor | undefined> {
    if (!(actionName in this.#tools)) return undefined;
    const name = actionName as PiToolName;
    const override = await this.capturedTools?.describe(name, _context);
    if (override) return { ...override, namespace: "extension-override" };
    const tool = this.#tools[name];
    return this.#descriptor(name, tool);
  }

  prepareArguments(actionName: string, args: Record<string, unknown>): Record<string, unknown> {
    if (this.capturedTools?.catalog.get(actionName)) {
      return this.capturedTools.prepareArguments(actionName, args);
    }
    if (!(actionName in this.#tools)) return args;
    const prepare = this.#tools[actionName as PiToolName].prepareArguments;
    if (!prepare) return args;
    const prepared = prepare(args);
    if (typeof prepared !== "object" || prepared === null || Array.isArray(prepared)) {
      throw new Error(`Pi tool ${actionName} prepared non-object arguments`);
    }
    return prepared as Record<string, unknown>;
  }

  async invoke(
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<unknown> {
    if (!(actionName in this.#tools)) throw new Error(`Unknown Pi tool: ${actionName}`);
    const name = actionName as PiToolName;
    if (this.capturedTools?.catalog.get(name)) {
      const result = await this.capturedTools.invoke(name, args, context);
      return normalizeResult(name, result);
    }
    const tool = this.#tools[name];
    const result = await tool.execute(
      context.nestedToolCallId,
      args,
      context.signal,
      undefined,
      context.extensionContext,
    );
    return normalizeResult(name, result);
  }

  #descriptor(name: PiToolName, tool: ToolDefinition<any, any, any>): FabricActionDescriptor {
    return {
      name,
      description: tool.description,
      inputSchema: tool.parameters as unknown as Record<string, unknown>,
      risk: riskForTool(name),
      namespace: "builtin",
    };
  }
}
