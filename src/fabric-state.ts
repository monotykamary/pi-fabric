import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadFabricConfig, type FabricConfig } from "./config.js";
import { ActionRegistry } from "./core/action-registry.js";
import { FabricExecutionService } from "./execution-service.js";
import { AgentsProvider } from "./providers/agents-provider.js";
import { McpProvider } from "./providers/mcp-provider.js";
import { PiToolsProvider } from "./providers/pi-tools-provider.js";
import {
  FABRIC_PROVIDER_DISCOVER_EVENT,
  type FabricProvider,
  type FabricProviderDiscovery,
} from "./protocol.js";
import { SubagentManager } from "./subagents/manager.js";

const BACKGROUND_COMPLETION_MAX_CHARS = 8_000;

export class FabricState {
  #registry: ActionRegistry | undefined;
  #config: FabricConfig | undefined;
  #execution: FabricExecutionService | undefined;
  #subagents: SubagentManager | undefined;
  #cwd: string | undefined;
  readonly #externalProviders = new Map<string, FabricProvider>();

  constructor(readonly pi: ExtensionAPI) {}

  get initialized(): boolean {
    return Boolean(this.#execution);
  }

  get cwd(): string | undefined {
    return this.#cwd;
  }

  get config(): FabricConfig {
    if (!this.#config) throw new Error("Pi Fabric has not initialized");
    return this.#config;
  }

  get registry(): ActionRegistry {
    if (!this.#registry) throw new Error("Pi Fabric has not initialized");
    return this.#registry;
  }

  get execution(): FabricExecutionService {
    if (!this.#execution) throw new Error("Pi Fabric has not initialized");
    return this.#execution;
  }

  get subagents(): SubagentManager {
    if (!this.#subagents) throw new Error("Pi Fabric has not initialized");
    return this.#subagents;
  }

  async initialize(context: ExtensionContext): Promise<void> {
    await this.#closeInternal();
    this.#cwd = context.cwd;
    this.#config = loadFabricConfig({
      cwd: context.cwd,
      agentDir: getAgentDir(),
      projectTrusted: context.isProjectTrusted(),
    });
    this.#registry = new ActionRegistry();
    this.#registry.register(new PiToolsProvider(context.cwd));
    this.#registry.register(new McpProvider(context.cwd, this.#config.mcp));
    this.#subagents = new SubagentManager(context.cwd, this.#config.subagents, {
      onBackgroundComplete: (result) => {
        const durationMs = Math.max(0, (result.finishedAt ?? Date.now()) - result.startedAt);
        const duration = durationMs < 60_000
          ? `${Math.round(durationMs / 1_000)}s`
          : `${(durationMs / 60_000).toFixed(1)}m`;
        const summary = result.text || result.error || "no result";
        const clippedSummary = summary.length > BACKGROUND_COMPLETION_MAX_CHARS
          ? `${summary.slice(0, BACKGROUND_COMPLETION_MAX_CHARS)}\n[completion truncated]`
          : summary;
        this.pi.sendMessage(
          {
            customType: "pi-fabric-subagent-complete",
            content: `Fabric agent ${result.id.slice(0, 8)} ${result.status} after ${duration}: ${clippedSummary}`,
            display: true,
            details: result,
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      },
    });
    this.#registry.register(new AgentsProvider(this.#subagents));
    for (const provider of this.#externalProviders.values()) {
      this.#registry.register(provider);
    }
    this.#execution = new FabricExecutionService(this.#registry, this.#config);
    const discovery: FabricProviderDiscovery = {
      version: 1,
      register: (provider, options) => this.registerExternal(provider, options),
    };
    this.pi.events.emit(FABRIC_PROVIDER_DISCOVER_EVENT, discovery);
  }

  async ensure(context: ExtensionContext): Promise<void> {
    if (!this.initialized || this.#cwd !== context.cwd) await this.initialize(context);
  }

  registerExternal(provider: FabricProvider, options: { overwrite?: boolean } = {}): void {
    if (["pi", "mcp", "agents", "fabric"].includes(provider.name)) {
      throw new Error(`Reserved Fabric provider name: ${provider.name}`);
    }
    if (this.#externalProviders.has(provider.name) && !options.overwrite) {
      throw new Error(`Fabric provider already registered: ${provider.name}`);
    }
    this.#externalProviders.set(provider.name, provider);
    if (this.#registry) this.#registry.register(provider, options);
  }

  async shutdown(): Promise<void> {
    await this.#registry?.close();
    this.#registry = undefined;
    this.#config = undefined;
    this.#execution = undefined;
    this.#subagents = undefined;
    this.#cwd = undefined;
    this.#externalProviders.clear();
  }

  async #closeInternal(): Promise<void> {
    if (!this.#registry) return;
    const externalNames = new Set(this.#externalProviders.keys());
    await this.#registry.close(externalNames);
    this.#registry = undefined;
    this.#execution = undefined;
    this.#subagents = undefined;
  }
}
