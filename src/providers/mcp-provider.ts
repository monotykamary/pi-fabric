import path from "node:path";
import {
  createRuntime,
  type Runtime,
  type ServerDefinition,
  type ServerToolInfo,
} from "mcporter";
import type { FabricMcpConfig } from "../config.js";
import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
} from "../protocol.js";

const emptyObjectSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const managementDescriptors: FabricActionDescriptor[] = [
  {
    name: "$servers",
    description: "List MCP servers discovered by mcporter",
    inputSchema: emptyObjectSchema,
    risk: "read",
    namespace: "management",
  },
  {
    name: "$reload",
    description: "Close MCP connections and reload mcporter configuration",
    inputSchema: emptyObjectSchema,
    risk: "network",
    namespace: "management",
  },
  {
    name: "$register",
    description: "Register an ephemeral MCP server in the pooled mcporter runtime",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        baseUrl: { type: "string" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        env: { type: "object", additionalProperties: { type: "string" } },
        overwrite: { type: "boolean" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    risk: "execute",
    namespace: "management",
  },
  {
    name: "$call",
    description: "Call an MCP tool by explicit server and tool name",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string" },
        tool: { type: "string" },
        args: { type: "object", additionalProperties: true },
      },
      required: ["server", "tool"],
      additionalProperties: false,
    },
    risk: "network",
    namespace: "management",
  },
];

const normalizeSchema = (schema: unknown): Record<string, unknown> =>
  typeof schema === "object" && schema !== null && !Array.isArray(schema)
    ? (schema as Record<string, unknown>)
    : emptyObjectSchema;

const normalizeMcpResult = (result: unknown): unknown => {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  if (!Array.isArray(record.content)) return result;
  const text = record.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as Record<string, unknown>).type === "text" &&
        typeof (part as Record<string, unknown>).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
  if (record.isError === true) throw new Error(text || "MCP tool returned an error");
  return {
    text,
    content: record.content,
    structuredContent: record.structuredContent ?? null,
  };
};

export class McpProvider implements FabricProvider {
  readonly name = "mcp";
  readonly description = "External MCP tools discovered and pooled by mcporter";
  #runtime: Runtime | undefined;

  constructor(
    readonly cwd: string,
    readonly config: FabricMcpConfig,
  ) {}

  async list(
    request: FabricProviderListRequest,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor[]> {
    if (!this.config.enabled) return [];
    const runtime = await this.#getRuntime();
    const servers = request.namespace ? [request.namespace] : runtime.listServers();
    const settled = await Promise.allSettled(
      servers.map(async (server) => {
        const tools = await runtime.listTools(server, {
          includeSchema: true,
          disableOAuth: this.config.disableOAuth,
        });
        return tools.map((tool) => this.#toolDescriptor(server, tool));
      }),
    );
    const descriptors = settled.flatMap((entry) =>
      entry.status === "fulfilled" ? entry.value : [],
    );
    const query = request.query?.toLowerCase();
    const filtered = query
      ? descriptors.filter((descriptor) =>
          `${descriptor.name} ${descriptor.description}`.toLowerCase().includes(query),
        )
      : descriptors;
    return request.namespace ? filtered : [...managementDescriptors, ...filtered];
  }

  async describe(
    actionName: string,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor | undefined> {
    const management = managementDescriptors.find((descriptor) => descriptor.name === actionName);
    if (management) return management;
    const parsed = this.#parseToolName(actionName);
    if (!parsed || !this.config.enabled) return undefined;
    const runtime = await this.#getRuntime();
    const server = this.#resolveServerName(runtime, parsed.server);
    if (!server) return undefined;
    const tools = await runtime.listTools(server, {
      includeSchema: true,
      disableOAuth: this.config.disableOAuth,
    });
    const tool = this.#resolveTool(tools, parsed.tool);
    return tool ? this.#toolDescriptor(server, tool) : undefined;
  }

  async invoke(
    actionName: string,
    args: Record<string, unknown>,
    _context: FabricInvocationContext,
  ): Promise<unknown> {
    if (!this.config.enabled) throw new Error("MCP support is disabled in Fabric configuration");
    if (actionName === "$servers") {
      const runtime = await this.#getRuntime();
      return runtime.listServers().map((server) => {
        const definition = runtime.getDefinition(server);
        return {
          name: server,
          description: definition.description ?? null,
          transport: definition.command.kind,
        };
      });
    }
    if (actionName === "$reload") {
      await this.#resetRuntime();
      return { servers: (await this.#getRuntime()).listServers() };
    }
    if (actionName === "$register") {
      if (!this.config.allowDynamicServers) {
        throw new Error("Dynamic MCP server registration is disabled in Fabric configuration");
      }
      const definition = this.#serverDefinition(args);
      const runtime = await this.#getRuntime();
      runtime.registerDefinition(definition, { overwrite: args.overwrite === true });
      return { registered: definition.name };
    }
    if (actionName === "$call") {
      const server = String(args.server);
      const tool = String(args.tool);
      const toolArgs =
        typeof args.args === "object" && args.args !== null && !Array.isArray(args.args)
          ? (args.args as Record<string, unknown>)
          : {};
      return this.#call(server, tool, toolArgs);
    }
    const parsed = this.#parseToolName(actionName);
    if (!parsed) throw new Error(`Invalid MCP action: ${actionName}`);
    return this.#call(parsed.server, parsed.tool, args);
  }

  async close(): Promise<void> {
    await this.#resetRuntime();
  }

  async #call(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const runtime = await this.#getRuntime();
    const server = this.#resolveServerName(runtime, serverName);
    if (!server) throw new Error(`Unknown MCP server: ${serverName}`);
    const tools = await runtime.listTools(server, {
      includeSchema: true,
      disableOAuth: this.config.disableOAuth,
    });
    const tool = this.#resolveTool(tools, toolName);
    if (!tool) throw new Error(`Unknown MCP tool: ${serverName}.${toolName}`);
    const result = await runtime.callTool(server, tool.name, {
      args,
      timeoutMs: this.config.callTimeoutMs,
      disableOAuth: this.config.disableOAuth,
    });
    return normalizeMcpResult(result);
  }

  async #getRuntime(): Promise<Runtime> {
    if (!this.#runtime) {
      this.#runtime = await createRuntime({
        rootDir: this.cwd,
        ...(this.config.configPath ? { configPath: this.config.configPath } : {}),
        clientInfo: { name: "pi-fabric", version: "0.1.0" },
      });
    }
    return this.#runtime;
  }

  async #resetRuntime(): Promise<void> {
    const runtime = this.#runtime;
    this.#runtime = undefined;
    await runtime?.close();
  }

