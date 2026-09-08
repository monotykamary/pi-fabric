import path from "node:path";
import type {
  Runtime,
  ServerDefinition,
  ServerToolInfo,
} from "mcporter";
import type { FabricMcpConfig } from "../config.js";
import type {
  FabricActionDescriptor,
  FabricInvocationContext,
  FabricProvider,
  FabricProviderListRequest,
  FabricToolAnnotations,
} from "../protocol.js";
import { sanitizeMcpRefPart } from "../ref-names.js";
import {
  hashServerDefinition,
  MCP_DESCRIPTOR_CACHE_VERSION,
  type McpConfigLayerStat,
  McpDescriptorCacheStore,
  parseCachedServer,
  sameConfigLayers,
  statConfigLayers,
  type CachedMcpServer,
} from "./mcp-descriptor-cache.js";

const TOOL_METADATA_TTL_MS = 60_000;
const REVALIDATE_CONCURRENCY = 3;
const REVALIDATE_SERVER_TIMEOUT_MS = 20_000;
const MIN_REVALIDATE_SERVER_TIMEOUT_MS = 5_000;
const NOTIFY_DEBOUNCE_MS = 100;
const PERSIST_DEBOUNCE_MS = 150;

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

export interface McpProviderHooks {
  /** Full provider-fidelity descriptor slice after any tool-list change. */
  onSliceChanged?: (descriptors: FabricActionDescriptor[]) => void;
}

export interface HostedMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: FabricToolAnnotations;
}

/** Authorized metadata and transport only; never configuration or credentials. */
export interface HostedMcpSource {
  listServers(): string[];
  listTools(server: string): Promise<HostedMcpTool[]>;
  callTool(server: string, tool: string, options: {
    args: Record<string, unknown>;
    signal?: AbortSignal;
    timeoutMs?: number;
    disableOAuth?: boolean;
  }): Promise<unknown>;
  close?(server?: string): Promise<void>;
}

type ToolRuntime = Pick<Runtime, "listServers" | "listTools" | "callTool" | "close"> | HostedMcpSource;

export interface McpProviderOptions {
  source?: HostedMcpSource;
  cache?: McpDescriptorCacheStore;
  hooks?: McpProviderHooks;
}

interface WorkingServer {
  definitionHash: string;
  transport: string;
  description: string | null;
  fetchedAt: string;
  stale: boolean;
  ephemeral: boolean;
  tools: ServerToolInfo[];
}

interface PendingServer {
  definitionHash: string;
  transport: string;
  description: string | null;
  ephemeral: boolean;
}

