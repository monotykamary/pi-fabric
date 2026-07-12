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

  constructor(cwd: string) {
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
    return Object.entries(this.#tools)
      .filter(([name, tool]) =>
        query ? `${name} ${tool.description}`.toLowerCase().includes(query) : true,
      )
      .map(([name, tool]) => this.#descriptor(name as PiToolName, tool));
  }

  async describe(
    actionName: string,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor | undefined> {
    if (!(actionName in this.#tools)) return undefined;
    const name = actionName as PiToolName;
    const tool = this.#tools[name];
    return this.#descriptor(name, tool);
  }

  async invoke(
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<unknown> {
    if (!(actionName in this.#tools)) throw new Error(`Unknown Pi tool: ${actionName}`);
    const name = actionName as PiToolName;
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