  #serverDefinition(args: Record<string, unknown>): ServerDefinition {
    const name = String(args.name ?? "").trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
      throw new Error("Dynamic MCP server names may contain letters, numbers, dots, underscores, and hyphens");
    }
    const description = typeof args.description === "string" ? args.description : undefined;
    const env = this.#stringRecord(args.env);
    if (typeof args.command === "string" && args.command.trim()) {
      const commandArgs = Array.isArray(args.args)
        ? args.args.filter((value): value is string => typeof value === "string")
        : [];
      return {
        name,
        ...(description ? { description } : {}),
        command: {
          kind: "stdio",
          command: args.command,
          args: commandArgs,
          cwd: path.resolve(this.cwd, typeof args.cwd === "string" ? args.cwd : "."),
        },
        ...(env ? { env } : {}),
      };
    }
    if (typeof args.baseUrl === "string" && args.baseUrl.trim()) {
      const headers = this.#stringRecord(args.headers);
      return {
        name,
        ...(description ? { description } : {}),
        command: {
          kind: "http",
          url: new URL(args.baseUrl),
          ...(headers ? { headers } : {}),
        },
        ...(env ? { env } : {}),
      };
    }
    throw new Error("Dynamic MCP registration requires either command or baseUrl");
  }

  #stringRecord(value: unknown): Record<string, string> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const entries = Object.entries(value);
    if (entries.some((entry) => typeof entry[1] !== "string")) {
      throw new Error("MCP environment and header values must be strings");
    }
    return Object.fromEntries(entries) as Record<string, string>;
  }

  #resolveServerName(runtime: Runtime, requested: string): string | undefined {
    const servers = runtime.listServers();
    if (servers.includes(requested)) return requested;
    const matches = servers.filter((server) => this.#sanitizeName(server) === requested);
    return matches.length === 1 ? matches[0] : undefined;
  }

  #resolveTool(tools: ServerToolInfo[], requested: string): ServerToolInfo | undefined {
    return (
      tools.find((tool) => tool.name === requested) ??
      tools.find((tool) => this.#sanitizeName(tool.name) === requested)
    );
  }

  #sanitizeName(value: string): string {
    const sanitized = value.replace(/[^A-Za-z0-9_$]/g, "_");
    return /^[A-Za-z_$]/.test(sanitized) ? sanitized : `_${sanitized}`;
  }

  #parseToolName(actionName: string): { server: string; tool: string } | undefined {
    const separator = actionName.indexOf(".");
    if (separator <= 0 || separator === actionName.length - 1) return undefined;
    return { server: actionName.slice(0, separator), tool: actionName.slice(separator + 1) };
  }

  #toolDescriptor(server: string, tool: ServerToolInfo): FabricActionDescriptor {
    return {
      name: `${server}.${tool.name}`,
      description: tool.description ?? `${tool.name} on MCP server ${server}`,
      inputSchema: normalizeSchema(tool.inputSchema),
      ...(tool.outputSchema ? { outputSchema: normalizeSchema(tool.outputSchema) } : {}),
      risk: "network",
      namespace: server,
    };
  }
}