const withTimeout = <T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`MCP server listing timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

export class McpProvider implements FabricProvider {
  readonly name = "mcp";
  readonly description = "External MCP tools discovered and pooled by mcporter";
  #runtime: Runtime | undefined;
  #runtimeCreation: { generation: number; promise: Promise<Runtime> } | undefined;
  readonly #toolMetadata = new Map<
    string,
    { expiresAt: number; promise: Promise<ServerToolInfo[]> }
  >();

  readonly #source: HostedMcpSource | undefined;
  readonly #store: McpDescriptorCacheStore | undefined;
  readonly #hooks: McpProviderHooks;
  #generation = 0;
  #closed = false;
  #hydration: Promise<void> | undefined;
  #layerStats: McpConfigLayerStat[] = [];
  readonly #servers = new Map<string, WorkingServer>();
  readonly #pending = new Map<string, PendingServer>();
  readonly #revalidateQueue: string[] = [];
  readonly #revalidateQueued = new Set<string>();
  readonly #recontacted = new Set<string>();
  #revalidating: Promise<void> | undefined;
  #autoKicked = false;
  #dirtyPersist = false;
  #dirtyNotify = false;
  #persistTimer: NodeJS.Timeout | undefined;
  #notifyTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly cwd: string,
    readonly config: FabricMcpConfig,
    options: McpProviderOptions = {},
  ) {
    this.#source = options.source;
    this.#store = options.source ? undefined : options.cache;
    this.#hooks = options.hooks ?? {};
  }

  get #cacheOn(): boolean {
    return !this.#source && this.config.cache.enabled;
  }

  async list(
    request: FabricProviderListRequest,
    context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor[]> {
    if (!this.config.enabled) return [];
    if (!this.#cacheOn) return this.#listLegacy(request, context);
    await this.#hydrate();
    this.#kickRevalidation();
    const query = request.query?.toLowerCase();
    const filterQuery = (descriptors: FabricActionDescriptor[]): FabricActionDescriptor[] =>
      query
        ? descriptors.filter((descriptor) =>
            `${descriptor.name} ${descriptor.description}`.toLowerCase().includes(query),
          )
        : descriptors;
    if (request.namespace) {
      const server = await this.#resolveKnownServer(request.namespace);
      if (!server) return [];
      let entry = this.#servers.get(server);
      if (!entry) {
        // Explicit namespaced probe of an unlisted server: bounded live fetch
        // of exactly that server.
        entry = await this.#fetchServerTools(server).catch(() => undefined);
        if (!entry) return [];
      }
      return filterQuery(entry.tools.map((tool) => this.#toolDescriptor(server, tool)));
    }
    return [
      ...managementDescriptors,
      ...filterQuery(this.sliceDescriptors()),
    ];
  }

  async describe(
    actionName: string,
    context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor | undefined> {
    const management = managementDescriptors.find((descriptor) => descriptor.name === actionName);
    if (management) {
      if (this.#source) throw new Error("MCP management is unavailable for a hosted source");
      return management;
    }
    if (!this.config.enabled) return undefined;
    if (!this.#cacheOn) {
      const descriptor = await this.#describeLegacy(actionName, context);
      // Hosted identities are authority, not spelling suggestions. Prevent registry repair
      // from turning an unknown source/tool (including ambiguous aliases) into a call.
      if (this.#source && !descriptor) throw new Error(`Unknown hosted MCP action: ${actionName}`);
      return descriptor;
    }
    const parsed = this.#parseToolName(actionName);
    if (!parsed) return undefined;
    await this.#hydrate();
    const server = await this.#resolveKnownServer(parsed.server);
    if (!server) return undefined;
    let entry = this.#servers.get(server);
    let tool = entry ? this.#resolveTool(entry.tools, parsed.tool) : undefined;
    if (!tool) {
      entry = await this.#fetchServerTools(server).catch(() => undefined);
      tool = entry ? this.#resolveTool(entry.tools, parsed.tool) : undefined;
    }
    if (entry?.stale) this.#scheduleRevalidate([server]);
    return tool ? this.#toolDescriptor(server, tool) : undefined;
  }

  async invoke(
    actionName: string,
    args: Record<string, unknown>,
    context: FabricInvocationContext,
  ): Promise<unknown> {
    if (!this.config.enabled) throw new Error("MCP support is disabled in Fabric configuration");
    if (this.#source && actionName.startsWith("$")) {
      throw new Error("MCP management is unavailable for a hosted source");
    }
    if (actionName === "$servers") {
      const runtime = await this.#getRuntime();
      return runtime.listServers().map((server) => {
        const definition = runtime.getDefinition(server);
        if (!this.#cacheOn) {
          return {
            name: server,
            description: definition.description ?? null,
            transport: definition.command.kind,
          };
        }
        const entry = this.#servers.get(server);
        return {
          name: server,
          description: definition.description ?? null,
          transport: definition.command.kind,
          tools: entry?.tools.length ?? 0,
          stale: entry === undefined || entry.stale,
        };
      });
    }
    if (actionName === "$reload") {
      await this.#resetRuntime();
      if (this.#cacheOn) {
        this.#servers.clear();
        this.#pending.clear();
        this.#recontacted.clear();
        this.#hydration = undefined;
        await this.#hydrate();
        this.#kickRevalidation(true);
      }
      return { servers: (await this.#getRuntime()).listServers() };
    }
    if (actionName === "$register") {
      if (!this.config.allowDynamicServers) {
        throw new Error("Dynamic MCP server registration is disabled in Fabric configuration");
      }
      const definition = this.#serverDefinition(args);
      const runtime = await this.#getRuntime();
      runtime.registerDefinition(definition, { overwrite: args.overwrite === true });
      this.#toolMetadata.delete(definition.name);
      if (this.#cacheOn) {
        // Ephemeral overlay: discoverable immediately, never persisted.
        void this.#hydrate()
          .then(() => {
            this.#servers.delete(definition.name);
            this.#pending.set(definition.name, {
              definitionHash: hashServerDefinition(definition),
              transport: definition.command.kind,
              description: definition.description ?? null,
              ephemeral: true,
            });
            this.#scheduleRevalidate([definition.name]);
          })
          .catch(() => undefined);
      }
      return { registered: definition.name };
    }
    if (actionName === "$call") {
      const server = String(args.server);
      const tool = String(args.tool);
      const toolArgs =
        typeof args.args === "object" && args.args !== null && !Array.isArray(args.args)
          ? (args.args as Record<string, unknown>)
          : {};
      return this.#call(server, tool, toolArgs, context.signal);
    }
    const parsed = this.#parseToolName(actionName);
    if (!parsed) throw new Error(`Invalid MCP action: ${actionName}`);
    return this.#call(parsed.server, parsed.tool, args, context.signal);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#source?.close?.();
    this.#revalidateQueue.length = 0;
    this.#revalidateQueued.clear();
    if (this.#notifyTimer) clearTimeout(this.#notifyTimer);
    if (this.#persistTimer) clearTimeout(this.#persistTimer);
    this.#notifyTimer = undefined;
    this.#persistTimer = undefined;
    if (this.#dirtyPersist) await this.#persistNow().catch(() => undefined);
    await this.#resetRuntime();
  }

  // Fire-and-forget session warm-up: hydrate from the descriptor cache, then
  // start the background revalidation policy. Never awaited by session start.
  warmup(): void {
    if (!this.config.enabled || !this.#cacheOn) return;
    void this.#hydrate()
      .then(() => this.#kickRevalidation())
      .catch(() => undefined);
  }

  // Provider-fidelity descriptors for everything currently known, cached or
  // ephemeral.
  sliceDescriptors(): FabricActionDescriptor[] {
    const descriptors: FabricActionDescriptor[] = [];
    for (const [server, entry] of this.#servers) {
      for (const tool of entry.tools) descriptors.push(this.#toolDescriptor(server, tool));
    }
    return descriptors;
  }

  // Test/ops hook: await hydration and any in-flight background revalidation,
  // then flush pending persistence and notifications.
  async settle(): Promise<void> {
    await this.#hydrate();
    while (this.#revalidating) await this.#revalidating;
    if (this.#notifyTimer) {
      clearTimeout(this.#notifyTimer);
      this.#notifyTimer = undefined;
    }
    if (this.#dirtyNotify) this.#notifyNow();
    if (this.#persistTimer) {
      clearTimeout(this.#persistTimer);
      this.#persistTimer = undefined;
    }
    if (this.#dirtyPersist) await this.#persistNow().catch(() => undefined);
  }

  async #call(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.#cacheOn) return this.#callLegacy(serverName, toolName, args, signal);
    if (signal?.aborted) throw new Error("MCP call cancelled");
    await this.#hydrate();
    const server = await this.#resolveKnownServer(serverName);
    if (!server) throw new Error(`Unknown MCP server: ${serverName}`);
    let entry = this.#servers.get(server);
    let tool = entry ? this.#resolveTool(entry.tools, toolName) : undefined;
    if (!tool) {
      entry = await this.#fetchServerTools(server).catch(() => undefined);
      tool = entry ? this.#resolveTool(entry.tools, toolName) : undefined;
    }
    if (signal?.aborted) throw new Error("MCP call cancelled");
    if (!tool) throw new Error(`Unknown MCP tool: ${serverName}.${toolName}`);
    const runtime = await this.#getRuntime();
    const firstContact = !this.#recontacted.has(server);
    if (firstContact) this.#recontacted.add(server);
    const operation = runtime.callTool(server, tool.name, {
      args,
      timeoutMs: this.config.callTimeoutMs,
      disableOAuth: this.config.disableOAuth,
    });
    try {
      const result = await this.#withAbort(operation, signal, () => runtime.close(server));
      return normalizeMcpResult(result);
    } catch (error) {
      // A failed call is fresh evidence the cached metadata may be wrong.
      const existing = this.#servers.get(server);
      if (existing) {
        existing.stale = true;
        this.#schedulePersist();
        this.#scheduleNotify();
      }
      this.#scheduleRevalidate([server]);
      throw error;
    } finally {
      // Revalidate the moment the server is connected: the pooled connection
      // makes the relist essentially free, and public servers drifting under
      // us get picked up within the session that observed them.
      if (firstContact) this.#scheduleRevalidate([server]);
    }
  }

  async #withAbort<T>(
    operation: Promise<T>,
    signal: AbortSignal | undefined,
    abort: () => void | Promise<void>,
  ): Promise<T> {
    if (!signal) return operation;
    if (signal.aborted) throw new Error("MCP call cancelled");
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        void Promise.resolve(abort()).catch(() => undefined);
        reject(new Error("MCP call cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void operation.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  // Session-opening hydration: adopt the persisted descriptor cache. Never
  // spawns a server — config-only operations at worst.
  #hydrate(): Promise<void> {
    if (!this.#cacheOn) return Promise.resolve();
    this.#hydration ??= this.#hydrateInternal().catch(() => undefined);
    return this.#hydration;
  }

  async #hydrateInternal(): Promise<void> {
    const generation = this.#generation;
    const snapshot = this.#store ? await this.#store.load().catch(() => undefined) : undefined;
    this.#layerStats = await statConfigLayers(this.cwd, this.config.configPath);
    if (generation !== this.#generation) return;
    if (snapshot && sameConfigLayers(snapshot.layers, this.#layerStats)) {
      // Config untouched since the cache was written: adopt wholesale,
      // without even constructing the mcporter runtime.
      for (const [name, raw] of Object.entries(snapshot.servers)) {
        const parsed = parseCachedServer(raw);
        if (parsed) this.#servers.set(name, this.#toWorking(parsed, false));
      }
      this.#scheduleNotify();
      return;
    }
    try {
      // Config changed (or first run): resolve definitions — still without
      // connecting — and keep cached tools for servers whose definition is
      // byte-identical to the one that produced the cache entry.
      const runtime = await this.#getRuntime();
      for (const definition of runtime.getDefinitions()) {
        const hash = hashServerDefinition(definition);
        const recorded = snapshot?.servers[definition.name];
        const parsed = recorded ? parseCachedServer(recorded) : undefined;
        if (parsed && parsed.definitionHash === hash) {
          this.#servers.set(definition.name, this.#toWorking(parsed, false));
        } else {
          const existing = this.#pending.get(definition.name);
          this.#pending.set(definition.name, {
            definitionHash: hash,
            transport: definition.command.kind,
            description: definition.description ?? null,
            ephemeral: existing?.ephemeral ?? false,
          });
        }
      }
      // Servers dropped from the config are dropped from the cache.
      this.#dirtyPersist = true;
      this.#schedulePersist();
    } catch {
      // Config currently unreadable (parse error mid-edit): fall back to
      // last-known-good descriptors rather than blanking the provider.
      if (snapshot) {
        for (const [name, raw] of Object.entries(snapshot.servers)) {
          const parsed = parseCachedServer(raw);
          if (parsed && !this.#servers.has(name)) {
            this.#servers.set(name, this.#toWorking(parsed, false));
          }
        }
        console.warn(
          "[pi-fabric] MCP config could not be parsed; serving last-known cached MCP tools.",
        );
      }
    }
    this.#scheduleNotify();
  }

  #toWorking(cached: CachedMcpServer, ephemeral: boolean): WorkingServer {
    return {
      definitionHash: cached.definitionHash,
      transport: cached.transport,
      description: cached.description,
      fetchedAt: cached.fetchedAt,
      stale: cached.stale,
      ephemeral,
      tools: cached.tools.map((tool) => ({ ...tool })),
    };
  }

  #kickRevalidation(forceAll = false): void {
    if (this.#closed || !this.#cacheOn) return;
    if (!forceAll && this.#autoKicked) return;
    this.#autoKicked = true;
    const policy = this.config.cache.revalidate;
    if (policy === "off" && !forceAll) return;
    const targets =
      forceAll || policy === "all"
        ? [...this.#servers.keys(), ...this.#pending.keys()]
        : [...this.#pending.keys()];
    this.#scheduleRevalidate(targets);
  }

  #scheduleRevalidate(servers: Iterable<string>): void {
    if (this.#closed || !this.#cacheOn) return;
    for (const server of servers) {
      if (this.#revalidateQueued.has(server)) continue;
      this.#revalidateQueued.add(server);
      this.#revalidateQueue.push(server);
    }
    if (this.#revalidating || this.#revalidateQueue.length === 0) return;
    this.#revalidating = this.#drainRevalidation()
      .catch(() => undefined)
      .finally(() => {
        this.#revalidating = undefined;
        // Budget-exhausted drains leave a tail: drain again with a fresh
        // budget until the queue is empty.
        if (this.#revalidateQueue.length > 0 && !this.#closed) this.#scheduleRevalidate([]);
      });
    void this.#revalidating;
  }

  async #drainRevalidation(): Promise<void> {
    const generation = this.#generation;
    const deadline = Date.now() + Math.max(1_000, this.config.cache.revalidateBudgetMs);
    const perServerTimeout = Math.max(
      MIN_REVALIDATE_SERVER_TIMEOUT_MS,
      Math.min(REVALIDATE_SERVER_TIMEOUT_MS, this.config.cache.revalidateBudgetMs),
    );
    while (!this.#closed && generation === this.#generation) {
      if (Date.now() > deadline) break;
      const batch: string[] = [];
      while (batch.length < REVALIDATE_CONCURRENCY && this.#revalidateQueue.length > 0) {
        const next = this.#revalidateQueue.shift();
        if (next === undefined) break;
        this.#revalidateQueued.delete(next);
        batch.push(next);
      }
      if (batch.length === 0) break;
      const results = await Promise.allSettled(
        batch.map((server) => this.#fetchServerTools(server, perServerTimeout)),
      );
      results.forEach((result, index) => {
        if (result.status !== "rejected") return;
        const server = batch[index];
        if (server === undefined) return;
        // Keep serving last-known tools under failure, marked stale.
        const existing = this.#servers.get(server);
        if (existing) {
          existing.stale = true;
          this.#schedulePersist();
          this.#scheduleNotify();
        }
      });
    }
  }

  // Live tool listing for exactly one server; on success updates the working
  // copy and persistence. Used by the background revalidator and by explicit
  // single-server fetches.
  async #fetchServerTools(server: string, timeoutMs?: number): Promise<WorkingServer> {
    const generation = this.#generation;
    const runtime = await this.#getRuntime();
    const listing = runtime.listTools(server, {
      includeSchema: true,
      disableOAuth: this.config.disableOAuth,
    });
    const tools =
      timeoutMs === undefined
        ? await listing
        : await withTimeout(listing, timeoutMs, () => {
            void runtime.close(server).catch(() => undefined);
          });
    if (generation !== this.#generation || this.#closed) {
      throw new Error(`MCP server listing superseded: ${server}`);
    }
    let definition: ServerDefinition;
    try {
      definition = runtime.getDefinition(server);
    } catch {
      this.#pending.delete(server);
      this.#servers.delete(server);
      this.#schedulePersist();
      this.#scheduleNotify();
      throw new Error(`Unknown MCP server: ${server}`);
    }
    const pending = this.#pending.get(server);
    const entry: WorkingServer = {
      definitionHash: hashServerDefinition(definition),
      transport: definition.command.kind,
      description: definition.description ?? null,
      fetchedAt: new Date().toISOString(),
      stale: false,
      ephemeral: pending?.ephemeral ?? false,
      tools,
    };
    this.#servers.set(server, entry);
    this.#pending.delete(server);
    this.#schedulePersist();
    this.#scheduleNotify();
    return entry;
  }

  // Resolve a requested (possibly sanitized) name to the raw server name
  // across the working copy, pending set, and — as a config-only fallback —
  // the runtime's definition list.
  async #resolveKnownServer(requested: string): Promise<string | undefined> {
    if (this.#servers.has(requested) || this.#pending.has(requested)) return requested;
    const known = [...this.#servers.keys(), ...this.#pending.keys()];
    const matches = known.filter((name) => sanitizeMcpRefPart(name) === requested);
    if (matches.length === 1) return matches[0];
    const runtime = await this.#getRuntime();
    const servers = runtime.listServers();
    if (servers.includes(requested)) return requested;
    const sanitized = servers.filter((name) => sanitizeMcpRefPart(name) === requested);
    return sanitized.length === 1 ? sanitized[0] : undefined;
  }

  #schedulePersist(): void {
    if (!this.#store || this.#closed) return;
    this.#dirtyPersist = true;
    if (this.#persistTimer) return;
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = undefined;
      void this.#persistNow().catch(() => undefined);
    }, PERSIST_DEBOUNCE_MS);
    this.#persistTimer.unref?.();
  }

  #persistNow(): Promise<void> {
    this.#dirtyPersist = false;
    if (!this.#store) return Promise.resolve();
    const servers: Record<string, CachedMcpServer> = {};
    for (const [name, entry] of this.#servers) {
      if (entry.ephemeral) continue;
      servers[name] = {
        definitionHash: entry.definitionHash,
        transport: entry.transport,
        description: entry.description,
        fetchedAt: entry.fetchedAt,
        stale: entry.stale,
        tools: entry.tools.map((tool) => {
          const annotations = (tool as { annotations?: FabricToolAnnotations }).annotations;
          return {
            name: tool.name,
            ...(tool.description !== undefined ? { description: tool.description } : {}),
            ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
            ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
            ...(annotations !== undefined ? { annotations: { ...annotations } } : {}),
          };
        }),
      };
    }
    return this.#store.save({
      version: MCP_DESCRIPTOR_CACHE_VERSION,
      layers: this.#layerStats,
      updatedAt: new Date().toISOString(),
      servers,
    });
  }

  #scheduleNotify(): void {
    if (this.#closed) return;
    this.#dirtyNotify = true;
    if (this.#notifyTimer) return;
    this.#notifyTimer = setTimeout(() => {
      this.#notifyTimer = undefined;
      this.#notifyNow();
    }, NOTIFY_DEBOUNCE_MS);
    this.#notifyTimer.unref?.();
  }

  #notifyNow(): void {
    if (!this.#dirtyNotify || this.#closed) return;
    this.#dirtyNotify = false;
    try {
      this.#hooks.onSliceChanged?.(this.sliceDescriptors());
    } catch {
      // Catalog notification must never break the provider.
    }
  }

  async #getToolRuntime(): Promise<ToolRuntime> {
    if (this.#closed) throw new Error("MCP provider is closed");
    return this.#source ?? this.#getRuntime();
  }

  async #getRuntime(): Promise<Runtime> {
    if (this.#source) throw new Error("Hosted MCP cannot construct an ambient runtime");
    if (this.#closed) throw new Error("MCP provider is closed");
    if (this.#runtime) return this.#runtime;
    const generation = this.#generation;
    if (this.#runtimeCreation?.generation === generation) {
      return this.#runtimeCreation.promise;
    }
    const promise = import("mcporter")
      .then(({ createRuntime }) => createRuntime({
        rootDir: this.cwd,
        ...(this.config.configPath ? { configPath: this.config.configPath } : {}),
        clientInfo: { name: "pi-fabric", version: "0.1.0" },
      }))
      .then(async (runtime) => {
        if (this.#closed || generation !== this.#generation) {
          await runtime.close().catch(() => undefined);
          throw new Error("MCP runtime creation was superseded");
        }
        this.#runtime = runtime;
        return runtime;
      });
    const creation = { generation, promise };
    this.#runtimeCreation = creation;
    void promise.finally(() => {
      if (this.#runtimeCreation === creation) this.#runtimeCreation = undefined;
    }).catch(() => undefined);
    return promise;
  }

  async #resetRuntime(): Promise<void> {
    this.#generation += 1;
    const runtime = this.#runtime;
    const creation = this.#runtimeCreation?.promise;
    this.#runtime = undefined;
    this.#runtimeCreation = undefined;
    this.#toolMetadata.clear();
    await Promise.allSettled([
      runtime?.close() ?? Promise.resolve(),
      creation?.then(() => undefined, () => undefined) ?? Promise.resolve(),
    ]);
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

  #resolveServerName(runtime: ToolRuntime, requested: string): string | undefined {
    const servers = runtime.listServers();
    if (servers.includes(requested)) return requested;
    const matches = servers.filter((server) => sanitizeMcpRefPart(server) === requested);
    return matches.length === 1 ? matches[0] : undefined;
  }

  #resolveTool(tools: ServerToolInfo[], requested: string): ServerToolInfo | undefined {
    const exact = tools.find((tool) => tool.name === requested);
    if (exact) return exact;
    const matches = tools.filter((tool) => sanitizeMcpRefPart(tool.name) === requested);
    return matches.length === 1 ? matches[0] : undefined;
  }

  #parseToolName(actionName: string): { server: string; tool: string } | undefined {
    const separator = actionName.indexOf(".");
    if (separator <= 0 || separator === actionName.length - 1) return undefined;
    return { server: actionName.slice(0, separator), tool: actionName.slice(separator + 1) };
  }

  #toolDescriptor(server: string, tool: ServerToolInfo): FabricActionDescriptor {
    // mcporter's ServerToolInfo does not declare annotations yet; read them
    // structurally so a runtime that surfaces them flows straight through.
    const annotations = (tool as { annotations?: FabricToolAnnotations }).annotations;
    return {
      name: `${server}.${tool.name}`,
      description: tool.description ?? `${tool.name} on MCP server ${server}`,
      inputSchema: normalizeSchema(tool.inputSchema),
      ...(tool.outputSchema ? { outputSchema: normalizeSchema(tool.outputSchema) } : {}),
      risk: "network",
      namespace: server,
      ...(annotations ? { annotations: { ...annotations } } : {}),
    };
  }

  // Live-everything path preserved for mcp.cache.enabled: false — the
  // pre-cache behavior with its 60s in-process metadata TTL.
  async #listLegacy(
    request: FabricProviderListRequest,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor[]> {
    const runtime = await this.#getToolRuntime();
    const selected = request.namespace ? this.#resolveServerName(runtime, request.namespace) : undefined;
    const servers = request.namespace ? (selected ? [selected] : []) : runtime.listServers();
    const settled = await Promise.allSettled(
      servers.map(async (server) => {
        const tools = await this.#listToolsLegacy(runtime, server);
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
    return request.namespace || this.#source ? filtered : [...managementDescriptors, ...filtered];
  }

  async #describeLegacy(
    actionName: string,
    _context: FabricInvocationContext,
  ): Promise<FabricActionDescriptor | undefined> {
    const parsed = this.#parseToolName(actionName);
    if (!parsed) return undefined;
    const runtime = await this.#getToolRuntime();
    const server = this.#resolveServerName(runtime, parsed.server);
    if (!server) return undefined;
    const tool = await this.#findToolLegacy(runtime, server, parsed.tool);
    return tool ? this.#toolDescriptor(server, tool) : undefined;
  }

  async #callLegacy(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) throw new Error("MCP call cancelled");
    const runtime = await this.#getToolRuntime();
    const server = this.#resolveServerName(runtime, serverName);
    if (!server) throw new Error(`Unknown MCP server: ${serverName}`);
    const tool = await this.#findToolLegacy(runtime, server, toolName);
    if (signal?.aborted) throw new Error("MCP call cancelled");
    if (!tool) throw new Error(`Unknown MCP tool: ${serverName}.${toolName}`);
    const operation = runtime.callTool(server, tool.name, {
      args,
      ...(this.#source && signal ? { signal } : {}),
      timeoutMs: this.config.callTimeoutMs,
      disableOAuth: this.config.disableOAuth,
    });
    try {
      const result = await this.#withAbort(operation, signal, () => runtime.close?.(server));
      return normalizeMcpResult(result);
    } catch (error) {
      this.#toolMetadata.delete(server);
      throw error;
    }
  }

  async #listToolsLegacy(
    runtime: ToolRuntime,
    server: string,
    refresh = false,
  ): Promise<ServerToolInfo[]> {
    if (this.#source) return this.#source.listTools(server);
    const cached = this.#toolMetadata.get(server);
    if (!refresh && cached && cached.expiresAt > Date.now()) return cached.promise;
    const promise = (runtime as Runtime).listTools(server, {
      includeSchema: true,
      disableOAuth: this.config.disableOAuth,
    });
    const entry = { expiresAt: Date.now() + TOOL_METADATA_TTL_MS, promise };
    this.#toolMetadata.set(server, entry);
    try {
      return await promise;
    } catch (error) {
      if (this.#toolMetadata.get(server) === entry) this.#toolMetadata.delete(server);
      throw error;
    }
  }

  async #findToolLegacy(
    runtime: ToolRuntime,
    server: string,
    requested: string,
  ): Promise<ServerToolInfo | undefined> {
    const cached = this.#resolveTool(await this.#listToolsLegacy(runtime, server), requested);
    if (cached) return cached;
    return this.#resolveTool(await this.#listToolsLegacy(runtime, server, true), requested);
  }
}
